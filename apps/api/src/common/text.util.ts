import type { SeniorityLevel } from '@jobportal/shared';

/** Firecrawl metadata fields are `string | string[]` depending on the page. */
export function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) return item.trim();
    }
  }
  return null;
}

/** Collapse whitespace and hard-cap length, for storing scraped descriptions. */
export function normalizeWhitespace(input: string, maxLength = 40_000): string {
  const collapsed = input.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}\n…[truncated]` : collapsed;
}

/**
 * Cheap seniority classification from the title (and description as backup).
 *
 * Runs at ingest so a posting is filterable before Claude ever sees it — the
 * analysis step later overwrites this with a better guess. Order matters:
 * senior markers are checked first because "Senior Engineer, Entry Program"
 * should read as senior.
 */
export function guessSeniority(title: string, description?: string | null): SeniorityLevel {
  const haystack = `${title} ${description?.slice(0, 1500) ?? ''}`.toLowerCase();

  const senior = [
    'senior',
    'sr.',
    'sr ',
    'staff',
    'principal',
    'lead ',
    'tech lead',
    'team lead',
    'architect',
    'head of',
    'director',
    'vp ',
    'manager',
    'iii',
    'iv',
    '5+ year',
    '6+ year',
    '7+ year',
    '8+ year',
    '10+ year',
  ];
  if (senior.some((marker) => haystack.includes(marker))) return 'senior';

  const entry = [
    'intern',
    'internship',
    'graduate',
    'fresher',
    'entry level',
    'entry-level',
    'junior',
    'jr.',
    'jr ',
    'trainee',
    'apprentice',
    'associate engineer',
    '0-1 year',
    '0-2 year',
    '0-3 year',
    'fresh graduate',
  ];
  if (entry.some((marker) => haystack.includes(marker))) return 'entry';

  const mid = ['mid level', 'mid-level', 'ii', '2+ year', '3+ year', '4+ year', 'sde 2', 'sde ii'];
  if (mid.some((marker) => haystack.includes(marker))) return 'mid';

  return 'unknown';
}

/**
 * Heuristic gate for search results: does this look like an actual job posting
 * rather than a blog post, a company "life at" page, or a listing index?
 *
 * Deliberately permissive — a false positive costs one Claude call, a false
 * negative silently loses a real opening.
 */
export function looksLikeJobPosting(title: string, url: string): boolean {
  const t = title.toLowerCase();
  const u = url.toLowerCase();

  const negativeTitle = [
    'how to',
    'what is',
    'top 10',
    'best ',
    'guide',
    'tutorial',
    'salary',
    'interview questions',
    'vs ',
    'roadmap',
    'blog',
  ];
  if (negativeTitle.some((marker) => t.includes(marker))) return false;

  // Aggregator search/category pages, not individual postings. Real postings
  // name a role at a company; listing pages summarize a query — "294 ... Jobs
  // in Remote", "X Jobs, Employment", "X Jobs (NOW HIRING)", "X Jobs 2026".
  const listingTitlePatterns = [
    /^\d[\d,]*\s/, // leading result count: "2274 node js developer Jobs..."
    /\bjobs\s+in\b/, // "... Jobs in United States"
    /\bjobs,\s*employment\b/, // Indeed's "X Jobs, Employment"
    /\(now hiring\)/,
    /\bjobs\s+hiring\s+now\b/,
    /\bjobs\s+\d{4}\b/, // "... Jobs 2026"
  ];
  if (listingTitlePatterns.some((pattern) => pattern.test(t))) return false;

  const negativePath = ['/blog/', '/news/', '/press/', '/about', '/privacy', '/terms', '/login'];
  if (negativePath.some((marker) => u.includes(marker))) return false;

  // Known aggregator search/category URL shapes (as opposed to a specific
  // posting's permalink, which carries an ID or a company+role+location path).
  const listingUrlPatterns = [
    /-jobs\.html$/, // Indeed SEO search page: /q-<query>-jobs.html
    /srch_il/, // Glassdoor search results marker
    /ziprecruiter\.com\/jobs\/[a-z0-9-]+\/?$/, // ZipRecruiter category: /Jobs/<role-slug>
    /linkedin\.com\/jobs\/[a-z0-9-]+-jobs\/?$/, // LinkedIn category (vs. /jobs/view/...-<id>, which is real)
  ];
  if (listingUrlPatterns.some((pattern) => pattern.test(u))) return false;

  const positivePath = ['/job', '/career', '/vacanc', '/opening', '/position', '/apply', '/hiring'];
  const positiveTitle = [
    'engineer',
    'developer',
    'programmer',
    'sde',
    'backend',
    'back end',
    'back-end',
    'full stack',
    'fullstack',
    'full-stack',
    'software',
  ];

  return (
    positivePath.some((marker) => u.includes(marker)) ||
    positiveTitle.some((marker) => t.includes(marker))
  );
}

/**
 * Strip the trailing " - Company | Board" noise search engines put in titles,
 * so the stored title is the role rather than the whole page title.
 */
export function cleanJobTitle(rawTitle: string): string {
  let title = rawTitle.trim();

  for (const separator of [' | ', ' – ', ' — ', ' - ', ' @ ', ' at ']) {
    const index = title.indexOf(separator);
    // Only cut if what's left still looks like a role, not a fragment.
    if (index > 8) {
      title = title.slice(0, index).trim();
      break;
    }
  }

  return title.replace(/\s+/g, ' ').slice(0, 200).trim();
}

/**
 * Pull a company name out of a search-result title like
 * "Backend Engineer - Acme Corp | Greenhouse".
 */
export function companyFromTitle(rawTitle: string): string | null {
  const match = rawTitle.match(/(?:\sat\s|\s[-–—@|]\s)([^-–—|@]{2,60})/i);
  if (!match) return null;

  const candidate = match[1]
    .replace(/\b(jobs?|careers?|hiring|apply|greenhouse|lever|workday|linkedin|indeed)\b/gi, '')
    .replace(/[|,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (candidate.length < 2 || candidate.length > 60) return null;
  return candidate;
}

/** Best-effort location extraction from a listing snippet. */
export function extractLocation(text: string | null | undefined): string | null {
  if (!text) return null;
  const remote = /\b(fully remote|remote[- ]first|100% remote|work from home|wfh|remote)\b/i;
  if (remote.test(text)) return 'Remote';

  const labelled = text.match(/\bLocation[:\s]+([A-Za-z .,'-]{3,60})/i);
  if (labelled) return labelled[1].replace(/\s+/g, ' ').trim();

  const cityState = text.match(
    /\b([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?),\s*([A-Z]{2}|[A-Z][a-zA-Z]+)\b/,
  );
  if (cityState) return `${cityState[1]}, ${cityState[2]}`;

  return null;
}

/** Escape a string for safe use inside a regex. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word/phrase match, not a bare substring search — `title.includes('swe')`
 * also matches inside "Swedish", which is exactly how a Sales role ("Account
 * Development Representative (Swedish Speaking)") once slipped past this
 * filter. Every marker in the lists below starts and ends on a word
 * character, so `\b` boundaries are safe on both sides.
 *
 * A blank/whitespace-only marker is treated as never matching, not as a
 * wildcard — `new RegExp('\\b\\b')` matches any word character, which would
 * otherwise turn one stray empty string in a profile's target_roles into
 * "accept every job," or one in excluded_roles into "reject every job."
 */
export function containsWord(haystack: string, marker: string): boolean {
  const trimmed = marker.trim();
  if (!trimmed) return false;
  return new RegExp(`\\b${escapeRegex(trimmed)}\\b`, 'i').test(haystack);
}
