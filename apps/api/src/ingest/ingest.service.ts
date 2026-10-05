import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Company, CvProfile, IngestRunStatus, IngestRunSummary } from '@jobportal/shared';
import { randomUUID } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { FirecrawlService } from '../firecrawl/firecrawl.service';
import { AnalysisService } from '../analysis/analysis.service';
import { CompaniesService } from '../companies/companies.service';
import { SkillsService } from '../skills/skills.service';
import { CompanyResolverService } from '../discovery/company-resolver.service';
import { CvService } from '../cv/cv.service';
import { fetchAtsJobs } from '../discovery/ats-clients';
import { COMPANY_DISCOVERY_QUERIES } from '../discovery/discovery-queries';
import { INDIA_SEED_COMPANIES } from '../discovery/seed-companies';
import { canonicalizeUrl, companyNameFromHost, hostnameOf, isNonCompanyHost } from '../common/url.util';
import { companyFromTitle, guessSeniority } from '../common/text.util';
import { ageInDays } from '../common/date.util';
import { mapWithConcurrency } from '../common/async.util';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';
import type { AtsJobListing } from '../discovery/ats-clients';
import { scrapeCareerPage } from '../scraping/career-page-scraper';
import { evaluateEligibility } from '../pipeline/eligibility';
import { normalizeCandidate, type ScopedCandidate } from '../pipeline/normalize';
import {
  scoreRetrieval,
  freshnessPoints,
  RETRIEVAL_WEIGHTS,
  type RetrievalSignals,
  type ScoringContext,
} from '../pipeline/retrieval-score';
import { evaluateCandidates, type ScoredJob } from '../pipeline/evaluate';
import { selectTopN } from '../pipeline/select';
import { combineLlmFit, combineFinalScore, scorePreference } from '../pipeline/ranking';

export interface InsertedJob {
  id: string;
  title: string;
  companyName: string | null;
  location: string | null;
  description: string;
  retrievalScore: number;
  postedDateIso: string | null;
}

const ANALYSIS_POOL_QUERY_LIMIT = 200;
/** Unscored (pre-0008) backlog rows scored per run before the ranked query. */
const SCORE_BACKFILL_QUERY_LIMIT = 500;
/** url_hash values per `in.(…)` filter — 100 md5 hashes keep the request URL
 * a few KB, well under the API gateway's limit. */
const EXISTING_HASH_CHUNK_SIZE = 100;
const BACKLOG_COLUMNS =
  'id, company_id, title, company_name, location, url, description_raw, posted_date, source, retrieval_score';
/** Same bar analyzeAndPersist() already applies before calling Groq. */
const MIN_ANALYZABLE_DESCRIPTION = 40;

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
    private readonly cv: CvService,
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

      const { profile, skills } = await this.cv.getSnapshot(userId);
      const emptyProfileWarning = describeEmptyProfileWarning(profile);
      if (emptyProfileWarning) {
        this.logger.warn(`[${runId}] ${emptyProfileWarning}`);
        errors.push(emptyProfileWarning);
      }
      const scoringContext: ScoringContext = {
        profile,
        cvSkillNames: skills.map((skill) => skill.name),
        now: startedAt,
      };

      const discovery = await this.discoverCompanies(userId, errors, profile);
      this.logActivity(
        userId,
        `Discovery done — ${discovery.resolved} resolved, ${discovery.failed} failed`,
      );

      const { candidates, companiesScraped } = await this.scrapeResolvedCompanies(userId, errors, profile);

      const floor = this.config.get<number>('ingest.retrievalFloor', 40);
      const evaluation = evaluateCandidates(candidates, scoringContext, floor);
      this.logActivity(
        userId,
        `Evaluated ${candidates.length} candidate(s): ${evaluation.eligibleCount} eligible, ` +
          `${evaluation.belowFloorCount} below the score floor, ${evaluation.accepted.length} kept`,
      );

      const maxNew = this.config.get<number>('ingest.maxNewJobsPerRun', 100);
      const { inserted, duplicates } = await this.dedupAndInsert(userId, evaluation.accepted, maxNew, errors);
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
      const { toAnalyze, poolSize } = await this.buildAnalysisPool(userId, scoringContext, maxAnalyses);

      let analyzed = 0;
      if (this.analysis.isConfigured && toAnalyze.length > 0) {
        this.logActivity(userId, `Scoring the top ${toAnalyze.length} of ${poolSize} unanalyzed job(s) against your CV…`);
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
        candidates_eligible: evaluation.eligibleCount,
        candidates_below_floor: evaluation.belowFloorCount,
        rejection_reasons: evaluation.rejectionReasons,
        analysis_pool_size: poolSize,
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
    profile: CvProfile,
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
    const toResolve = [...candidateNames.values()]
      .filter((name) => !isExcludedCompany(name, profile.excluded_companies))
      .slice(0, maxNewCompanies);

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
    profile: CvProfile,
  ): Promise<{ candidates: ScopedCandidate[]; companiesScraped: number }> {
    const scrapable = await this.companies.listScrapable(userId);
    const toScrape = filterOutExcludedCompanies(scrapable, profile.excluded_companies);
    const candidates: ScopedCandidate[] = [];
    let companiesScraped = 0;

    for (const company of toScrape) {
      this.logActivity(userId, `Scraping ${company.name}…`);
      try {
        const raw =
          company.ats_type && company.ats_board_token
            ? await this.scrapeAtsCompany(company)
            : await this.scrapeCustomCareerPage(company, profile);

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
    // per-listing `postedDateIso` reflects when the listing was last edited,
    // not how long it's been open.
    //
    // No relevance/location filter either: eligibility is applied once,
    // uniformly, in run() via evaluateCandidates().
    return listings.map((listing) => atsListingToCandidate(listing, company.name));
  }

  private async scrapeCustomCareerPage(company: Company, profile: CvProfile): Promise<RawJobCandidate[]> {
    if (!company.careers_url) return [];

    const local = await scrapeCareerPage(company.careers_url, {
      timeoutMs: this.config.get<number>('scraping.httpTimeoutMs', 30_000),
      maxLinks: this.config.get<number>('scraping.maxLinksPerCompany', 15),
      concurrency: this.config.get<number>('scraping.concurrency', 5),
    });

    // Freshness: discoverCompanyJobs (Firecrawl path, below) already rejects
    // postings older than maxPostingAgeDays. The local scraper doesn't get
    // that for free, so it's applied explicitly here.
    const fresh = filterStalePostings(local, this.config.get<number>('ingest.maxPostingAgeDays', 2));

    // Fall back to Firecrawl unless at least one local result is CREDIBLE —
    // passes the same eligibility check run() applies to everything. The
    // local extractors can turn a careers page's own nav ("Life at Acme")
    // into a non-empty candidate; eligibility's non_engineering_title check
    // rejects those, so they never block the fallback.
    const credible = fresh.filter(
      (candidate) =>
        evaluateEligibility(normalizeCandidate({ candidate, companyId: company.id, companyName: company.name }), profile)
          .eligible,
    );

    if (shouldFallBackToFirecrawl(credible)) {
      return this.firecrawl.discoverCompanyJobs(company.careers_url);
    }
    return fresh;
  }

  // ---------------------------------------------------------------------
  // Dedup + insert
  // ---------------------------------------------------------------------

  private async dedupAndInsert(
    userId: string,
    scored: ScoredJob[],
    maxNew: number,
    errors: string[],
  ): Promise<{ inserted: InsertedJob[]; duplicates: number }> {
    if (scored.length === 0) return { inserted: [], duplicates: 0 };

    // `scored` arrives best-first, so keeping the first occurrence keeps the
    // highest-scoring copy, and the maxNew cap keeps the highest-scoring jobs.
    const unique = dedupWithinRun(scored);

    const existingHashes = await this.findExistingHashes(
      userId,
      unique.map((item) => item.job.urlHash),
    );

    const notInDb = unique.filter((item) => !existingHashes.has(item.job.urlHash));
    const toInsert = notInDb.slice(0, maxNew);

    const inserted: InsertedJob[] = [];
    for (const item of toInsert) {
      const row = await this.insertOne(userId, item, errors);
      if (row) inserted.push(row);
    }

    // Duplicates = repeats within this run + jobs already saved. Jobs past
    // the maxNew cap are not duplicates; they are reconsidered next run.
    return { inserted, duplicates: scored.length - notInDb.length };
  }

  /** Chunked so a big run's `in.(…)` filter never outgrows the request URL. */
  private async findExistingHashes(userId: string, hashes: string[]): Promise<Set<string>> {
    const existing = new Set<string>();
    for (let i = 0; i < hashes.length; i += EXISTING_HASH_CHUNK_SIZE) {
      const result = await this.supabase.admin
        .from('job_postings')
        .select('url_hash')
        .eq('user_id', userId)
        .in('url_hash', hashes.slice(i, i + EXISTING_HASH_CHUNK_SIZE));
      const rows = this.supabase.unwrap(result, 'check existing postings') as Array<{ url_hash: string }>;
      for (const row of rows) existing.add(row.url_hash);
    }
    return existing;
  }

  private async insertOne(userId: string, item: ScoredJob, errors: string[]): Promise<InsertedJob | null> {
    const { job, score, signals } = item;

    const result = await this.supabase.admin
      .from('job_postings')
      .upsert(
        {
          user_id: userId,
          company_id: job.companyId,
          title: job.title,
          company_name: job.companyName,
          location: job.location,
          url: canonicalizeUrl(job.candidate.url),
          url_hash: job.urlHash,
          description_raw: job.description || null,
          seniority_guess: guessSeniority(job.title, job.description),
          posted_date: job.candidate.postedDateIso,
          source: job.candidate.source,
          status: 'new',
          external_id: job.externalId,
          retrieval_score: score,
          retrieval_signals: signals,
        },
        // onConflict covers the url_hash key only. A collision on the
        // (company, title, location) or (company, external_id) unique index
        // surfaces as a 23505, swallowed below as a benign duplicate.
        { onConflict: 'user_id,url_hash' },
      )
      .select('id')
      .maybeSingle();

    if (result.error) {
      if ((result.error as { code?: string }).code === '23505') return null;
      const message = describeInsertError(job.title, result.error);
      this.logger.warn(message);
      // Any OTHER DB error (e.g. a migration not yet applied to the live
      // database) would otherwise fail silently from the user's point of
      // view. Push it into the run's errors[] too.
      errors.push(message);
      return null;
    }
    if (!result.data) return null;

    return {
      id: result.data.id as string,
      title: job.title,
      companyName: job.companyName,
      location: job.location,
      description: job.description,
      retrievalScore: score,
      postedDateIso: job.candidate.postedDateIso,
    };
  }

  /**
   * Groq's Top-N comes from every saved-but-unanalyzed job in the backlog
   * window — this run's inserts included — ranked by retrieval score. Rows
   * saved before migration 0008 have no score; they are scored from their
   * stored fields and written back first, so the ranked query sees them
   * instead of sorting them behind 200 scored rows forever.
   */
  private async buildAnalysisPool(
    userId: string,
    ctx: ScoringContext,
    limit: number,
  ): Promise<{ toAnalyze: InsertedJob[]; poolSize: number }> {
    const backlogDays = this.config.get<number>('ingest.analysisBacklogDays', 30);
    const since = new Date(ctx.now.getTime() - backlogDays * 24 * 60 * 60 * 1000).toISOString();

    const unscoredResult = await this.supabase.admin
      .from('job_postings_enriched')
      .select(BACKLOG_COLUMNS)
      .eq('user_id', userId)
      .is('match_score', null)
      .eq('status', 'new')
      .gte('scraped_at', since)
      .is('retrieval_score', null)
      .limit(SCORE_BACKFILL_QUERY_LIMIT);
    const unscored = this.supabase.unwrap(unscoredResult, 'load unscored backlog') as BacklogRow[];
    await this.storeRetrievalScores(toAnalysisCandidates(unscored, ctx).rescored);

    const result = await this.supabase.admin
      .from('job_postings_enriched')
      .select(BACKLOG_COLUMNS)
      .eq('user_id', userId)
      .is('match_score', null)
      .eq('status', 'new')
      .gte('scraped_at', since)
      .order('retrieval_score', { ascending: false, nullsFirst: false })
      .limit(ANALYSIS_POOL_QUERY_LIMIT);
    const rows = this.supabase.unwrap(result, 'load analysis backlog') as BacklogRow[];

    // Any row still unscored here had its write-back fail; it is scored in
    // memory again so it still competes this run.
    const { candidates, rescored } = toAnalysisCandidates(rows, ctx);
    await this.storeRetrievalScores(rescored);

    // analyzeAndPersist() skips descriptions under 40 chars; leaving them in
    // the pool would let a high-scoring but unanalyzable job hold a Groq slot
    // every run without ever being analyzed.
    const analyzable = candidates.filter((c) => c.job.description.trim().length >= MIN_ANALYZABLE_DESCRIPTION);
    const top = selectTopN(analyzable, limit, (c) => ({
      score: c.score,
      postedDateIso: c.postedDateIso,
      title: c.job.title,
    }));
    return { toAnalyze: top.map((c) => c.job), poolSize: rows.length };
  }

  private async storeRetrievalScores(
    updates: ReadonlyArray<{ id: string; score: number; signals: RetrievalSignals }>,
  ): Promise<void> {
    for (const update of updates) {
      const { error } = await this.supabase.admin
        .from('job_postings')
        .update({ retrieval_score: update.score, retrieval_signals: update.signals })
        .eq('id', update.id);
      if (error) this.logger.warn(`Could not store retrieval score for job ${update.id}: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------------
  // Analysis persistence
  // ---------------------------------------------------------------------

  private async analyzeAndPersist(userId: string, job: InsertedJob): Promise<boolean> {
    if (!job.description || job.description.trim().length < MIN_ANALYZABLE_DESCRIPTION) return false;

    const evaluation = await this.analysis.analyze(userId, {
      title: job.title,
      companyName: job.companyName,
      location: job.location,
      description: job.description,
    });
    if (!evaluation) return false;

    const { profile } = await this.cv.getSnapshot(userId);
    const normalizedJob = normalizeCandidate({
      candidate: {
        title: job.title,
        url: '',
        companyNameHint: job.companyName,
        locationHint: job.location,
        snippet: '',
        markdown: job.description,
        source: 'http_scrape',
        postedDateIso: null,
      },
      companyId: '',
      companyName: job.companyName ?? '',
    });

    const llmScore = combineLlmFit(evaluation);
    const preferenceScore = scorePreference(normalizedJob, {
      workModes: profile.work_modes,
      domainPreferences: profile.domain_preferences,
    });
    const freshnessScore = freshnessPoints(job.postedDateIso, new Date()) * (100 / RETRIEVAL_WEIGHTS.freshness);
    const weights = {
      retrieval: this.config.get<number>('ranking.weightRetrieval', 35),
      llm: this.config.get<number>('ranking.weightLlm', 45),
      freshness: this.config.get<number>('ranking.weightFreshness', 10),
      preference: this.config.get<number>('ranking.weightPreference', 10),
    };
    const { finalScore, recommendation } = combineFinalScore(
      { retrievalScore: job.retrievalScore, llmScore, freshnessScore, preferenceScore },
      weights,
    );

    const { error: analysisError } = await this.supabase.admin.from('skill_gap_analysis').upsert(
      {
        job_posting_id: job.id,
        match_score: llmScore,
        llm_score: llmScore,
        confidence: evaluation.confidence,
        critical_mismatch: evaluation.criticalMismatch,
        critical_gaps: evaluation.criticalGaps,
        role_fit: evaluation.roleFit,
        seniority_fit: evaluation.seniorityFit,
        required_skill_fit: evaluation.requiredSkillFit,
        preferred_skill_fit: evaluation.preferredSkillFit,
        experience_fit: evaluation.experienceFit,
        domain_fit: evaluation.domainFit,
        matched_skills: evaluation.matchedSkills,
        missing_skills: evaluation.missingSkills,
        summary_text: evaluation.summary,
        model: this.config.get<string>('groq.model'),
        analyzed_at: new Date().toISOString(),
      },
      { onConflict: 'job_posting_id' },
    );
    if (analysisError) {
      this.logger.warn(`Could not save analysis for job ${job.id}: ${analysisError.message}`);
    }

    const { error: postingError } = await this.supabase.admin
      .from('job_postings')
      .update({ final_score: finalScore, recommendation, preference_score: preferenceScore })
      .eq('id', job.id);
    if (postingError) {
      this.logger.warn(`Could not save final score for job ${job.id}: ${postingError.message}`);
    }

    await this.persistJobSkills(job.id, dedupeRequiredSkills(evaluation.requiredSkills));
    return true;
  }

  // dedupeRequiredSkills lives at module scope (see bottom of file) so it's
  // directly unit-testable without the IngestService dependency graph.

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

/** Human-readable message for a non-23505 insertOne() DB error, surfaced in
 * the run's errors[] array so it isn't silently swallowed (e.g. a CHECK
 * constraint rejecting an 'http_scrape' source before its migration has
 * been applied). Pulled out as its own function so the message format is
 * directly unit-testable. */
export function describeInsertError(title: string, error: { message: string; code?: string }): string {
  return `Insert failed for "${title}": ${error.message}`;
}

/** Collapses a required-skills list to one row per skill name before the
 * job_skills upsert. Groq occasionally lists the same slug twice (e.g. two
 * spellings that normalize to one canonical name) — a duplicate
 * `(job_posting_id, skill_id)` pair in one upsert batch makes Postgres
 * reject the WHOLE statement ("ON CONFLICT DO UPDATE command cannot affect
 * row a second time"), silently dropping every job_skills row for that job.
 * On a conflict, `required: true` wins — a skill flagged required by any
 * mention is treated as required. */
export function dedupeRequiredSkills(
  requiredSkills: ReadonlyArray<{ name: string; required: boolean }>,
): Array<{ name: string; required: boolean }> {
  const byName = new Map<string, boolean>();
  for (const skill of requiredSkills) {
    byName.set(skill.name, (byName.get(skill.name) ?? false) || skill.required);
  }
  return [...byName.entries()].map(([name, required]) => ({ name, required }));
}

/**
 * Zero CREDIBLE local candidates — none passes evaluateEligibility() — is
 * the trigger to fall back to Firecrawl. Pulled out as its own function so
 * the decision is unit-testable without the IngestService dependency graph.
 */
export function shouldFallBackToFirecrawl(filteredLocalCandidates: RawJobCandidate[]): boolean {
  return filteredLocalCandidates.length === 0;
}

/**
 * Drops any candidate whose `postedDateIso` is parseable and older than
 * `maxAgeDays` — mirrors the freshness bar `FirecrawlService.scrapePage()`
 * already applies (see firecrawl.service.ts's `isTooOld`), which the local
 * scraper path did not have until this function existed. A null/unparseable
 * date is KEPT, not rejected — same policy as the Firecrawl path: "unknown"
 * isn't evidence of staleness.
 */
export function filterStalePostings(candidates: RawJobCandidate[], maxAgeDays: number): RawJobCandidate[] {
  return candidates.filter((c) => {
    if (!c.postedDateIso) return true;
    const parsed = new Date(c.postedDateIso);
    if (Number.isNaN(parsed.getTime())) return true;
    return ageInDays(parsed) <= maxAgeDays;
  });
}

/** Case-insensitive exact-name match against the candidate's excluded-companies list. */
export function isExcludedCompany(name: string, excludedCompanies: readonly string[]): boolean {
  const normalized = name.trim().toLowerCase();
  return excludedCompanies.some((excluded) => excluded.trim().toLowerCase() === normalized);
}

/**
 * Drops any company (newly discovered OR already resolved/known) matching the
 * candidate's excluded-companies list. Applied both before resolution
 * (discoverCompanies) and before scraping (scrapeResolvedCompanies) — an
 * exclusion added after a company was already resolved on an earlier run
 * must still stop future scrapes, not just block it from being discovered
 * again (a company is usually excluded *because* its jobs keep showing up,
 * which means it's already resolved by the time the user excludes it).
 */
export function filterOutExcludedCompanies<T extends { name: string }>(
  companies: readonly T[],
  excludedCompanies: readonly string[],
): T[] {
  return companies.filter((company) => !isExcludedCompany(company.name, excludedCompanies));
}

/**
 * An empty `target_roles` or `preferred_locations` list narrows eligibility
 * sharply and silently. It is a real reachable state (e.g. a profile migrated
 * before this feature existed, never backfilled by design — see
 * 0005_candidate_preferences.sql). Surfacing it as a run error means a
 * near-empty run is explained instead of looking like a quiet, successful no-op.
 */
export function describeEmptyProfileWarning(profile: {
  target_roles: readonly string[];
  preferred_locations: readonly string[];
}): string | null {
  const consequences: string[] = [];
  if (profile.target_roles.length === 0) {
    consequences.push('target_roles is empty, so only generic engineering titles (engineer/developer/SDE) pass eligibility');
  }
  if (profile.preferred_locations.length === 0) {
    consequences.push('preferred_locations is empty, so only jobs that state no location pass eligibility');
  }
  if (consequences.length === 0) return null;

  return `Profile warning: ${consequences.join('; ')}. PATCH /cv to set them (see db/migrations/0005_candidate_preferences.sql).`;
}

/** ATS listing -> scraped candidate. Eligibility is applied later, in run(). */
export function atsListingToCandidate(listing: AtsJobListing, companyName: string): RawJobCandidate {
  return {
    title: listing.title,
    url: listing.url,
    companyNameHint: companyName,
    locationHint: listing.location,
    snippet: (listing.description ?? '').slice(0, 2000),
    markdown: listing.description,
    source: 'ats_api',
    postedDateIso: listing.postedDateIso,
    externalId: listing.externalId,
    department: listing.department,
  };
}

/** Keeps the first occurrence by URL hash and by company + ATS id. Callers
 * pass best-first input, so the first occurrence is the best-scoring one. */
export function dedupWithinRun(scored: readonly ScoredJob[]): ScoredJob[] {
  const seenHashes = new Set<string>();
  const seenExternal = new Set<string>();
  const kept: ScoredJob[] = [];
  for (const item of scored) {
    const externalKey = item.job.externalId ? `${item.job.companyId}:${item.job.externalId}` : null;
    if (seenHashes.has(item.job.urlHash)) continue;
    if (externalKey && seenExternal.has(externalKey)) continue;
    seenHashes.add(item.job.urlHash);
    if (externalKey) seenExternal.add(externalKey);
    kept.push(item);
  }
  return kept;
}

/** A saved, not-yet-analyzed job as read from job_postings_enriched. */
export interface BacklogRow {
  id: string;
  company_id: string | null;
  title: string;
  company_name: string | null;
  location: string | null;
  url: string;
  description_raw: string | null;
  posted_date: string | null;
  source: string;
  retrieval_score: number | null;
}

export interface AnalysisCandidate {
  job: InsertedJob;
  score: number;
  postedDateIso: string | null;
}

/** Backlog rows -> analysis candidates, scoring rows that predate the
 * retrieval score from their stored fields. */
export function toAnalysisCandidates(
  rows: readonly BacklogRow[],
  ctx: ScoringContext,
): { candidates: AnalysisCandidate[]; rescored: Array<{ id: string; score: number; signals: RetrievalSignals }> } {
  const candidates: AnalysisCandidate[] = [];
  const rescored: Array<{ id: string; score: number; signals: RetrievalSignals }> = [];

  for (const row of rows) {
    let score = row.retrieval_score;
    if (score === null || score === undefined) {
      const normalized = normalizeCandidate({
        candidate: {
          title: row.title,
          url: row.url,
          companyNameHint: row.company_name,
          locationHint: row.location,
          snippet: '',
          markdown: row.description_raw,
          source: row.source as RawJobCandidate['source'],
          postedDateIso: row.posted_date,
        },
        companyId: row.company_id ?? '',
        companyName: row.company_name ?? '',
      });
      const result = scoreRetrieval(normalized, ctx);
      score = result.score;
      rescored.push({ id: row.id, score: result.score, signals: result.signals });
    }

    candidates.push({
      job: {
        id: row.id,
        title: row.title,
        companyName: row.company_name,
        location: row.location,
        description: row.description_raw ?? '',
        retrievalScore: score,
        postedDateIso: row.posted_date,
      },
      score,
      postedDateIso: row.posted_date,
    });
  }

  return { candidates, rescored };
}
