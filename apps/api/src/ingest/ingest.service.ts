import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Company, IngestRunStatus, IngestRunSummary } from '@jobportal/shared';
import { randomUUID } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { FirecrawlService } from '../firecrawl/firecrawl.service';
import { AnalysisService } from '../analysis/analysis.service';
import { CompaniesService } from '../companies/companies.service';
import { SkillsService } from '../skills/skills.service';
import { CompanyResolverService } from '../discovery/company-resolver.service';
import { fetchAtsJobs } from '../discovery/ats-clients';
import { COMPANY_DISCOVERY_QUERIES } from '../discovery/discovery-queries';
import { INDIA_SEED_COMPANIES } from '../discovery/seed-companies';
import { canonicalizeUrl, companyNameFromHost, hostnameOf, isNonCompanyHost, urlHash } from '../common/url.util';
import { companyFromTitle, guessSeniority, looksLikeRelevantRole, normalizeWhitespace } from '../common/text.util';
import { isIndiaOrRemote } from '../common/location.util';
import { mapWithConcurrency } from '../common/async.util';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

interface InsertedJob {
  id: string;
  title: string;
  companyName: string | null;
  location: string | null;
  description: string;
}

/** A raw scrape result plus the company we already know it belongs to — set
 * during the scrape phase so insertion never needs to re-derive or guess it. */
interface CompanyScopedCandidate {
  candidate: RawJobCandidate;
  companyId: string;
  companyName: string;
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  /** Guards against overlapping runs for the same user — the manual "Refresh"
   * button, the batch cron trigger, and multiple browser tabs are all
   * independent entry points into `run()`, so the guard has to live here
   * rather than in any one caller. Concurrent runs would otherwise compete
   * for the same Firecrawl rate limit and duplicate discovery work. */
  private readonly runningUsers = new Set<string>();

  /** Latest run status per user, polled by the dashboard via `getStatus()`
   * so new jobs can surface as the run progresses instead of only once the
   * whole multi-minute pipeline finishes. In-memory only — fine for a
   * personal-tool single-instance deploy; a restart just means the next
   * poll sees 'idle' until a new run starts. */
  private readonly statusByUser = new Map<string, IngestRunStatus>();

  constructor(
    private readonly supabase: SupabaseService,
    private readonly firecrawl: FirecrawlService,
    private readonly analysis: AnalysisService,
    private readonly companies: CompaniesService,
    private readonly skills: SkillsService,
    private readonly resolver: CompanyResolverService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Fire-and-forget entry point for the "Refresh" button: starts `run()` in
   * the background and returns immediately instead of making the caller
   * await the full multi-minute pipeline. Progress is readable via
   * `getStatus()`, which the dashboard polls — jobs land in `job_postings`
   * company-by-company as the run proceeds, so `GET /api/jobs` already shows
   * them well before the run as a whole finishes.
   */
  /** How many recent activity lines to keep per user — a feed, not a log. */
  private static readonly ACTIVITY_LIMIT = 30;

  start(userId: string): IngestRunStatus {
    if (this.runningUsers.has(userId)) {
      throw new ConflictException('An ingestion run is already in progress for this user');
    }

    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    this.statusByUser.set(userId, {
      state: 'running',
      run_id: runId,
      started_at: startedAt,
      jobs_inserted_so_far: 0,
      summary: null,
      error: null,
      activity: ['Starting ingestion run…'],
    });

    void this.run(userId, runId).catch((error) => {
      const current = this.statusByUser.get(userId);
      this.statusByUser.set(userId, {
        state: 'error',
        run_id: runId,
        started_at: startedAt,
        jobs_inserted_so_far: current?.jobs_inserted_so_far ?? 0,
        summary: null,
        error: describeError(error),
        activity: [...(current?.activity ?? []), `Run failed: ${describeError(error)}`].slice(
          -IngestService.ACTIVITY_LIMIT,
        ),
      });
    });

    return this.statusByUser.get(userId)!;
  }

  getStatus(userId: string): IngestRunStatus {
    return (
      this.statusByUser.get(userId) ?? {
        state: 'idle',
        run_id: null,
        started_at: null,
        jobs_inserted_so_far: 0,
        summary: null,
        error: null,
        activity: [],
      }
    );
  }

  /** Appends one line to the user's live activity feed, trimmed to the cap. */
  private logActivity(userId: string, line: string): void {
    const current = this.statusByUser.get(userId);
    if (!current) return;
    const activity = [...current.activity, line].slice(-IngestService.ACTIVITY_LIMIT);
    this.statusByUser.set(userId, { ...current, activity });
  }

  /**
   * The actual pipeline, shared by `start()` and the cron scheduler. Two
   * phases: discover new companies by name (search is only ever used to
   * learn a name — never to source a job posting directly), then scrape
   * every company with a known-good careers page (pinned + auto-discovered
   * alike).
   */
  async run(userId: string, runId = randomUUID()): Promise<IngestRunSummary> {
    if (this.runningUsers.has(userId)) {
      throw new ConflictException('An ingestion run is already in progress for this user');
    }
    this.runningUsers.add(userId);

    try {
      const startedAt = new Date();
      const errors: string[] = [];

      this.logger.log(`[${runId}] Ingestion run starting for user ${userId}`);
      this.logActivity(userId, 'Discovering new companies…');

      const discovery = await this.discoverCompanies(userId, errors);
      this.logActivity(
        userId,
        `Discovery done — ${discovery.resolved} resolved, ${discovery.failed} failed`,
      );

      const { candidates, companiesScraped } = await this.scrapeResolvedCompanies(userId, errors);

      const maxNew = this.config.get<number>('ingest.maxNewJobsPerRun', 100);
      const { inserted, duplicates } = await this.dedupAndInsert(userId, candidates, maxNew);
      this.logActivity(
        userId,
        `Inserted ${inserted.length} new job(s), skipped ${duplicates} duplicate(s)`,
      );

      // Inserted rows are already visible to GET /api/jobs at this point —
      // publish the count now so a polling dashboard can show them before
      // analysis (the slowest remaining phase) finishes.
      this.updateStatus(userId, { jobs_inserted_so_far: inserted.length });

      const maxAnalyses = this.config.get<number>('ingest.maxAnalysesPerRun', 40);
      const concurrency = this.config.get<number>('ingest.analysisConcurrency', 1);
      const toAnalyze = inserted.slice(0, maxAnalyses);

      let analyzed = 0;
      if (this.analysis.isConfigured && toAnalyze.length > 0) {
        this.logActivity(userId, `Scoring ${toAnalyze.length} job(s) against your CV…`);
        await mapWithConcurrency(toAnalyze, concurrency, async (job) => {
          try {
            const ok = await this.analyzeAndPersist(userId, job);
            if (ok) {
              analyzed++;
              this.logActivity(userId, `Scored "${job.title}"${job.companyName ? ` at ${job.companyName}` : ''}`);
            }
          } catch (error) {
            errors.push(`Analysis failed for "${job.title}": ${describeError(error)}`);
          }
        });
      } else if (!this.analysis.isConfigured) {
        errors.push('GROQ_API_KEY not set — skill-gap scoring skipped');
      }

      const finishedAt = new Date();
      const summary: IngestRunSummary = {
        run_id: runId,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        queries_run: COMPANY_DISCOVERY_QUERIES.length,
        companies_discovered: discovery.discovered,
        companies_resolved: discovery.resolved,
        companies_failed: discovery.failed,
        companies_scraped: companiesScraped,
        candidates_found: candidates.length,
        duplicates_skipped: duplicates,
        jobs_inserted: inserted.length,
        jobs_analyzed: analyzed,
        errors,
      };

      this.logger.log(
        `[${runId}] Done in ${summary.duration_ms}ms — ${discovery.resolved} companies resolved ` +
          `(${discovery.failed} failed), ${companiesScraped} scraped, ${candidates.length} candidates, ` +
          `${inserted.length} new, ${duplicates} duplicates, ${analyzed} analyzed, ${errors.length} error(s)`,
      );

      this.logActivity(
        userId,
        `Done — ${inserted.length} new, ${duplicates} duplicates, ${analyzed} scored` +
          `${errors.length > 0 ? `, ${errors.length} warning(s)` : ''}`,
      );
      this.updateStatus(userId, { state: 'done', summary, jobs_inserted_so_far: inserted.length });
      return summary;
    } finally {
      this.runningUsers.delete(userId);
    }
  }

  private updateStatus(userId: string, patch: Partial<IngestRunStatus>): void {
    const current = this.statusByUser.get(userId);
    if (!current) return;
    this.statusByUser.set(userId, { ...current, ...patch });
  }

  // ---------------------------------------------------------------------
  // Phase 1: company discovery
  // ---------------------------------------------------------------------

  private async discoverCompanies(
    userId: string,
    errors: string[],
  ): Promise<{ discovered: number; resolved: number; failed: number }> {
    const known = await this.companies.getKnownNormalizedNames(userId);
    const candidateNames = new Map<string, string>(); // normalized -> display name

    // Seeded names first — real, known companies with a much higher
    // resolution hit rate than organic search, and most resolve via the free
    // ATS-slug-guess path, so this doesn't need Firecrawl to be configured.
    for (const name of INDIA_SEED_COMPANIES) {
      const normalized = name.toLowerCase();
      if (known.has(normalized) || candidateNames.has(normalized)) continue;
      candidateNames.set(normalized, name);
    }

    if (this.firecrawl.isConfigured) {
      for (const query of COMPANY_DISCOVERY_QUERIES) {
        try {
          const results = await this.firecrawl.searchForCompanyNames(query);
          for (const result of results) {
            const name = extractCompanyName(result);
            if (!name) continue;
            const normalized = name.toLowerCase();
            if (known.has(normalized) || candidateNames.has(normalized)) continue;
            candidateNames.set(normalized, name);
          }
        } catch (error) {
          errors.push(`Company discovery search failed for "${query}": ${describeError(error)}`);
        }
      }
    } else {
      errors.push('FIRECRAWL_API_KEY not set — organic company search skipped (seed companies still resolved)');
    }

    const maxNewCompanies = this.config.get<number>('ingest.maxNewCompaniesPerRun', 5);
    const toResolve = [...candidateNames.values()].slice(0, maxNewCompanies);

    let resolved = 0;
    let failed = 0;
    for (const name of toResolve) {
      try {
        const result = await this.resolver.resolve(name);
        await this.companies.recordDiscoveredCompany(userId, name, result);
        if (result.status === 'resolved') {
          resolved++;
          this.logActivity(userId, `Resolved "${name}" -> ${result.careersUrl ?? 'careers page found'}`);
        } else {
          failed++;
          this.logActivity(userId, `Could not resolve a careers page for "${name}"`);
        }
      } catch (error) {
        failed++;
        errors.push(`Resolution failed for "${name}": ${describeError(error)}`);
      }
    }

    return { discovered: toResolve.length, resolved, failed };
  }

  // ---------------------------------------------------------------------
  // Phase 2: scrape every company with a known-good careers page
  // ---------------------------------------------------------------------

  private async scrapeResolvedCompanies(
    userId: string,
    errors: string[],
  ): Promise<{ candidates: CompanyScopedCandidate[]; companiesScraped: number }> {
    const toScrape = await this.companies.listScrapable(userId);
    const candidates: CompanyScopedCandidate[] = [];
    let companiesScraped = 0;

    for (const company of toScrape) {
      this.logActivity(userId, `Scraping ${company.name}…`);
      try {
        const raw =
          company.ats_type && company.ats_board_token
            ? await this.scrapeAtsCompany(company)
            : await this.scrapeCustomCareerPage(company);

        for (const candidate of raw) {
          candidates.push({ candidate, companyId: company.id, companyName: company.name });
        }

        await this.companies.markScraped(company.id);
        companiesScraped++;
        this.logActivity(userId, `${company.name}: ${raw.length} candidate job(s) found`);
      } catch (error) {
        const msg = `Scrape failed for "${company.name}": ${describeError(error)}`;
        this.logger.warn(msg);
        errors.push(msg);
        this.logActivity(userId, `${company.name}: scrape failed`);
      }
    }

    return { candidates, companiesScraped };
  }

  private async scrapeAtsCompany(company: Company): Promise<RawJobCandidate[]> {
    const listings = await fetchAtsJobs(company.ats_type!, company.ats_board_token!);

    // No freshness filter here, deliberately: an ATS board only ever lists
    // currently-open reqs (Greenhouse/Lever/Ashby drop filled/closed postings
    // from this endpoint), so every listing is "fresh" by construction. The
    // per-listing `postedDateIso` we do have (e.g. Greenhouse's `updated_at`)
    // reflects when the listing was last edited, not how long it's been
    // open — a real, currently-hiring role that hasn't needed an edit in two
    // weeks would fail a "posted in the last N days" check even though it's
    // exactly the kind of live opening this app exists to surface.
    return listings
      .filter((listing) => looksLikeRelevantRole(listing.title, listing.department))
      .filter((listing) => isIndiaOrRemote(listing.location))
      .map(
        (listing): RawJobCandidate => ({
          title: listing.title,
          url: listing.url,
          companyNameHint: company.name,
          locationHint: listing.location,
          snippet: (listing.description ?? '').slice(0, 2000),
          markdown: listing.description,
          source: 'ats_api',
          postedDateIso: listing.postedDateIso,
        }),
      );
  }

  private async scrapeCustomCareerPage(company: Company): Promise<RawJobCandidate[]> {
    if (!company.careers_url) return [];
    const raw = await this.firecrawl.discoverCompanyJobs(company.careers_url);
    // discoverCompanyJobs already filters "is this a posting at all" and
    // freshness; relevance and location are this app's own gate on top.
    return raw.filter((c) => looksLikeRelevantRole(c.title) && isIndiaOrRemote(c.locationHint));
  }

  // ---------------------------------------------------------------------
  // Dedup + insert
  // ---------------------------------------------------------------------

  private async dedupAndInsert(
    userId: string,
    scoped: CompanyScopedCandidate[],
    maxNew: number,
  ): Promise<{ inserted: InsertedJob[]; duplicates: number }> {
    if (scoped.length === 0) return { inserted: [], duplicates: 0 };

    // Collapse candidates that resolve to the same URL within this run itself.
    const byHash = new Map<string, CompanyScopedCandidate>();
    for (const item of scoped) {
      const hash = urlHash(item.candidate.url);
      if (!byHash.has(hash)) byHash.set(hash, item);
    }

    const hashes = [...byHash.keys()];
    const existingResult = await this.supabase.admin
      .from('job_postings')
      .select('url_hash')
      .eq('user_id', userId)
      .in('url_hash', hashes);
    const existing = this.supabase.unwrap(existingResult, 'check existing postings') as Array<{
      url_hash: string;
    }>;
    const existingHashes = new Set(existing.map((row) => row.url_hash));

    const fresh = [...byHash.entries()]
      .filter(([hash]) => !existingHashes.has(hash))
      .slice(0, maxNew);

    const inserted: InsertedJob[] = [];
    for (const [hash, item] of fresh) {
      const row = await this.insertOne(userId, hash, item);
      if (row) inserted.push(row);
    }

    return { inserted, duplicates: byHash.size - fresh.length };
  }

  private async insertOne(
    userId: string,
    hash: string,
    item: CompanyScopedCandidate,
  ): Promise<InsertedJob | null> {
    const { candidate, companyId, companyName } = item;
    const description = normalizeWhitespace(candidate.markdown ?? candidate.snippet ?? '');

    const result = await this.supabase.admin
      .from('job_postings')
      .upsert(
        {
          user_id: userId,
          company_id: companyId,
          title: candidate.title,
          company_name: companyName,
          location: candidate.locationHint,
          url: canonicalizeUrl(candidate.url),
          url_hash: hash,
          description_raw: description || null,
          seniority_guess: guessSeniority(candidate.title, description),
          posted_date: candidate.postedDateIso,
          source: candidate.source,
          status: 'new',
        },
        // If the title/company also collide with an existing row (job re-listed
        // under a new URL), this upsert quietly no-ops instead of erroring —
        // onConflict only covers the url_hash key; the title/company unique
        // index still protects against duplicate rows, surfaced as a 23505
        // we swallow below.
        { onConflict: 'user_id,url_hash' },
      )
      .select('id')
      .maybeSingle();

    if (result.error) {
      // 23505 = unique_violation, almost certainly the (company, title) index.
      if ((result.error as { code?: string }).code === '23505') return null;
      this.logger.warn(`Insert failed for "${candidate.title}": ${result.error.message}`);
      return null;
    }
    if (!result.data) return null;

    return {
      id: result.data.id as string,
      title: candidate.title,
      companyName,
      location: candidate.locationHint,
      description,
    };
  }

  // ---------------------------------------------------------------------
  // Analysis persistence
  // ---------------------------------------------------------------------

  private async analyzeAndPersist(userId: string, job: InsertedJob): Promise<boolean> {
    if (!job.description || job.description.trim().length < 40) return false;

    const result = await this.analysis.analyze(userId, {
      title: job.title,
      companyName: job.companyName,
      location: job.location,
      description: job.description,
    });
    if (!result) return false;

    const { error: analysisError } = await this.supabase.admin.from('skill_gap_analysis').upsert(
      {
        job_posting_id: job.id,
        match_score: result.match_score,
        matched_skills: result.matched_skills,
        missing_skills: result.missing_skills,
        summary_text: result.summary_text,
        model: this.config.get<string>('groq.model'),
        analyzed_at: new Date().toISOString(),
      },
      { onConflict: 'job_posting_id' },
    );
    if (analysisError) {
      this.logger.warn(`Could not save analysis for job ${job.id}: ${analysisError.message}`);
    }

    if (result.seniority_guess !== 'unknown') {
      await this.supabase.admin
        .from('job_postings')
        .update({ seniority_guess: result.seniority_guess })
        .eq('id', job.id);
    }

    await this.persistJobSkills(job.id, result.required_skills);
    return true;
  }

  private async persistJobSkills(
    jobId: string,
    requiredSkills: Array<{ name: string; required: boolean }>,
  ): Promise<void> {
    if (requiredSkills.length === 0) return;

    const skillIds = await this.skills.ensure(requiredSkills.map((s) => s.name));
    const rows = requiredSkills
      .map((s) => {
        const id = skillIds.get(s.name);
        return id ? { job_posting_id: jobId, skill_id: id, required: s.required } : null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (rows.length === 0) return;
    const { error } = await this.supabase.admin
      .from('job_skills')
      .upsert(rows, { onConflict: 'job_posting_id,skill_id' });
    if (error) this.logger.warn(`Could not save job skills for ${jobId}: ${error.message}`);
  }
}

/** Phrases a real company name never consists of — the tell-tale sign
 * `companyFromTitle` grabbed a fragment of natural-language search-result
 * copy ("50 Y Combinator startups hiring...", "1130+ open roles") rather
 * than an actual proper noun. */
const GENERIC_NAME_MARKERS = [
  'startup', 'startups', 'jobs', 'job', 'hiring', 'roles', 'role',
  'positions', 'position', 'openings', 'opening', 'opportunities',
  'opportunity', 'remote', 'reputed', 'company', 'companies', 'now',
  'open', 'exciting', 'developer', 'developers', 'engineer', 'engineers',
  'career', 'careers', 'apply', 'top', 'best', 'new', 'all', 'genders',
];

function looksLikeRealCompanyName(candidate: string): boolean {
  if (/^\d+$/.test(candidate)) return false; // bare year/number ("2026")
  if (!/^[A-Z]/.test(candidate)) return false; // proper nouns start capitalised
  const words = candidate.split(/\s+/);
  if (words.length > 4) return false; // real company names are rarely longer
  const lower = candidate.toLowerCase();
  if (GENERIC_NAME_MARKERS.some((marker) => new RegExp(`\\b${marker}\\b`).test(lower))) return false;
  return true;
}

/**
 * Company name from a discovery search hit. Hostname-derived first — it's
 * tied to an actual registered domain, so it's inherently more trustworthy
 * than parsing natural-language search-result copy. Title parsing is only a
 * fallback, and its output is validated against `looksLikeRealCompanyName`
 * before use — `companyFromTitle` was built for structured job-posting
 * titles ("Role - Acme Corp | Greenhouse"); discovery search results are
 * generic web copy ("50 Y Combinator startups hiring backend engineers"),
 * and unvalidated it happily grabs "Y Combinator startups" as a "name".
 */
function extractCompanyName(result: { title: string; url: string; description: string }): string | null {
  const host = hostnameOf(result.url);
  if (isNonCompanyHost(host)) return null;

  const fromHost = companyNameFromHost(host);
  if (fromHost) return fromHost;

  const fromTitle = companyFromTitle(result.title);
  return fromTitle && looksLikeRealCompanyName(fromTitle) ? fromTitle : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
