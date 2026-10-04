import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { retry } from '../common/async.util';
import {
  cleanJobTitle,
  companyFromTitle,
  extractLocation,
  looksLikeJobPosting,
} from '../common/text.util';
import { companyNameFromHost, hostnameOf, isNonCompanyHost } from '../common/url.util';
import { parsePostedDate, toDateOnlyIso } from '../common/date.util';
import type {
  FirecrawlCreditUsage,
  FirecrawlMapResponse,
  FirecrawlScrapeResponse,
  FirecrawlSearchResponse,
  RawJobCandidate,
} from './firecrawl.types';

/**
 * Thin wrapper over the three Firecrawl v2 endpoints the plan calls for:
 * search (auto-discovery), map (enumerate a career site), scrape (fetch one
 * page). Callers get back `RawJobCandidate[]` — the search/scrape distinction
 * is preserved only in `source`, everything else is normalised.
 */
@Injectable()
export class FirecrawlService {
  private readonly logger = new Logger(FirecrawlService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly searchLimit: number;
  private readonly mapLimit: number;
  private readonly maxPostingAgeDays: number;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('firecrawl.apiKey', '');
    const root = this.config.get<string>('firecrawl.baseUrl', 'https://api.firecrawl.dev');
    const version = this.config.get<string>('firecrawl.apiVersion', 'v2');
    this.baseUrl = `${root}/${version}`;
    this.searchLimit = this.config.get<number>('firecrawl.searchLimit', 10);
    this.mapLimit = this.config.get<number>('firecrawl.mapLimit', 15);
    this.maxPostingAgeDays = this.config.get<number>('ingest.maxPostingAgeDays', 2);
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  private creditUsageCache: { fetchedAt: number; data: FirecrawlCreditUsage } | null = null;

  /**
   * Remaining/plan credits for the team, from Firecrawl's dedicated billing
   * endpoint — not derivable from scrape/map/search response headers.
   * Cached briefly since the dashboard polls this during a live ingestion
   * run and the number only ever changes once per Firecrawl call anyway.
   */
  async getCreditUsage(): Promise<FirecrawlCreditUsage | null> {
    if (!this.isConfigured) return null;

    const cacheTtlMs = 30_000;
    if (this.creditUsageCache && Date.now() - this.creditUsageCache.fetchedAt < cacheTtlMs) {
      return this.creditUsageCache.data;
    }

    try {
      const res = await fetch(`${this.baseUrl}/team/credit-usage`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) {
        this.logger.warn(`Firecrawl credit-usage failed (${res.status})`);
        return this.creditUsageCache?.data ?? null;
      }

      const body = (await res.json()) as { data?: { remainingCredits?: number; planCredits?: number } };
      if (typeof body.data?.remainingCredits !== 'number') return null;

      const data: FirecrawlCreditUsage = {
        remaining_credits: body.data.remainingCredits,
        plan_credits: body.data.planCredits ?? null,
        observed_at: new Date().toISOString(),
      };
      this.creditUsageCache = { fetchedAt: Date.now(), data };
      return data;
    } catch (error) {
      this.logger.warn(`Firecrawl credit-usage request failed: ${error instanceof Error ? error.message : error}`);
      return this.creditUsageCache?.data ?? null;
    }
  }

  /**
   * Company-discovery search: unlike the old job-posting search, results here
   * are never turned into job candidates directly — the caller only extracts
   * company names from them. This is the one place a "random website" URL is
   * allowed to appear, and it's immediately discarded after name extraction.
   */
  async searchForCompanyNames(query: string): Promise<Array<{ title: string; url: string; description: string }>> {
    if (!this.isConfigured) return [];

    const response = await this.request<FirecrawlSearchResponse>('/search', {
      query,
      limit: this.searchLimit,
      sources: [{ type: 'web' }],
      timeout: 30_000,
    });

    if (!response?.success || !response.data?.web) {
      if (response?.warning) this.logger.warn(`Firecrawl search warning: ${response.warning}`);
      return [];
    }

    return response.data.web
      .filter((r): r is typeof r & { url: string } => Boolean(r.url))
      .map((r) => ({ title: r.title ?? '', url: r.url, description: r.description ?? '' }));
  }

  /**
   * Find a company's own homepage — used to resolve a careers page when the
   * ATS slug guesses (Greenhouse/Lever/Ashby) come up empty. Deliberately
   * conservative: returns null rather than a guess when nothing looks like an
   * actual homepage, since a wrong domain here would cascade into scraping
   * (and inserting jobs from) an unrelated company or a news site.
   */
  async findCompanyHomepage(companyName: string): Promise<string | null> {
    if (!this.isConfigured) return null;

    const response = await this.request<FirecrawlSearchResponse>('/search', {
      query: `"${companyName}" official website`,
      limit: 5,
      sources: [{ type: 'web' }],
      timeout: 20_000,
    });

    if (!response?.success || !response.data?.web) return null;

    for (const result of response.data.web) {
      if (!result.url) continue;
      const host = hostnameOf(result.url);
      if (isNonCompanyHost(host)) continue;

      let path: string;
      try {
        path = new URL(result.url).pathname;
      } catch {
        continue;
      }
      // Homepage heuristic: no path, or a single short segment (e.g. "/en",
      // "/home") — more than that looks like a deep article/product page,
      // not the root site.
      const segments = path.split('/').filter(Boolean);
      if (segments.length > 1) continue;

      return `https://${host}`;
    }
    return null;
  }

  /**
   * Given a company's homepage, find their careers/jobs section — the link
   * whose URL path actually names a careers-shaped route, not just any
   * result `/map` happens to return. No match means null, not a guess.
   */
  async findCareerPageUrl(rootDomain: string): Promise<string | null> {
    if (!this.isConfigured) return null;

    const mapResponse = await this.request<FirecrawlMapResponse>('/map', {
      url: rootDomain,
      search: 'careers jobs hiring positions openings join us work with us',
      limit: 30,
      sitemap: 'include',
      timeout: 30_000,
    });

    if (!mapResponse?.success || !mapResponse.links?.length) return null;

    const careerLink = mapResponse.links.find((link) =>
      /\/(careers?|jobs?|join-us|work-with-us|hiring|positions|opportunities)\b/i.test(link.url),
    );
    return careerLink?.url ?? null;
  }

  /** Google-style custom date range: postings from (today - N days) through today. */
  private buildFreshnessTbs(): string {
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - this.maxPostingAgeDays);
    return `cdr:1,cd_min:${toUsDate(from)},cd_max:${toUsDate(now)},sbd:1`;
  }

  private isTooOld(date: Date): boolean {
    const ageMs = Date.now() - date.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return ageDays > this.maxPostingAgeDays;
  }

  /**
   * Pinned-company path: map the careers page to find individual job URLs,
   * then scrape each one for full content. `search` narrows the map results
   * toward job-shaped URLs when the site's link structure allows it.
   */
  async discoverCompanyJobs(careersUrl: string): Promise<RawJobCandidate[]> {
    if (!this.isConfigured) return [];

    const mapResponse = await this.request<FirecrawlMapResponse>('/map', {
      url: careersUrl,
      search: 'job opening position career',
      limit: this.mapLimit,
      sitemap: 'include',
      timeout: 30_000,
    });

    if (!mapResponse?.success || !mapResponse.links?.length) return [];

    const jobLinks = mapResponse.links.filter((link) => looksLikeJobPosting(link.title ?? '', link.url));
    const toScrape = (jobLinks.length > 0 ? jobLinks : mapResponse.links).slice(0, this.mapLimit);

    const candidates: RawJobCandidate[] = [];
    for (const link of toScrape) {
      const scraped = await this.scrapePage(link.url);
      if (scraped) candidates.push(scraped);
    }

    this.logger.log(`Mapped ${careersUrl} -> ${toScrape.length} page(s) scraped, ${candidates.length} candidate(s)`);
    return candidates;
  }

  async scrapePage(url: string): Promise<RawJobCandidate | null> {
    if (!this.isConfigured) return null;

    const response = await this.request<FirecrawlScrapeResponse>('/scrape', {
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      timeout: 30_000,
    });

    if (!response?.success || !response.data) return null;

    const meta = response.data.metadata ?? {};
    const rawTitle = firstOf(meta.title) ?? '';
    if (!rawTitle) return null;

    const title = cleanJobTitle(rawTitle);
    if (title.length < 3 || !looksLikeJobPosting(rawTitle, url)) return null;

    // No tbs equivalent for a direct scrape — freshness here relies entirely
    // on a date signal in the page content. A career page without one is
    // kept (unknown isn't evidence of staleness); a page that names an old
    // date is rejected.
    const dateSignal = `${rawTitle} ${firstOf(meta.description) ?? ''} ${(response.data.markdown ?? '').slice(0, 1000)}`;
    const postedDate = parsePostedDate(dateSignal);
    if (postedDate && this.isTooOld(postedDate)) return null;

    const host = hostnameOf(url);
    return {
      title,
      url: meta.sourceURL ?? meta.url ?? url,
      companyNameHint: companyFromTitle(rawTitle) ?? companyNameFromHost(host),
      locationHint: extractLocation(response.data.markdown ?? firstOf(meta.description)),
      snippet: (firstOf(meta.description) ?? '').slice(0, 2000),
      markdown: response.data.markdown ?? null,
      source: 'firecrawl_scrape',
      postedDateIso: postedDate ? toDateOnlyIso(postedDate) : null,
    };
  }

  private async request<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
    try {
      return await retry(
        async () => {
          const res = await fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          });

          if (res.status === 429 || res.status >= 500) {
            throw new FirecrawlRetryableError(`Firecrawl ${path} returned ${res.status}`);
          }
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            this.logger.warn(`Firecrawl ${path} failed (${res.status}): ${text.slice(0, 300)}`);
            return null;
          }
          return (await res.json()) as T;
        },
        {
          attempts: 3,
          baseDelayMs: 1_000,
          shouldRetry: (error) => error instanceof FirecrawlRetryableError,
          onRetry: (_error, attempt, delay) =>
            this.logger.warn(`Retrying Firecrawl ${path} (attempt ${attempt}) in ${Math.round(delay)}ms`),
        },
      );
    } catch (error) {
      this.logger.error(
        `Firecrawl ${path} exhausted retries: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }
}

class FirecrawlRetryableError extends Error {}

function firstOf(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** M/D/YYYY — the format Google's tbs custom date range expects. */
function toUsDate(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}
