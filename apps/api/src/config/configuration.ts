/**
 * Single source of truth for runtime configuration.
 *
 * Everything is read from the environment exactly once, at boot, and coerced
 * here — services inject `ConfigService` and read typed values rather than
 * touching `process.env` and re-parsing strings at call sites.
 */

function str(key: string, fallback = ''): string {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

function int(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function list(key: string, fallback: string[] = []): string[] {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  corsOrigins: string[];
  supabase: {
    url: string;
    anonKey: string;
    serviceRoleKey: string;
    jwtSecret: string;
  };
  groq: {
    apiKey: string;
    baseUrl: string;
    model: string;
    maxTokens: number;
  };
  firecrawl: {
    apiKey: string;
    baseUrl: string;
    apiVersion: string;
    searchLimit: number;
    mapLimit: number;
  };
  ingest: {
    cron: string;
    cronEnabled: boolean;
    maxAnalysesPerRun: number;
    maxNewJobsPerRun: number;
    /** Cap on brand-new companies resolved (ATS/homepage lookups) per run —
     * each attempt costs Firecrawl calls, so this bounds spend per ingest. */
    maxNewCompaniesPerRun: number;
    analysisConcurrency: number;
    triggerToken: string;
    /** Reject postings older than this. A posting with no extractable date
     * is kept (see common/date.util.ts) — this only rejects provable staleness. */
    maxPostingAgeDays: number;
    /** Minimum retrieval score (0-100) for an eligible job to be saved. */
    retrievalFloor: number;
    /** How far back saved-but-unanalyzed jobs compete for Groq slots. */
    analysisBacklogDays: number;
  };
  staleApplicationDays: number;
  scraping: {
    httpTimeoutMs: number;
    maxLinksPerCompany: number;
    concurrency: number;
  };
}

export default (): AppConfig => ({
  nodeEnv: str('NODE_ENV', 'development'),
  port: int('PORT', 3000),
  corsOrigins: list('CORS_ORIGINS', ['http://localhost:4200']),

  supabase: {
    url: str('SUPABASE_URL'),
    anonKey: str('SUPABASE_ANON_KEY'),
    serviceRoleKey: str('SUPABASE_SERVICE_ROLE_KEY'),
    jwtSecret: str('SUPABASE_JWT_SECRET'),
  },

  groq: {
    apiKey: str('GROQ_API_KEY'),
    baseUrl: str('GROQ_BASE_URL', 'https://api.groq.com').replace(/\/+$/, ''),
    // openai/gpt-oss-120b is Groq's recommended replacement for the retired
    // llama-3.3-70b-versatile (decommissioned 2026-08-16) — good JSON-mode
    // extraction quality vs. speed on Groq's free tier. Swap freely — nothing
    // in the analysis code is model-specific beyond this string.
    model: str('GROQ_MODEL', 'openai/gpt-oss-120b'),
    maxTokens: int('GROQ_MAX_TOKENS', 2048),
  },

  firecrawl: {
    apiKey: str('FIRECRAWL_API_KEY'),
    baseUrl: str('FIRECRAWL_BASE_URL', 'https://api.firecrawl.dev').replace(/\/+$/, ''),
    apiVersion: str('FIRECRAWL_API_VERSION', 'v2'),
    searchLimit: int('FIRECRAWL_SEARCH_LIMIT', 10),
    mapLimit: int('FIRECRAWL_MAP_LIMIT', 15),
  },

  ingest: {
    cron: str('INGEST_CRON', '0 6,18 * * *'),
    cronEnabled: bool('INGEST_CRON_ENABLED', true),
    maxAnalysesPerRun: int('INGEST_MAX_ANALYSES_PER_RUN', 40),
    maxNewJobsPerRun: int('INGEST_MAX_NEW_JOBS_PER_RUN', 100),
    maxNewCompaniesPerRun: int('INGEST_MAX_NEW_COMPANIES_PER_RUN', 5),
    // Groq's free tier rate-limits hard enough that concurrent requests just
    // trade "more parallelism" for "more 429s" — sequential (with the
    // Retry-After-aware backoff in AnalysisService) is the actually-faster
    // choice in practice. Raise this only if you're on a paid Groq tier.
    analysisConcurrency: int('INGEST_ANALYSIS_CONCURRENCY', 1),
    triggerToken: str('INGEST_TRIGGER_TOKEN'),
    maxPostingAgeDays: int('INGEST_MAX_POSTING_AGE_DAYS', 2),
    retrievalFloor: int('INGEST_RETRIEVAL_FLOOR', 40),
    analysisBacklogDays: int('INGEST_ANALYSIS_BACKLOG_DAYS', 30),
  },

  staleApplicationDays: int('STALE_APPLICATION_DAYS', 7),

  scraping: {
    httpTimeoutMs: int('SCRAPING_HTTP_TIMEOUT_MS', 30_000),
    maxLinksPerCompany: int('SCRAPING_MAX_LINKS_PER_COMPANY', 15),
    concurrency: int('SCRAPING_CONCURRENCY', 5),
  },
});
