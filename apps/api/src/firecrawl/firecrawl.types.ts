// ---------------------------------------------------------------------------
// Firecrawl v2 API — minimal request/response shapes we actually consume.
// Full reference: https://docs.firecrawl.dev/api-reference
// ---------------------------------------------------------------------------

export interface FirecrawlCreditUsage {
  remaining_credits: number;
  plan_credits: number | null;
  observed_at: string;
}

export interface FirecrawlSearchRequest {
  query: string;
  limit?: number;
  sources?: Array<{ type: 'web' }>;
  timeout?: number;
  scrapeOptions?: { formats?: string[] };
  /** Google-style time-based search filter, e.g. "cdr:1,cd_min:8/2/2026,cd_max:8/4/2026". */
  tbs?: string;
}

export interface FirecrawlSearchWebResult {
  title?: string;
  description?: string;
  url: string;
  markdown?: string;
  metadata?: Record<string, unknown>;
}

export interface FirecrawlSearchResponse {
  success: boolean;
  data?: {
    web?: FirecrawlSearchWebResult[];
  };
  warning?: string | null;
  error?: string;
}

export interface FirecrawlMapRequest {
  url: string;
  search?: string;
  limit?: number;
  sitemap?: 'skip' | 'include' | 'only';
  includeSubdomains?: boolean;
  timeout?: number;
}

export interface FirecrawlMapLink {
  url: string;
  title?: string;
  description?: string;
}

export interface FirecrawlMapResponse {
  success: boolean;
  links?: FirecrawlMapLink[];
  error?: string;
}

export interface FirecrawlScrapeRequest {
  url: string;
  formats?: string[];
  onlyMainContent?: boolean;
  timeout?: number;
}

export interface FirecrawlScrapeMetadata {
  title?: string | string[];
  description?: string | string[];
  sourceURL?: string;
  url?: string;
  statusCode?: number;
}

export interface FirecrawlScrapeData {
  markdown?: string;
  metadata?: FirecrawlScrapeMetadata;
}

export interface FirecrawlScrapeResponse {
  success: boolean;
  data?: FirecrawlScrapeData;
  error?: string;
}

/** Normalised shape the rest of the app works with, regardless of which
 * Firecrawl endpoint produced it. */
export interface RawJobCandidate {
  title: string;
  url: string;
  companyNameHint: string | null;
  locationHint: string | null;
  snippet: string;
  markdown: string | null;
  source: 'firecrawl_scrape' | 'ats_api' | 'http_scrape';
  /** yyyy-mm-dd, best-effort extracted from the listing text. Null when no
   * recognisable date signal was found — see common/date.util.ts. */
  postedDateIso: string | null;
}
