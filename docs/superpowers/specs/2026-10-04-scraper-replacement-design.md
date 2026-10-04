# Sub-project 2: Scraper Replacement — Design Spec

**Parent document:** [job_search_automation_spec.md](../../../job_search_automation_spec.md) §12 (ScraperModule), §29-31 (SourceRouter, GenericCareerPageScraper, JobExtractor)
**Status:** Approved for implementation planning
**Scope:** Backend only — a new local scraping layer for custom (non-ATS) career pages, tried before the existing Firecrawl fallback. No Playwright, no sitemap discovery, no site-specific adapters.

---

## 1. Problem

Today, every non-ATS company's career page is scraped exclusively via `FirecrawlService.discoverCompanyJobs()` ([firecrawl.service.ts](../../../apps/api/src/firecrawl/firecrawl.service.ts)) — a paid API call (`/map` + `/scrape` per job link) for every single custom career page, every run. The parent spec's audit baseline (§1) flagged this as the thing ADR-001 targets: "Use native HTTP + Cheerio + Playwright and keep Firecrawl only as a temporary compatibility/fallback adapter during migration."

This sub-project builds that local scraper for the three tiers that don't require a browser (native HTTP, JSON-LD, generic Cheerio selectors) and wires it in **ahead of** Firecrawl, which becomes the fallback for sites the local scraper can't handle (typically JS-rendered career pages). Playwright (Tier 4, for JS rendering) is explicitly deferred — see §3.

## 2. Goal

For a company with a custom `careers_url` and no ATS match, try a local HTTP-based scraper first. Only fall back to `FirecrawlService.discoverCompanyJobs()` if the local scraper returns zero candidates. The output type (`RawJobCandidate[]`) and everything downstream of it (relevance/location filtering in `scrapeCustomCareerPage()`, dedup, insertion) stays exactly as it is today — this sub-project only changes *how* candidates are gathered for the non-ATS, custom-page path, matching the parent spec's §29 principle that "Firecrawl can disappear without changing ingestion orchestration."

## 3. Non-goals

- **No Playwright / JS-rendering tier.** A site whose job content only appears after JS execution will produce zero candidates from the local scraper and fall through to Firecrawl (which already handles JS-rendered pages) — this is an accepted, not a workaround, outcome for this sub-project. Playwright is deferred to a later increment once real usage shows how many companies actually need it.
- **No sitemap.xml discovery.** Job links are found only by parsing `<a href>` tags on the careers page itself, per the explicit decision in brainstorming. A career page whose job list is paginated or loaded only via sitemap (not linked from the page itself) will under-discover locally and fall through to Firecrawl.
- **No site-specific extractor adapters.** One generic Cheerio extractor (title + main-content selectors) serves every non-JSON-LD site. A site that produces too little signal returns `null` from the extractor rather than garbage, and that URL is simply skipped — not retried with a smarter heuristic.
- **No change to ATS handling.** `scrapeAtsCompany()` and the Greenhouse/Lever/Ashby adapters are untouched.
- **No source-reliability scoring, no retrieval scoring.** That's explicitly sub-project 3 territory per the parent spec's §16/§41.
- **No change to `RawJobCandidate`'s shape** or to the relevance/location filtering already applied in `scrapeCustomCareerPage()`.

## 4. Architecture

```
scrapeCustomCareerPage(company, profile)
  │
  ├─► CareerPageScraper.scrape(company.careers_url)      [NEW]
  │     │
  │     ├─► HttpPageFetcher.fetch(careersUrl)             [NEW] — GET, timeout, retry on 429/5xx
  │     │     └─► null if fetch fails after retries, or content-type isn't HTML
  │     │
  │     ├─► JobLinkDiscoverer.discover(html, baseUrl)      [NEW] — <a href> + looksLikeJobPosting()
  │     │     └─► candidate links, capped at maxLinksPerCompany
  │     │
  │     └─► for each link (bounded concurrency via mapWithConcurrency):
  │           JobExtractor.extract(link.url)               [NEW]
  │             ├─► HttpPageFetcher.fetch(link.url)
  │             ├─► JsonLdJobExtractor.extract(html)        [NEW] — <script type="application/ld+json">, @type JobPosting
  │             │     └─► RawJobCandidate | null
  │             └─► else CheerioJobExtractor.extract(html, url) [NEW] — generic h1/main/article selectors
  │                   └─► RawJobCandidate | null
  │
  ├─► if CareerPageScraper returned 0 candidates:
  │     FirecrawlService.discoverCompanyJobs(company.careers_url)   [EXISTING, unchanged]
  │
  └─► raw.filter(looksLikeRelevantRole(...) && isIndiaOrRemote(...))  [EXISTING, unchanged]
```

## 5. New files

All under `apps/api/src/scraping/`, following the parent spec's §47 repository structure guidance (adapted to this repo's existing flat-per-concern layout rather than the deeper `fetchers/extractors/parsers` subfolder split, since the file count here doesn't yet justify that nesting):

### `http-page-fetcher.ts`

```ts
export interface FetchedPage {
  url: string;
  status: number;
  contentType: string | null;
  html: string;
}

export async function fetchPage(url: string, timeoutMs: number): Promise<FetchedPage | null>
```

- Plain `fetch()` with an `AbortController`-driven timeout (no new dependency — `fetch` is already globally available in the Node version this repo targets, same as `FirecrawlService`'s own raw `fetch` calls).
- Sets a realistic `User-Agent` header (a generic recent-browser string) — many career-page CDNs/WAFs block requests with no UA or an obviously-bot UA.
- Wrapped in the existing `retry()` util ([async.util.ts](../../../apps/api/src/common/async.util.ts)), retrying only on network errors and 429/5xx, matching `FirecrawlService.request()`'s existing pattern exactly (3 attempts, 1s base delay).
- Rejects (returns `null`) if `content-type` doesn't start with `text/html` — a PDF or JSON response isn't something the Cheerio/JSON-LD extractors can use.
- Caps response size at 5MB (read via a streamed byte-count guard) to avoid a pathological page exhausting memory; returns `null` if exceeded.
- Returns `null` (never throws) on any unrecoverable failure — callers treat `null` as "try the next thing," consistent with how `FirecrawlService.scrapePage()` already returns `null` rather than throwing.

### `job-link-discoverer.ts`

```ts
export interface DiscoveredLink {
  url: string;
  text: string;
}

export function discoverJobLinks(html: string, baseUrl: string, maxLinks: number): DiscoveredLink[]
```

- Loads `html` into Cheerio, selects every `a[href]`, resolves relative URLs against `baseUrl` (via the `URL` constructor — `new URL(href, baseUrl)`), and keeps only links whose `(text, url)` pass the existing `looksLikeJobPosting()` from [text.util.ts](../../../apps/api/src/common/text.util.ts) — reused as-is, no new heuristic.
- De-duplicates by canonical URL (reusing `canonicalizeUrl()` from [url.util.ts](../../../apps/api/src/common/url.util.ts)) before truncating to `maxLinks`, so near-duplicate links (tracking params, trailing slash) don't each consume a slot.

### `json-ld-extractor.ts`

```ts
export function extractJsonLdJobPosting(html: string, sourceUrl: string): RawJobCandidate | null
```

- Loads `html` into Cheerio, iterates every `<script type="application/ld+json">`, `JSON.parse`s each (skipping any that fail to parse — malformed JSON-LD on a career page is common and not fatal), and looks for an object (or one entry of a `@graph` array) whose `@type` is `"JobPosting"` (case-insensitive, and handling `@type` as either a string or an array per the JSON-LD spec).
- Maps fields: `title` → `title`, `description` (HTML-stripped, reusing the existing `stripHtml()` pattern already present in [ats-clients.ts](../../../apps/api/src/discovery/ats-clients.ts) — extracted into a shared helper, see §7) → `markdown`/`snippet`, `datePosted` → `postedDateIso` (parsed via the existing `parsePostedDate()`/`toDateOnlyIso()` from [date.util.ts](../../../apps/api/src/common/date.util.ts)), `jobLocation.address.addressLocality` or `jobLocation` as a plain string → `locationHint`, `hiringOrganization.name` → `companyNameHint`.
- Returns `null` if no `JobPosting`-typed block is found, or if the found block has no usable `title`.
- Sets `source: 'http_scrape'` on the returned `RawJobCandidate` (see §6 for the type extension).

### `cheerio-job-extractor.ts`

```ts
export function extractGenericJobPosting(html: string, sourceUrl: string): RawJobCandidate | null
```

- Minimal, generic, per the brainstorming decision: `title` from the first non-empty of `h1`, then `<title>`; `description` from the first non-empty of `main`, `article`, `[role="main"]`, falling back to `body` text as a last resort.
- Returns `null` if the resulting title is empty/too short (`< 3` chars, matching the existing bar in `FirecrawlService.scrapePage()`) or the description text is under 100 characters — too little signal is treated as "couldn't extract," not forced into a low-quality candidate, consistent with the brainstorming decision to let thin signal fall through to Firecrawl rather than invent structure.
- `locationHint` via the existing `extractLocation()` from [text.util.ts](../../../apps/api/src/common/text.util.ts), applied to the extracted description text (same function already used by `FirecrawlService.scrapePage()`).
- Sets `source: 'http_scrape'`.

### `job-extractor.ts`

```ts
export async function extractJob(url: string, timeoutMs: number): Promise<RawJobCandidate | null>
```

Orchestrates: fetch the URL via `fetchPage()`; if that fails, return `null`; else try `extractJsonLdJobPosting()`, and if that returns `null`, try `extractGenericJobPosting()`; return whichever succeeds first, or `null` if both fail.

### `career-page-scraper.ts`

```ts
export async function scrapeCareerPage(
  careersUrl: string,
  options: { timeoutMs: number; maxLinks: number; concurrency: number },
): Promise<RawJobCandidate[]>
```

Orchestrates: `fetchPage(careersUrl)` → if `null`, return `[]`; `discoverJobLinks(html, careersUrl, maxLinks)` → `mapWithConcurrency(links, concurrency, (link) => extractJob(link.url, timeoutMs))` → filter out `null`s and return the surviving `RawJobCandidate[]`.

These are plain exported functions, not injectable NestJS services with constructor DI — there's no state or configuration they need beyond their function parameters, and the parent spec's own pseudocode (§30, §31) models them the same way. `IngestService` calls them directly as imported functions, the same pattern it already uses for `fetchAtsJobs()` from [ats-clients.ts](../../../apps/api/src/discovery/ats-clients.ts).

## 6. `RawJobCandidate` extension

[firecrawl.types.ts](../../../apps/api/src/firecrawl/firecrawl.types.ts)'s `source` field widens:

```ts
// Before
source: 'firecrawl_scrape' | 'ats_api';

// After
source: 'firecrawl_scrape' | 'ats_api' | 'http_scrape';
```

This also requires widening the `job_postings.source` CHECK constraint in a new migration (`0007_http_scrape_source.sql`), following the exact pattern `0004_company_discovery.sql` used to add `'ats_api'`:

```sql
alter table public.job_postings drop constraint if exists job_postings_source_check;
alter table public.job_postings add constraint job_postings_source_check
  check (source in ('firecrawl_search', 'firecrawl_scrape', 'ats_api', 'http_scrape', 'manual'));
```

And the shared `JobSource` enum in [enums.ts](../../../packages/shared/src/enums.ts) gains `'http_scrape'`.

## 7. Shared helper extraction

`stripHtml()` currently lives as a private function in [ats-clients.ts](../../../apps/api/src/discovery/ats-clients.ts) (used to clean Greenhouse's HTML `content` field). It moves to `apps/api/src/common/html.util.ts` (new file) and is exported, so both `ats-clients.ts` and the new `json-ld-extractor.ts` import the same implementation instead of duplicating it. `ats-clients.ts`'s own call site updates its import; its behavior is unchanged (this is a pure extraction, not a rewrite).

## 8. Config additions

[configuration.ts](../../../apps/api/src/config/configuration.ts) gains a `scraping` section:

```ts
scraping: {
  httpTimeoutMs: int('SCRAPING_HTTP_TIMEOUT_MS', 30_000),  // matches Firecrawl's existing 30s
  maxLinksPerCompany: int('SCRAPING_MAX_LINKS_PER_COMPANY', 15),  // matches today's FIRECRAWL_MAP_LIMIT default
  concurrency: int('SCRAPING_CONCURRENCY', 5),  // per parent spec §3.2's suggested httpConcurrency
},
```

## 9. `IngestService` wiring

[ingest.service.ts](../../../apps/api/src/ingest/ingest.service.ts)'s `scrapeCustomCareerPage()` changes from:

```ts
private async scrapeCustomCareerPage(company: Company, profile: CvProfile): Promise<RawJobCandidate[]> {
  if (!company.careers_url) return [];
  const raw = await this.firecrawl.discoverCompanyJobs(company.careers_url);
  return raw.filter(/* existing relevance/location filter, unchanged */);
}
```

to:

```ts
private async scrapeCustomCareerPage(company: Company, profile: CvProfile): Promise<RawJobCandidate[]> {
  if (!company.careers_url) return [];

  let raw = await scrapeCareerPage(company.careers_url, {
    timeoutMs: this.config.get('scraping.httpTimeoutMs'),
    maxLinks: this.config.get('scraping.maxLinksPerCompany'),
    concurrency: this.config.get('scraping.concurrency'),
  });

  if (raw.length === 0) {
    raw = await this.firecrawl.discoverCompanyJobs(company.careers_url);
  }

  return raw.filter(/* existing relevance/location filter, unchanged */);
}
```

No change to `scrapeResolvedCompanies()`, `scrapeAtsCompany()`, `discoverCompanies()`, `run()`, or any downstream dedup/insertion logic — the seam is exactly where the parent spec's §29 `SourceRouter` concept says it should be.

## 10. New dependency

`cheerio` (the HTML-parsing library the parent spec names throughout §12). Added to `apps/api/package.json` dependencies. No other new runtime dependencies — `fetch`, `AbortController`, and `URL` are all already available globally in this repo's target Node version (confirmed via `FirecrawlService`'s existing raw `fetch()` usage).

## 11. Testing

Per the parent spec's §46 fixture-based testing guidance:

- **Fixtures** (`apps/api/src/scraping/__fixtures__/`): a career-listing page with several `<a>` links (mix of real job links and noise — nav links, a blog link, a privacy-policy link) for `job-link-discoverer.spec.ts`; a job-posting page with valid `JobPosting` JSON-LD for `json-ld-extractor.spec.ts`; a job-posting page with no JSON-LD but a clear `<h1>`/`<main>` structure for `cheerio-job-extractor.spec.ts`; a page with neither (e.g. a generic "life at our company" page) to confirm both extractors correctly return `null` rather than garbage.
- **`http-page-fetcher.spec.ts`**: mocks global `fetch` (via `jest.spyOn(global, 'fetch')`, the same technique already implicit in how `FirecrawlService`'s tests would need to work, since this repo makes no live network calls in its test suite) to verify timeout behavior, the 429/5xx retry path (reusing the existing `retry()` util, already covered by its own correctness), and the content-type/size-limit rejections — no real HTTP calls in the test suite, consistent with this repo having zero network-touching tests today.
- **`career-page-scraper.spec.ts`**: an integration-style unit test wiring a mocked `fetchPage` through the full orchestration (discover links → extract each → aggregate), confirming the zero-candidates-triggers-Firecrawl-fallback behavior is testable at the `IngestService` call site (a thin test on `scrapeCustomCareerPage`'s branching logic, with `scrapeCareerPage` and `firecrawl.discoverCompanyJobs` both mocked — mirroring how `ingest.service.spec.ts` already tests pure/extracted logic rather than the full `run()` pipeline).
- No live Firecrawl/network smoke test is prescribed in this spec the way sub-project 1's plan required one — this sub-project's correctness is fully verifiable through fixtures and mocks, and a live smoke test (triggering a real ingestion run) remains available as a manual post-implementation check the same way it was for sub-project 1, at the user's discretion.

## 12. Acceptance criteria (mapped to parent spec)

| Parent spec criterion (§50) | How this sub-project satisfies it |
|---|---|
| "Static custom pages can be parsed without browser automation" | `CareerPageScraper` (HTTP + JSON-LD + Cheerio), no browser |
| "One broken site does not stop ingestion" | `fetchPage()`/`extractJob()` return `null`/`[]` on failure, never throw; `scrapeResolvedCompanies()`'s existing per-company try/catch is unchanged and still the outer safety net |
| "JS-rendered pages can fall back to Playwright" | Explicitly deferred (§3) — this sub-project's JS-rendered fallback is Firecrawl, not Playwright, which already handles JS rendering today |
| "Source and extraction confidence are retained" | Partially — the new `'http_scrape'` source value distinguishes local-scrape from Firecrawl/ATS origin; a numeric extraction-confidence score (parent spec §13.3's `extractionConfidence` field) is out of scope here, deferred to sub-project 3's canonical job model |

## 13. Files touched

- `apps/api/src/scraping/http-page-fetcher.ts` (new)
- `apps/api/src/scraping/job-link-discoverer.ts` (new)
- `apps/api/src/scraping/json-ld-extractor.ts` (new)
- `apps/api/src/scraping/cheerio-job-extractor.ts` (new)
- `apps/api/src/scraping/job-extractor.ts` (new)
- `apps/api/src/scraping/career-page-scraper.ts` (new)
- `apps/api/src/scraping/__fixtures__/*.html` (new, 4 fixture files)
- `apps/api/src/scraping/*.spec.ts` (new, 6 test files matching the 6 new source files)
- `apps/api/src/common/html.util.ts` (new — `stripHtml()` extracted from `ats-clients.ts`)
- `apps/api/src/discovery/ats-clients.ts` (modified — import `stripHtml` from the new shared location instead of defining it locally)
- `apps/api/src/firecrawl/firecrawl.types.ts` (modified — `RawJobCandidate.source` widened)
- `packages/shared/src/enums.ts` (modified — `JOB_SOURCES` gains `'http_scrape'`)
- `apps/api/src/config/configuration.ts` (modified — new `scraping` config section)
- `apps/api/src/ingest/ingest.service.ts` (modified — `scrapeCustomCareerPage()` tries the new scraper first)
- `apps/api/package.json` (modified — add `cheerio` dependency)
- `db/migrations/0007_http_scrape_source.sql` (new)
