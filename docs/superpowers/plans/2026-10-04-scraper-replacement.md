# Scraper Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local HTTP/JSON-LD/Cheerio scraper for custom (non-ATS) career pages, tried before the existing `FirecrawlService.discoverCompanyJobs()`, which becomes a fallback for sites the local scraper can't handle. Output stays `RawJobCandidate[]`; nothing downstream of `scrapeCustomCareerPage()` changes.

**Architecture:** Six new plain-function modules under `apps/api/src/scraping/` (no NestJS DI — no state to inject): `http-page-fetcher` (GET + retry + timeout), `job-link-discoverer` (parse `<a>` tags, filter via the existing `looksLikeJobPosting()`), `json-ld-extractor` and `cheerio-job-extractor` (two extraction strategies, JSON-LD tried first), `job-extractor` (orchestrates the two), `career-page-scraper` (orchestrates fetch → discover → extract-all). `IngestService.scrapeCustomCareerPage()` tries `career-page-scraper` first and falls back to the existing Firecrawl call only if zero candidates come back.

**Tech Stack:** NestJS, TypeScript, Cheerio (new dependency), Jest with fixture HTML files, Node's built-in `fetch`/`AbortController` (Node v24, confirmed available — no `node-fetch` or polyfill needed).

**Spec:** [docs/superpowers/specs/2026-10-04-scraper-replacement-design.md](../specs/2026-10-04-scraper-replacement-design.md)

## Global Constraints

- No Playwright, no sitemap.xml discovery, no site-specific extractor adapters — per the spec's §3 Non-goals. A task that finds itself reaching for any of these is out of scope; let the page fall through to the Firecrawl fallback instead.
- Every new fetch/extract function returns `null` (or `[]` for collections) on failure — never throws past its own boundary. This matches `FirecrawlService.scrapePage()`'s existing behavior exactly, and `scrapeResolvedCompanies()`'s outer try/catch remains the only place a company-level failure is actually caught and logged.
- `RawJobCandidate`'s shape does not change — only its `source` union grows by one member (`'http_scrape'`).
- `stripHtml()` moves from `ats-clients.ts` to a new shared `common/html.util.ts` with **zero behavior change** — same regex chain, same order, verified by a byte-for-byte-equivalent test before and after the move.
- All new Cheerio/fetch-based functions are plain exported functions, not NestJS injectable services — consistent with the spec's §5 rationale and the existing `fetchAtsJobs()` pattern in `ats-clients.ts`.
- No live network calls in any test — `http-page-fetcher.spec.ts` mocks `global.fetch`; every other new module is tested against local fixture HTML strings, not real URLs.

## Review Focus

- **A `<script type="application/ld+json">` block that is valid JSON but not a JobPosting** (e.g. an `Organization` or `BreadcrumbList` schema, both extremely common on real career pages alongside a JobPosting block, or even alone with no JobPosting present): the JSON-LD extractor must skip it and either keep scanning other script tags or return `null`, not crash or misattribute an unrelated schema's fields to a job. Pinned in Task 4.
- **A `<script type="application/ld+json">` block containing genuinely malformed JSON** (a real-world frequency on hand-rolled career pages): `JSON.parse` must not throw uncaught and crash the whole extraction — one bad script tag must not prevent scanning the next one. Pinned in Task 4.
- **A career page with zero `<a>` links matching `looksLikeJobPosting()`** (e.g. a "life at our company" marketing page with no actual listings, or a page that lists jobs via a client-side-rendered widget with no server-rendered links at all): `career-page-scraper` must return `[]` cleanly, which is exactly the trigger condition for the Firecrawl fallback — not throw, not return a single bogus candidate. Pinned in Task 6.
- **An HTTP fetch that times out or returns a non-2xx/network error after retries**: must resolve to `null`, not reject/throw into the caller — a single company's unreachable career page must not abort the whole `scrapeResolvedCompanies()` loop (that loop's own try/catch is the existing outer safety net, but this task's functions must not rely on it catching an unexpected throw from deep inside the extraction chain). Pinned in Task 2.
- **A response whose `content-type` is not HTML** (a PDF job description, a JSON API response mistakenly pointed at by a stale `careers_url`, a redirect to an image): `fetchPage()` must reject it before handing non-HTML bytes to Cheerio, which would otherwise either throw or silently produce nonsense from binary-as-text. Pinned in Task 2.

---

## Task 1: Extract `stripHtml()` into a shared util

**Files:**
- Create: `apps/api/src/common/html.util.ts`
- Modify: `apps/api/src/discovery/ats-clients.ts:200-213` (remove the local `stripHtml`, import the shared one)
- Test: Create `apps/api/src/common/html.util.spec.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `stripHtml(html: string): string` — consumed by Task 1's own caller fix in `ats-clients.ts`, and by Task 4 (`json-ld-extractor.ts`)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/common/html.util.spec.ts`:

```ts
import { stripHtml } from './html.util';

describe('stripHtml', () => {
  it('strips tags and converts common block elements to newlines', () => {
    const html = '<p>First paragraph.</p><p>Second paragraph.</p><br>After break.';
    const result = stripHtml(html);
    expect(result).toBe('First paragraph.\nSecond paragraph.\nAfter break.');
  });

  it('removes script and style blocks entirely, including their content', () => {
    const html = '<p>Visible</p><script>var x = "hidden";</script><style>.a{color:red}</style>';
    const result = stripHtml(html);
    expect(result).not.toContain('hidden');
    expect(result).not.toContain('color:red');
    expect(result).toBe('Visible');
  });

  it('decodes common HTML entities', () => {
    expect(stripHtml('Tom &amp; Jerry &lt;tag&gt; test&nbsp;here')).toBe('Tom & Jerry <tag> test here');
  });

  it('collapses excessive blank lines to at most one', () => {
    const html = '<p>A</p><p></p><p></p><p>B</p>';
    const result = stripHtml(html);
    expect(result).not.toMatch(/\n{3,}/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx jest html.util.spec.ts`
Expected: FAIL — `./html.util` module does not exist yet.

- [ ] **Step 3: Create `html.util.ts` with the extracted implementation**

Create `apps/api/src/common/html.util.ts` with exactly the same regex chain currently in `ats-clients.ts:200-213`, made exported:

```ts
/** Greenhouse's `content` field, and raw HTML from scraped career pages, both
 * need plain-text conversion before they're usable as a job description or
 * passed to the Groq skill-gap prompt. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx jest html.util.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Update `ats-clients.ts` to import the shared function and remove its local copy**

In `apps/api/src/discovery/ats-clients.ts`, add the import near the top (alongside the existing `import type { AtsType } from '@jobportal/shared';`):

```ts
import { stripHtml } from '../common/html.util';
```

Then delete the local `function stripHtml(html: string): string { ... }` definition (lines 200-213) entirely. The call site at line 117 (`description: j.content ? stripHtml(j.content) : null,`) needs no change — same function name, now imported instead of locally defined.

- [ ] **Step 6: Run the full test suite and typecheck to confirm nothing broke**

Run: `cd apps/api && npm run typecheck && npm test`
Expected: typecheck PASS; all existing test suites still PASS (this is a pure extraction — no behavior change, so every pre-existing test must still be green).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/common/html.util.ts apps/api/src/common/html.util.spec.ts apps/api/src/discovery/ats-clients.ts
git commit -m "refactor(common): extract stripHtml into a shared util"
```

---

## Task 2: `HttpPageFetcher`

**Files:**
- Create: `apps/api/src/scraping/http-page-fetcher.ts`
- Test: Create `apps/api/src/scraping/http-page-fetcher.spec.ts`

**Interfaces:**
- Consumes: the existing `retry()` from `apps/api/src/common/async.util.ts` (signature: `retry<T>(operation: () => Promise<T>, options: { attempts?, baseDelayMs?, maxDelayMs?, maxHintDelayMs?, shouldRetry?, onRetry? }): Promise<T>`)
- Produces: `fetchPage(url: string, timeoutMs: number): Promise<FetchedPage | null>` and the `FetchedPage` interface — consumed by Task 6 (`career-page-scraper.ts`) and Task 5 (`job-extractor.ts`)

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/scraping/http-page-fetcher.spec.ts`:

```ts
import { fetchPage } from './http-page-fetcher';

describe('fetchPage', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockFetchOnce(response: Partial<Response> & { text: () => Promise<string> }): void {
    global.fetch = jest.fn().mockResolvedValue(response as Response);
  }

  it('returns the page on a successful HTML response', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      url: 'https://example.com/careers',
      text: async () => '<html><body>Jobs here</body></html>',
    });

    const result = await fetchPage('https://example.com/careers', 5000);

    expect(result).toEqual({
      url: 'https://example.com/careers',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      html: '<html><body>Jobs here</body></html>',
    });
  });

  it('returns null when the content-type is not HTML', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      url: 'https://example.com/careers.pdf',
      text: async () => '%PDF-1.4 binary garbage',
    });

    const result = await fetchPage('https://example.com/careers.pdf', 5000);

    expect(result).toBeNull();
  });

  it('returns null when the response body exceeds the size limit', async () => {
    const hugeHtml = 'x'.repeat(6 * 1024 * 1024); // 6MB, over the 5MB cap
    mockFetchOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      url: 'https://example.com/huge',
      text: async () => hugeHtml,
    });

    const result = await fetchPage('https://example.com/huge', 5000);

    expect(result).toBeNull();
  });

  it('retries on a 503 and eventually returns null if every attempt fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ 'content-type': 'text/html' }),
      url: 'https://example.com/down',
      text: async () => '',
    } as Response);

    const result = await fetchPage('https://example.com/down', 1000);

    expect(result).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(3); // matches retry()'s default attempts: 3
  });

  it('returns null without retrying on a 404', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({ 'content-type': 'text/html' }),
      url: 'https://example.com/missing',
      text: async () => '',
    } as Response);

    const result = await fetchPage('https://example.com/missing', 1000);

    expect(result).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1); // 404 is not retryable
  });

  it('returns null when fetch itself throws (network error)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await fetchPage('https://example.com/unreachable', 1000);

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest http-page-fetcher.spec.ts`
Expected: FAIL — `./http-page-fetcher` module does not exist yet.

- [ ] **Step 3: Implement `http-page-fetcher.ts`**

Create `apps/api/src/scraping/http-page-fetcher.ts`:

```ts
import { Logger } from '@nestjs/common';
import { retry } from '../common/async.util';

const logger = new Logger('HttpPageFetcher');

/** 5MB — generous for any real career-page HTML document, and small enough
 * that a pathological response can't exhaust memory. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string | null;
  html: string;
}

class FetcherRetryableError extends Error {}

/**
 * Fetch a page's HTML over plain HTTP, with a timeout, a realistic
 * User-Agent (many career-page CDNs/WAFs block requests with no UA or an
 * obviously-bot one), and the same retry-on-429/5xx policy used elsewhere
 * in this codebase (see FirecrawlService.request()). Never throws — a
 * timeout, a network error, a non-HTML response, or an oversized response
 * all resolve to `null`, the same "try the next thing" contract
 * FirecrawlService.scrapePage() already uses.
 */
export async function fetchPage(url: string, timeoutMs: number): Promise<FetchedPage | null> {
  try {
    return await retry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let res: Response;
        try {
          res = await fetch(url, {
            signal: controller.signal,
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
          });
        } finally {
          clearTimeout(timer);
        }

        if (res.status === 429 || res.status >= 500) {
          throw new FetcherRetryableError(`HTTP ${res.status} fetching ${url}`);
        }
        if (!res.ok) {
          logger.debug(`Non-retryable status ${res.status} fetching ${url}`);
          return null;
        }

        const contentType = res.headers.get('content-type');
        if (!contentType || !contentType.toLowerCase().startsWith('text/html')) {
          logger.debug(`Skipping non-HTML content-type "${contentType}" for ${url}`);
          return null;
        }

        const html = await res.text();
        if (html.length > MAX_RESPONSE_BYTES) {
          logger.warn(`Response for ${url} exceeded ${MAX_RESPONSE_BYTES} bytes, skipping`);
          return null;
        }

        return {
          url: res.url || url,
          status: res.status,
          contentType,
          html,
        };
      },
      {
        attempts: 3,
        baseDelayMs: 500,
        shouldRetry: (error) => error instanceof FetcherRetryableError,
      },
    );
  } catch (error) {
    logger.debug(`fetchPage exhausted retries or failed for ${url}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}
```

Note: the size check happens after `res.text()` rather than streaming, which is a deliberate simplification — `fetch`'s body is already fully buffered into a string by `.text()` in Node's implementation before this check runs, so streaming wouldn't save memory here without switching to a manual `ReadableStream` reader, which is unnecessary complexity for a career page (real-world HTML documents are reliably well under 5MB; this guard is a safety net against a pathological response, not a performance-critical path).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest http-page-fetcher.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: PASS (this module has no external callers yet, so nothing else can be broken by it)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/scraping/http-page-fetcher.ts apps/api/src/scraping/http-page-fetcher.spec.ts
git commit -m "feat(scraping): add HttpPageFetcher with timeout, retry, and content-type/size guards"
```

---

## Task 3: `JobLinkDiscoverer`

**Files:**
- Create: `apps/api/src/scraping/job-link-discoverer.ts`
- Test: Create `apps/api/src/scraping/job-link-discoverer.spec.ts`
- Create: `apps/api/src/scraping/__fixtures__/careers-page-with-mixed-links.html`

**Interfaces:**
- Consumes: `looksLikeJobPosting(title: string, url: string): boolean` from `apps/api/src/common/text.util.ts` (existing, unchanged); `canonicalizeUrl(input: string): string` from `apps/api/src/common/url.util.ts` (existing, unchanged)
- Produces: `discoverJobLinks(html: string, baseUrl: string, maxLinks: number): DiscoveredLink[]` and the `DiscoveredLink` interface — consumed by Task 6 (`career-page-scraper.ts`)

- [ ] **Step 1: Add the `cheerio` dependency**

Run: `cd apps/api && npm install cheerio`

This updates `apps/api/package.json` and the repo's root `package-lock.json`. Verify the install succeeded:

Run: `cd apps/api && node -e "require('cheerio'); console.log('cheerio loaded OK')"`
Expected: prints `cheerio loaded OK`

- [ ] **Step 2: Write the fixture file**

Create `apps/api/src/scraping/__fixtures__/careers-page-with-mixed-links.html`:

```html
<!DOCTYPE html>
<html>
<head><title>Careers at Acme Corp</title></head>
<body>
  <nav>
    <a href="/about">About</a>
    <a href="/privacy">Privacy Policy</a>
    <a href="/blog">Blog</a>
  </nav>
  <main>
    <h1>Open Positions</h1>
    <ul>
      <li><a href="/careers/backend-engineer-123">Backend Engineer</a></li>
      <li><a href="/careers/software-developer-456">Software Developer</a></li>
      <li><a href="https://acme.com/careers/full-stack-engineer-789">Full Stack Engineer</a></li>
      <li><a href="/careers/backend-engineer-123?utm_source=newsletter">Backend Engineer (duplicate via tracking param)</a></li>
    </ul>
  </main>
  <footer>
    <a href="/terms">Terms of Service</a>
    <a href="/login">Login</a>
  </footer>
</body>
</html>
```

- [ ] **Step 3: Write the failing tests**

Create `apps/api/src/scraping/job-link-discoverer.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverJobLinks } from './job-link-discoverer';

const FIXTURE_HTML = readFileSync(
  join(__dirname, '__fixtures__', 'careers-page-with-mixed-links.html'),
  'utf-8',
);

describe('discoverJobLinks', () => {
  it('keeps only links that look like job postings, dropping nav/footer noise', () => {
    const links = discoverJobLinks(FIXTURE_HTML, 'https://acme.com/careers', 10);
    const urls = links.map((l) => l.url);

    expect(urls).not.toContain('https://acme.com/about');
    expect(urls).not.toContain('https://acme.com/privacy');
    expect(urls).not.toContain('https://acme.com/blog');
    expect(urls).not.toContain('https://acme.com/terms');
    expect(urls).not.toContain('https://acme.com/login');
  });

  it('resolves relative URLs against the base URL', () => {
    const links = discoverJobLinks(FIXTURE_HTML, 'https://acme.com/careers', 10);
    const urls = links.map((l) => l.url);

    expect(urls).toContain('https://acme.com/careers/backend-engineer-123');
  });

  it('keeps absolute URLs on the same domain as-is', () => {
    const links = discoverJobLinks(FIXTURE_HTML, 'https://acme.com/careers', 10);
    const urls = links.map((l) => l.url);

    expect(urls).toContain('https://acme.com/careers/full-stack-engineer-789');
  });

  it('de-duplicates links that differ only by tracking params', () => {
    const links = discoverJobLinks(FIXTURE_HTML, 'https://acme.com/careers', 10);
    const backendLinks = links.filter((l) => l.url.includes('backend-engineer-123'));

    expect(backendLinks).toHaveLength(1);
  });

  it('caps the result at maxLinks', () => {
    const links = discoverJobLinks(FIXTURE_HTML, 'https://acme.com/careers', 1);

    expect(links.length).toBeLessThanOrEqual(1);
  });

  it('returns an empty array for a page with no job-shaped links', () => {
    const html = '<html><body><a href="/about">About</a><a href="/blog">Blog</a></body></html>';
    const links = discoverJobLinks(html, 'https://acme.com', 10);

    expect(links).toEqual([]);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd apps/api && npx jest job-link-discoverer.spec.ts`
Expected: FAIL — `./job-link-discoverer` module does not exist yet.

- [ ] **Step 5: Implement `job-link-discoverer.ts`**

Create `apps/api/src/scraping/job-link-discoverer.ts`:

```ts
import * as cheerio from 'cheerio';
import { looksLikeJobPosting } from '../common/text.util';
import { canonicalizeUrl } from '../common/url.util';

export interface DiscoveredLink {
  url: string;
  text: string;
}

/**
 * Pulls every <a href> off a career page, resolves relative URLs against the
 * page's own URL, and keeps only the ones that look like an individual job
 * posting — reusing the same `looksLikeJobPosting()` heuristic the rest of
 * the ingest pipeline already relies on (see ats-clients.ts/text.util.ts),
 * rather than inventing a second one.
 */
export function discoverJobLinks(html: string, baseUrl: string, maxLinks: number): DiscoveredLink[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const results: DiscoveredLink[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      return; // unparseable href (e.g. "javascript:void(0)") — skip
    }

    const url = resolved.toString();
    const text = $(el).text().trim();

    if (!looksLikeJobPosting(text, url)) return;

    const canonical = canonicalizeUrl(url);
    if (seen.has(canonical)) return;
    seen.add(canonical);

    results.push({ url, text });
  });

  return results.slice(0, maxLinks);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/api && npx jest job-link-discoverer.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 7: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json package-lock.json apps/api/src/scraping/job-link-discoverer.ts apps/api/src/scraping/job-link-discoverer.spec.ts apps/api/src/scraping/__fixtures__/careers-page-with-mixed-links.html
git commit -m "feat(scraping): add JobLinkDiscoverer using the existing looksLikeJobPosting heuristic"
```

---

## Task 4: `JsonLdJobExtractor` and `CheerioJobExtractor`

**Files:**
- Create: `apps/api/src/scraping/json-ld-extractor.ts`
- Create: `apps/api/src/scraping/cheerio-job-extractor.ts`
- Test: Create `apps/api/src/scraping/json-ld-extractor.spec.ts`
- Test: Create `apps/api/src/scraping/cheerio-job-extractor.spec.ts`
- Create: `apps/api/src/scraping/__fixtures__/job-posting-jsonld.html`
- Create: `apps/api/src/scraping/__fixtures__/job-posting-generic-html.html`
- Create: `apps/api/src/scraping/__fixtures__/job-posting-malformed-jsonld.html`
- Create: `apps/api/src/scraping/__fixtures__/page-with-no-job-signal.html`
- Modify: `apps/api/src/firecrawl/firecrawl.types.ts` (widen `RawJobCandidate.source`)
- Modify: `packages/shared/src/enums.ts` (widen `JOB_SOURCES`)

**Interfaces:**
- Consumes: `stripHtml` (Task 1), `extractLocation(text: string | null | undefined): string | null` from `text.util.ts` (existing), `parsePostedDate(text: string, reference?: Date): Date | null` and `toDateOnlyIso(date: Date): string` from `date.util.ts` (existing)
- Produces: `extractJsonLdJobPosting(html: string, sourceUrl: string): RawJobCandidate | null`, `extractGenericJobPosting(html: string, sourceUrl: string): RawJobCandidate | null` — both consumed by Task 5 (`job-extractor.ts`)

- [ ] **Step 1: Widen `RawJobCandidate.source` and `JOB_SOURCES`**

In `apps/api/src/firecrawl/firecrawl.types.ts`, change:

```ts
export interface RawJobCandidate {
  title: string;
  url: string;
  companyNameHint: string | null;
  locationHint: string | null;
  snippet: string;
  markdown: string | null;
  source: 'firecrawl_scrape' | 'ats_api';
  postedDateIso: string | null;
}
```

to:

```ts
export interface RawJobCandidate {
  title: string;
  url: string;
  companyNameHint: string | null;
  locationHint: string | null;
  snippet: string;
  markdown: string | null;
  source: 'firecrawl_scrape' | 'ats_api' | 'http_scrape';
  postedDateIso: string | null;
}
```

In `packages/shared/src/enums.ts`, change:

```ts
export const JOB_SOURCES = [
  'firecrawl_search',
  'firecrawl_scrape',
  'ats_api',
  'manual',
] as const;
```

to:

```ts
export const JOB_SOURCES = [
  'firecrawl_search',
  'firecrawl_scrape',
  'ats_api',
  'http_scrape',
  'manual',
] as const;
```

Rebuild the shared package so `apps/api` picks up the widened type (this repo resolves `@jobportal/shared` via its built `dist/`, not live source — see the candidate-profile sub-project's ledger for why this step is easy to silently skip):

Run: `cd packages/shared && npm run build`
Expected: no errors

- [ ] **Step 2: Write the JSON-LD fixtures**

Create `apps/api/src/scraping/__fixtures__/job-posting-jsonld.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <title>Backend Engineer - Acme Corp</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    "title": "Backend Engineer",
    "description": "<p>We are looking for a Backend Engineer with 2+ years of experience in Node.js and PostgreSQL.</p>",
    "datePosted": "2026-09-15",
    "hiringOrganization": {
      "@type": "Organization",
      "name": "Acme Corp"
    },
    "jobLocation": {
      "@type": "Place",
      "address": {
        "@type": "PostalAddress",
        "addressLocality": "Bangalore",
        "addressCountry": "IN"
      }
    }
  }
  </script>
</head>
<body><h1>Backend Engineer</h1></body>
</html>
```

Create `apps/api/src/scraping/__fixtures__/job-posting-malformed-jsonld.html` (one malformed block followed by a valid one, to prove a parse failure on one script tag doesn't stop scanning the rest):

```html
<!DOCTYPE html>
<html>
<head>
  <title>Software Developer - Acme Corp</title>
  <script type="application/ld+json">
  { this is not valid JSON at all }
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "Organization",
    "name": "Acme Corp"
  }
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    "title": "Software Developer",
    "description": "Join our team as a Software Developer working on backend systems.",
    "datePosted": "2026-09-20",
    "jobLocation": "Remote"
  }
  </script>
</head>
<body><h1>Software Developer</h1></body>
</html>
```

Create `apps/api/src/scraping/__fixtures__/page-with-no-job-signal.html` (shared by both extractor test suites — represents a page with neither JSON-LD nor meaningful content):

```html
<!DOCTYPE html>
<html>
<head><title>Life at Acme Corp</title></head>
<body>
  <nav>Home | About | Careers</nav>
  <p>Short blurb.</p>
</body>
</html>
```

- [ ] **Step 3: Write the failing tests for `json-ld-extractor`**

Create `apps/api/src/scraping/json-ld-extractor.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractJsonLdJobPosting } from './json-ld-extractor';

function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', name), 'utf-8');
}

describe('extractJsonLdJobPosting', () => {
  it('extracts title, description, location, and posted date from a valid JobPosting block', () => {
    const result = extractJsonLdJobPosting(fixture('job-posting-jsonld.html'), 'https://acme.com/careers/backend');

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Backend Engineer');
    expect(result!.companyNameHint).toBe('Acme Corp');
    expect(result!.locationHint).toBe('Bangalore');
    expect(result!.postedDateIso).toBe('2026-09-15');
    expect(result!.markdown).toContain('Backend Engineer with 2+ years');
    expect(result!.markdown).not.toContain('<p>'); // HTML-stripped
    expect(result!.source).toBe('http_scrape');
    expect(result!.url).toBe('https://acme.com/careers/backend');
  });

  it('skips a malformed JSON-LD block and still finds a valid one later on the page', () => {
    const result = extractJsonLdJobPosting(
      fixture('job-posting-malformed-jsonld.html'),
      'https://acme.com/careers/swe',
    );

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Software Developer');
  });

  it('ignores a non-JobPosting schema block (e.g. Organization) and returns null if nothing else matches', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@context": "https://schema.org/", "@type": "Organization", "name": "Acme Corp"}
    </script></head><body></body></html>`;

    const result = extractJsonLdJobPosting(html, 'https://acme.com/about');

    expect(result).toBeNull();
  });

  it('returns null for a page with no JSON-LD at all', () => {
    const result = extractJsonLdJobPosting(fixture('page-with-no-job-signal.html'), 'https://acme.com/life');

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd apps/api && npx jest json-ld-extractor.spec.ts`
Expected: FAIL — `./json-ld-extractor` module does not exist yet.

- [ ] **Step 5: Implement `json-ld-extractor.ts`**

Create `apps/api/src/scraping/json-ld-extractor.ts`:

```ts
import { Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { stripHtml } from '../common/html.util';
import { parsePostedDate, toDateOnlyIso } from '../common/date.util';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

const logger = new Logger('JsonLdJobExtractor');

interface JsonLdJobPosting {
  '@type'?: string | string[];
  title?: string;
  name?: string;
  description?: string;
  datePosted?: string;
  hiringOrganization?: { name?: string } | string;
  jobLocation?: { address?: { addressLocality?: string } } | string;
}

function isJobPostingType(type: string | string[] | undefined): boolean {
  if (!type) return false;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => t.toLowerCase() === 'jobposting');
}

function locationFromJsonLd(jobLocation: JsonLdJobPosting['jobLocation']): string | null {
  if (!jobLocation) return null;
  if (typeof jobLocation === 'string') return jobLocation;
  return jobLocation.address?.addressLocality ?? null;
}

function organizationNameFromJsonLd(org: JsonLdJobPosting['hiringOrganization']): string | null {
  if (!org) return null;
  if (typeof org === 'string') return org;
  return org.name ?? null;
}

/**
 * Looks for a <script type="application/ld+json"> block whose @type is
 * JobPosting (https://schema.org/JobPosting) and maps it onto the app's
 * normalised RawJobCandidate shape. A career page commonly carries several
 * JSON-LD blocks (Organization, BreadcrumbList, JobPosting) — every script
 * tag is tried, in document order, and the first JobPosting match wins.
 * A malformed block (invalid JSON) is skipped, not fatal to the rest.
 */
export function extractJsonLdJobPosting(html: string, sourceUrl: string): RawJobCandidate | null {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]');

  for (let i = 0; i < scripts.length; i++) {
    const raw = $(scripts[i]).text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.debug(`Skipping malformed JSON-LD block on ${sourceUrl}`);
      continue;
    }

    const candidates: JsonLdJobPosting[] = Array.isArray((parsed as { '@graph'?: unknown })?.['@graph'])
      ? ((parsed as { '@graph': JsonLdJobPosting[] })['@graph'])
      : [parsed as JsonLdJobPosting];

    for (const block of candidates) {
      if (!block || typeof block !== 'object' || !isJobPostingType(block['@type'])) continue;

      const title = block.title ?? block.name;
      if (!title) continue;

      const descriptionHtml = block.description ?? '';
      const description = stripHtml(descriptionHtml);
      const postedDate = block.datePosted ? parsePostedDate(block.datePosted) : null;

      return {
        title,
        url: sourceUrl,
        companyNameHint: organizationNameFromJsonLd(block.hiringOrganization),
        locationHint: locationFromJsonLd(block.jobLocation),
        snippet: description.slice(0, 2000),
        markdown: description || null,
        source: 'http_scrape',
        postedDateIso: postedDate ? toDateOnlyIso(postedDate) : null,
      };
    }
  }

  return null;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/api && npx jest json-ld-extractor.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Write the generic-HTML fixture and failing tests for `cheerio-job-extractor`**

Create `apps/api/src/scraping/__fixtures__/job-posting-generic-html.html`:

```html
<!DOCTYPE html>
<html>
<head><title>Careers</title></head>
<body>
  <nav>Home | About</nav>
  <main>
    <h1>Full Stack Engineer</h1>
    <p>We're hiring a Full Stack Engineer to join our growing team in Bangalore, India.</p>
    <p>You'll work across our Node.js backend and React frontend, owning features end to end.
       Requirements: 3+ years experience, strong TypeScript, familiarity with PostgreSQL.
       This is a full-time, on-site role based in Bangalore.</p>
  </main>
</body>
</html>
```

Create `apps/api/src/scraping/cheerio-job-extractor.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractGenericJobPosting } from './cheerio-job-extractor';

function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', name), 'utf-8');
}

describe('extractGenericJobPosting', () => {
  it('extracts a title from h1 and description from main content', () => {
    const result = extractGenericJobPosting(
      fixture('job-posting-generic-html.html'),
      'https://acme.com/careers/full-stack',
    );

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Full Stack Engineer');
    expect(result!.markdown).toContain('Node.js backend and React frontend');
    expect(result!.locationHint).toBe('Bangalore');
    expect(result!.source).toBe('http_scrape');
  });

  it('returns null when there is too little content to be a real job posting', () => {
    const result = extractGenericJobPosting(fixture('page-with-no-job-signal.html'), 'https://acme.com/life');

    expect(result).toBeNull();
  });

  it('falls back to the <title> tag when there is no h1', () => {
    const html = `<html><head><title>Backend Role</title></head>
      <body><article>${'We need a backend engineer with solid experience. '.repeat(10)}</article></body></html>`;

    const result = extractGenericJobPosting(html, 'https://acme.com/careers/backend-2');

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Backend Role');
  });
});
```

- [ ] **Step 8: Run tests to verify they fail**

Run: `cd apps/api && npx jest cheerio-job-extractor.spec.ts`
Expected: FAIL — `./cheerio-job-extractor` module does not exist yet.

- [ ] **Step 9: Implement `cheerio-job-extractor.ts`**

Create `apps/api/src/scraping/cheerio-job-extractor.ts`:

```ts
import * as cheerio from 'cheerio';
import { extractLocation } from '../common/text.util';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

const MIN_TITLE_LENGTH = 3;
const MIN_DESCRIPTION_LENGTH = 100;

/**
 * Minimal, deliberately generic fallback for pages with no JSON-LD: title
 * from the first non-empty h1 (falling back to <title>), description from
 * the first non-empty main/article/[role="main"]. No site-specific
 * selectors — a page that doesn't fit this shape returns null (too little
 * signal), not a low-quality guess, and the caller falls through to the
 * Firecrawl fallback instead.
 */
export function extractGenericJobPosting(html: string, sourceUrl: string): RawJobCandidate | null {
  const $ = cheerio.load(html);

  const h1Text = $('h1').first().text().trim();
  const titleTagText = $('title').first().text().trim();
  const title = h1Text || titleTagText;

  if (!title || title.length < MIN_TITLE_LENGTH) return null;

  const contentSelectors = ['main', 'article', '[role="main"]'];
  let description = '';
  for (const selector of contentSelectors) {
    const text = $(selector).first().text().replace(/\s+/g, ' ').trim();
    if (text.length > description.length) description = text;
  }

  if (description.length < MIN_DESCRIPTION_LENGTH) return null;

  return {
    title,
    url: sourceUrl,
    companyNameHint: null,
    locationHint: extractLocation(description),
    snippet: description.slice(0, 2000),
    markdown: description,
    source: 'http_scrape',
    postedDateIso: null,
  };
}
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `cd apps/api && npx jest cheerio-job-extractor.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 11: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/firecrawl/firecrawl.types.ts packages/shared/src/enums.ts apps/api/src/scraping/json-ld-extractor.ts apps/api/src/scraping/json-ld-extractor.spec.ts apps/api/src/scraping/cheerio-job-extractor.ts apps/api/src/scraping/cheerio-job-extractor.spec.ts apps/api/src/scraping/__fixtures__/job-posting-jsonld.html apps/api/src/scraping/__fixtures__/job-posting-malformed-jsonld.html apps/api/src/scraping/__fixtures__/job-posting-generic-html.html apps/api/src/scraping/__fixtures__/page-with-no-job-signal.html
git commit -m "feat(scraping): add JSON-LD and generic Cheerio job extractors, widen RawJobCandidate source"
```

---

## Task 5: `JobExtractor` orchestration

**Files:**
- Create: `apps/api/src/scraping/job-extractor.ts`
- Test: Create `apps/api/src/scraping/job-extractor.spec.ts`

**Interfaces:**
- Consumes: `fetchPage` (Task 2), `extractJsonLdJobPosting` (Task 4), `extractGenericJobPosting` (Task 4)
- Produces: `extractJob(url: string, timeoutMs: number): Promise<RawJobCandidate | null>` — consumed by Task 6 (`career-page-scraper.ts`)

This task is tested with the real `extractJsonLdJobPosting`/`extractGenericJobPosting` functions (not mocked — they're pure functions over fixture-like HTML strings, cheap to call for real), but mocks `fetchPage` since that's the module's only I/O boundary.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/scraping/job-extractor.spec.ts`:

```ts
import { extractJob } from './job-extractor';
import * as fetcher from './http-page-fetcher';

describe('extractJob', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns null immediately if the page cannot be fetched', async () => {
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue(null);

    const result = await extractJob('https://acme.com/careers/x', 5000);

    expect(result).toBeNull();
  });

  it('prefers a JSON-LD JobPosting when present', async () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type": "JobPosting", "title": "Backend Engineer", "description": "A real job description long enough to pass."}
    </script></head><body><h1>Different title from generic extraction</h1>
      <main>${'padding content to pass the generic extractor length bar. '.repeat(5)}</main>
    </body></html>`;
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue({
      url: 'https://acme.com/careers/x',
      status: 200,
      contentType: 'text/html',
      html,
    });

    const result = await extractJob('https://acme.com/careers/x', 5000);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Backend Engineer'); // from JSON-LD, not the h1
  });

  it('falls back to generic extraction when there is no JSON-LD', async () => {
    const html = `<html><head><title>Fallback</title></head><body>
      <h1>Software Developer</h1>
      <main>${'A long enough description to pass the generic extractor minimum length bar. '.repeat(3)}</main>
    </body></html>`;
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue({
      url: 'https://acme.com/careers/y',
      status: 200,
      contentType: 'text/html',
      html,
    });

    const result = await extractJob('https://acme.com/careers/y', 5000);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Software Developer');
  });

  it('returns null when neither extraction strategy finds enough signal', async () => {
    const html = '<html><head><title>Life at Acme</title></head><body><p>Short.</p></body></html>';
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue({
      url: 'https://acme.com/life',
      status: 200,
      contentType: 'text/html',
      html,
    });

    const result = await extractJob('https://acme.com/life', 5000);

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest job-extractor.spec.ts`
Expected: FAIL — `./job-extractor` module does not exist yet.

- [ ] **Step 3: Implement `job-extractor.ts`**

Create `apps/api/src/scraping/job-extractor.ts`:

```ts
import { fetchPage } from './http-page-fetcher';
import { extractJsonLdJobPosting } from './json-ld-extractor';
import { extractGenericJobPosting } from './cheerio-job-extractor';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

/**
 * Fetches one candidate job-posting URL and tries JSON-LD extraction first
 * (structured, higher confidence), falling back to the generic Cheerio
 * extractor if no JobPosting schema is present. Returns null if the page
 * can't be fetched or neither strategy finds enough signal — the caller
 * (CareerPageScraper) simply drops that URL, it does not retry with a
 * different strategy.
 */
export async function extractJob(url: string, timeoutMs: number): Promise<RawJobCandidate | null> {
  const page = await fetchPage(url, timeoutMs);
  if (!page) return null;

  return extractJsonLdJobPosting(page.html, url) ?? extractGenericJobPosting(page.html, url);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest job-extractor.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/scraping/job-extractor.ts apps/api/src/scraping/job-extractor.spec.ts
git commit -m "feat(scraping): add JobExtractor orchestrating JSON-LD then generic Cheerio extraction"
```

---

## Task 6: `CareerPageScraper` orchestration

**Files:**
- Create: `apps/api/src/scraping/career-page-scraper.ts`
- Test: Create `apps/api/src/scraping/career-page-scraper.spec.ts`

**Interfaces:**
- Consumes: `fetchPage` (Task 2), `discoverJobLinks` (Task 3), `extractJob` (Task 5), `mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]>` from `apps/api/src/common/async.util.ts` (existing, unchanged)
- Produces: `scrapeCareerPage(careersUrl: string, options: { timeoutMs: number; maxLinks: number; concurrency: number }): Promise<RawJobCandidate[]>` — consumed by Task 7 (`ingest.service.ts` wiring)

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/scraping/career-page-scraper.spec.ts`:

```ts
import { scrapeCareerPage } from './career-page-scraper';
import * as fetcher from './http-page-fetcher';
import * as extractor from './job-extractor';

const OPTIONS = { timeoutMs: 5000, maxLinks: 10, concurrency: 3 };

describe('scrapeCareerPage', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns an empty array if the careers page itself cannot be fetched', async () => {
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue(null);

    const result = await scrapeCareerPage('https://acme.com/careers', OPTIONS);

    expect(result).toEqual([]);
  });

  it('returns an empty array if the careers page has no job-shaped links', async () => {
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue({
      url: 'https://acme.com/careers',
      status: 200,
      contentType: 'text/html',
      html: '<html><body><a href="/about">About</a></body></html>',
    });

    const result = await scrapeCareerPage('https://acme.com/careers', OPTIONS);

    expect(result).toEqual([]);
  });

  it('extracts a candidate for each discovered job link', async () => {
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue({
      url: 'https://acme.com/careers',
      status: 200,
      contentType: 'text/html',
      html: `<html><body>
        <a href="/careers/backend-engineer-1">Backend Engineer</a>
        <a href="/careers/software-developer-2">Software Developer</a>
      </body></html>`,
    });
    jest.spyOn(extractor, 'extractJob').mockImplementation(async (url) => ({
      title: url.includes('backend') ? 'Backend Engineer' : 'Software Developer',
      url,
      companyNameHint: null,
      locationHint: null,
      snippet: 'x'.repeat(50),
      markdown: 'x'.repeat(50),
      source: 'http_scrape',
      postedDateIso: null,
    }));

    const result = await scrapeCareerPage('https://acme.com/careers', OPTIONS);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.title).sort()).toEqual(['Backend Engineer', 'Software Developer']);
  });

  it('drops links whose extraction returns null, without failing the whole scrape', async () => {
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue({
      url: 'https://acme.com/careers',
      status: 200,
      contentType: 'text/html',
      html: `<html><body>
        <a href="/careers/backend-engineer-1">Backend Engineer</a>
        <a href="/careers/broken-link-2">Broken Software Developer Link</a>
      </body></html>`,
    });
    jest.spyOn(extractor, 'extractJob').mockImplementation(async (url) => {
      if (url.includes('broken')) return null;
      return {
        title: 'Backend Engineer',
        url,
        companyNameHint: null,
        locationHint: null,
        snippet: 'x'.repeat(50),
        markdown: 'x'.repeat(50),
        source: 'http_scrape',
        postedDateIso: null,
      };
    });

    const result = await scrapeCareerPage('https://acme.com/careers', OPTIONS);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Backend Engineer');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest career-page-scraper.spec.ts`
Expected: FAIL — `./career-page-scraper` module does not exist yet.

- [ ] **Step 3: Implement `career-page-scraper.ts`**

Create `apps/api/src/scraping/career-page-scraper.ts`:

```ts
import { fetchPage } from './http-page-fetcher';
import { discoverJobLinks } from './job-link-discoverer';
import { extractJob } from './job-extractor';
import { mapWithConcurrency } from '../common/async.util';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

export interface CareerPageScraperOptions {
  timeoutMs: number;
  maxLinks: number;
  concurrency: number;
}

/**
 * Local, non-Firecrawl path for a custom (non-ATS) career page: fetch the
 * page, find links that look like individual job postings, extract each one
 * (bounded concurrency). Returns [] — never throws — if the page can't be
 * fetched or no job-shaped links are found; that [] is exactly the signal
 * IngestService.scrapeCustomCareerPage() uses to fall back to Firecrawl.
 */
export async function scrapeCareerPage(
  careersUrl: string,
  options: CareerPageScraperOptions,
): Promise<RawJobCandidate[]> {
  const page = await fetchPage(careersUrl, options.timeoutMs);
  if (!page) return [];

  const links = discoverJobLinks(page.html, careersUrl, options.maxLinks);
  if (links.length === 0) return [];

  const results = await mapWithConcurrency(links, options.concurrency, (link) =>
    extractJob(link.url, options.timeoutMs),
  );

  return results.filter((r): r is RawJobCandidate => r !== null);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest career-page-scraper.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/scraping/career-page-scraper.ts apps/api/src/scraping/career-page-scraper.spec.ts
git commit -m "feat(scraping): add CareerPageScraper orchestrating fetch, link discovery, and extraction"
```

---

## Task 7: Config, migration, and `IngestService` wiring

**Files:**
- Modify: `apps/api/src/config/configuration.ts`
- Create: `db/migrations/0007_http_scrape_source.sql`
- Modify: `apps/api/src/ingest/ingest.service.ts`
- Test: Modify `apps/api/src/ingest/ingest.service.spec.ts`

**Interfaces:**
- Consumes: `scrapeCareerPage` (Task 6)
- Produces: `IngestService.scrapeCustomCareerPage()` now tries the local scraper before Firecrawl — this is the final task; nothing downstream consumes new interfaces from it

- [ ] **Step 1: Add the `scraping` config section**

In `apps/api/src/config/configuration.ts`, add to the `AppConfig` interface (after the `ingest` block):

```ts
  scraping: {
    httpTimeoutMs: number;
    maxLinksPerCompany: number;
    concurrency: number;
  };
```

And add to the exported default config object (after the `ingest: { ... }` block):

```ts
  scraping: {
    httpTimeoutMs: int('SCRAPING_HTTP_TIMEOUT_MS', 30_000),
    maxLinksPerCompany: int('SCRAPING_MAX_LINKS_PER_COMPANY', 15),
    concurrency: int('SCRAPING_CONCURRENCY', 5),
  },
```

- [ ] **Step 2: Write the migration**

Create `db/migrations/0007_http_scrape_source.sql`:

```sql
-- ===========================================================================
-- 0007_http_scrape_source.sql — allow 'http_scrape' as a job_postings.source
--
-- The new local HTTP/JSON-LD/Cheerio scraper (apps/api/src/scraping/) can
-- now produce job candidates directly, without Firecrawl. See
-- docs/superpowers/specs/2026-10-04-scraper-replacement-design.md.
--
-- Postgres won't let you ALTER a CHECK constraint in place — drop and
-- recreate it, same pattern as 0004_company_discovery.sql's addition of
-- 'ats_api'.
-- ===========================================================================

alter table public.job_postings drop constraint if exists job_postings_source_check;
alter table public.job_postings add constraint job_postings_source_check
  check (source in ('firecrawl_search', 'firecrawl_scrape', 'ats_api', 'http_scrape', 'manual'));
```

This migration must be applied to the live Supabase project before any job with `source: 'http_scrape'` can actually be inserted — flag this to the user the same way the candidate-profile sub-project's migration was handled (do not apply it without explicit confirmation; it's a live-database change).

- [ ] **Step 3: Write the failing test for the fallback-trigger branching**

Read the current `scrapeCustomCareerPage()` implementation first to confirm its exact current form before editing:

Run: `cd apps/api && grep -n "scrapeCustomCareerPage" -A 15 src/ingest/ingest.service.ts`

It should match:

```ts
private async scrapeCustomCareerPage(company: Company, profile: CvProfile): Promise<RawJobCandidate[]> {
  if (!company.careers_url) return [];
  const raw = await this.firecrawl.discoverCompanyJobs(company.careers_url);
  // discoverCompanyJobs already filters "is this a posting at all" and
  // freshness; relevance and location are this app's own gate on top.
  return raw.filter(
    (c) =>
      looksLikeRelevantRole(
        c.title,
        null,
        profile.target_roles,
        profile.excluded_roles,
        profile.excluded_departments,
      ) && isIndiaOrRemote(c.locationHint, profile.preferred_locations),
  );
}
```

If the actual file differs from this (e.g. due to other changes landing on `main` after this plan was written), treat this plan's intent — "try the local scraper first, fall back to Firecrawl only on zero candidates, keep the existing relevance/location filter unchanged" — as authoritative, and adapt the edit to the real current code the same way the candidate-profile sub-project's Task 6 did when its assumptions didn't match the live file.

Since `scrapeCustomCareerPage` is a private method on a class with heavy constructor dependencies (Supabase, Firecrawl, Groq, etc.), it is not unit-tested directly — consistent with this codebase's existing approach of testing extracted pure logic rather than the full `IngestService` class (see `ingest.service.spec.ts`'s existing tests, which only cover `isExcludedCompany`/`filterOutExcludedCompanies`/`describeEmptyProfileWarning`). Add one new pure-logic test that pins the fallback-trigger decision itself, extracted as a tiny standalone predicate:

In `apps/api/src/ingest/ingest.service.spec.ts`, add:

```ts
import { shouldFallBackToFirecrawl } from './ingest.service';

describe('shouldFallBackToFirecrawl', () => {
  it('falls back when the local scraper found zero candidates', () => {
    expect(shouldFallBackToFirecrawl([])).toBe(true);
  });

  it('does not fall back when the local scraper found at least one candidate', () => {
    expect(
      shouldFallBackToFirecrawl([
        {
          title: 'Backend Engineer',
          url: 'https://acme.com/careers/1',
          companyNameHint: null,
          locationHint: null,
          snippet: '',
          markdown: null,
          source: 'http_scrape',
          postedDateIso: null,
        },
      ]),
    ).toBe(false);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd apps/api && npx jest ingest.service.spec.ts -t shouldFallBackToFirecrawl`
Expected: FAIL — `shouldFallBackToFirecrawl` is not exported from `ingest.service.ts` yet.

- [ ] **Step 5: Add the `shouldFallBackToFirecrawl` helper and wire `scrapeCustomCareerPage()`**

In `apps/api/src/ingest/ingest.service.ts`, add the import for the new scraper near the other local imports:

```ts
import { scrapeCareerPage } from '../scraping/career-page-scraper';
```

Add the helper function alongside the other small exported helpers near the bottom of the file (next to `isExcludedCompany`/`filterOutExcludedCompanies`/`describeEmptyProfileWarning`):

```ts
/** A local-scrape result of zero candidates is the trigger to fall back to
 * Firecrawl — pulled out as its own function so the decision itself (not
 * just its consequence) is directly unit-testable without standing up the
 * full IngestService dependency graph. */
export function shouldFallBackToFirecrawl(localCandidates: RawJobCandidate[]): boolean {
  return localCandidates.length === 0;
}
```

Replace `scrapeCustomCareerPage()`'s body:

```ts
private async scrapeCustomCareerPage(company: Company, profile: CvProfile): Promise<RawJobCandidate[]> {
  if (!company.careers_url) return [];

  let raw = await scrapeCareerPage(company.careers_url, {
    timeoutMs: this.config.get<number>('scraping.httpTimeoutMs', 30_000),
    maxLinks: this.config.get<number>('scraping.maxLinksPerCompany', 15),
    concurrency: this.config.get<number>('scraping.concurrency', 5),
  });

  if (shouldFallBackToFirecrawl(raw)) {
    raw = await this.firecrawl.discoverCompanyJobs(company.careers_url);
  }

  // discoverCompanyJobs already filters "is this a posting at all" and
  // freshness; relevance and location are this app's own gate on top.
  // The local scraper's own extractors apply the same bar implicitly (too
  // little signal returns null, dropped before this point).
  return raw.filter(
    (c) =>
      looksLikeRelevantRole(
        c.title,
        null,
        profile.target_roles,
        profile.excluded_roles,
        profile.excluded_departments,
      ) && isIndiaOrRemote(c.locationHint, profile.preferred_locations),
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/api && npx jest ingest.service.spec.ts -t shouldFallBackToFirecrawl`
Expected: PASS (2 tests)

- [ ] **Step 7: Full typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: PASS

- [ ] **Step 8: Full test suite**

Run: `cd apps/api && npm test`
Expected: PASS — every suite from this plan (html.util, http-page-fetcher, job-link-discoverer, json-ld-extractor, cheerio-job-extractor, job-extractor, career-page-scraper, ingest.service) plus every pre-existing suite from the candidate-profile sub-project (text.util, location.util, cv.service) green.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/config/configuration.ts db/migrations/0007_http_scrape_source.sql apps/api/src/ingest/ingest.service.ts apps/api/src/ingest/ingest.service.spec.ts
git commit -m "feat(ingest): try the local career-page scraper before falling back to Firecrawl"
```

- [ ] **Step 10: Flag the pending live-database migration to the user**

This task's migration (`0007_http_scrape_source.sql`) must be applied to the live Supabase project before any `'http_scrape'`-sourced job can actually be inserted (the DB's CHECK constraint would otherwise reject the insert). Do not apply it without asking — present the SQL and ask the user to run it via the Supabase SQL Editor, the same flow used for the candidate-profile sub-project's `0005`/`0006` migrations.

---

## Plan Self-Review Notes

**Spec coverage:** §4 (architecture/orchestration) → Tasks 2, 3, 5, 6. §5 (all 6 new files) → Tasks 2-6 one-to-one. §6 (`RawJobCandidate` extension) → Task 4 Step 1. §7 (shared `stripHtml`) → Task 1. §8 (config) → Task 7 Step 1. §9 (`IngestService` wiring) → Task 7 Steps 3-5. §10 (cheerio dependency) → Task 3 Step 1. §11 (testing) → every task's fixture/mock-based tests, explicitly no live network calls anywhere. §12's acceptance table is satisfied as scoped (Playwright/extraction-confidence explicitly deferred, matching the spec's own statement).

**Type consistency:** `RawJobCandidate` (Task 4) is the exact same interface imported and returned by `json-ld-extractor.ts`, `cheerio-job-extractor.ts`, `job-extractor.ts`, and `career-page-scraper.ts` — no field renaming across tasks. `FetchedPage` (Task 2) is consumed identically by `job-extractor.ts` (Task 5) and `career-page-scraper.ts` (Task 6, via `fetchPage` directly). `DiscoveredLink` (Task 3) is consumed identically by `career-page-scraper.ts` (Task 6).

**Review Focus coverage:** all 5 items map to specific pinned tests — non-JobPosting/malformed JSON-LD (Task 4's `json-ld-extractor.spec.ts`, 2 dedicated tests), zero-job-links page (Task 6's `career-page-scraper.spec.ts`, "returns an empty array if the careers page has no job-shaped links"), fetch timeout/error → null not throw (Task 2's `http-page-fetcher.spec.ts`, 3 dedicated tests for 503-retry-exhaustion, 404-no-retry, and network-error-throw), non-HTML content-type (Task 2's dedicated test).
