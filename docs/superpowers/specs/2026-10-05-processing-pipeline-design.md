# Sub-project 3: Processing Pipeline — Design Spec

**Parent document:** [job_search_automation_spec.md](../../../job_search_automation_spec.md) §13 (normalization), §14 (deduplication), §15 (eligibility), §16 (retrieval scoring / Top-N)
**Status:** Approved for implementation planning
**Scope:** Backend only. New pure pipeline stages between scraping and Groq, one migration, profile-default trim. No change to Groq's prompt/output, final ranking, or the dashboard's sort (all sub-project 4).

---

## 1. Problem

Three defects in today's ingest flow ([ingest.service.ts](../../../apps/api/src/ingest/ingest.service.ts)) cost real jobs or waste Groq quota:

1. **`target_roles` is a hard allow-list.** `looksLikeRelevantRole()` drops any title without one of the 18 configured keywords before scoring. "Member of Technical Staff", "Engineer II", "Product Engineer", "Founding Engineer" never reach Groq. Adjacent roles (Platform/DevOps/SRE/Data Engineer) are additionally hard-rejected via the seeded `excluded_roles`.
2. **Groq scores the first 40 inserted jobs, not the best 40.** `run()` does `inserted.slice(0, maxAnalyses)`. Anything past 40 is never scored on any later run either, because it is no longer "new".
3. **Dedup merges distinct jobs.** The unique index `job_postings_user_company_title_key (user_id, company_id, title_normalized)` collapses "Backend Engineer — Bangalore" and "Backend Engineer — Pune" into one row. ATS job IDs (Greenhouse/Lever/Ashby all expose one) are never stored.

The candidate profile's `seniority_min_years` / `seniority_max_years` (added in sub-project 1) are also stored but unused.

## 2. Goal

Insert a deterministic pipeline after scraping: **normalize → eligibility (hard rejects only) → cheap retrieval score → floor → dedup/insert → Top-N to Groq**. Recall goes up (borderline engineering roles reach scoring), Groq spends its budget on the highest-scoring jobs across this run *and* the backlog of saved-but-never-analyzed jobs, and distinct requisitions stop being merged.

## 3. Decisions (made with the user during brainstorming)

| Question | Decision |
|---|---|
| What happens to eligible jobs outside the Groq Top-N? | Saved **only if** their cheap score clears a floor (default 40). Saved-but-unanalyzed jobs stay in a backlog that competes for Groq slots on future runs. Below-floor jobs are not saved; they are re-evaluated whenever they are seen again. |
| `excluded_roles` | Stays a hard reject, but the adjacent engineering roles are removed from both live profiles and `DEFAULT_CV` so they reach scoring. |
| Seniority | Hard-reject only clearly impossible roles (years required > experience + 3, or > `seniority_max_years` when set; leadership/intern titles). Senior and fresher roles are scored lower, not rejected. |

## 4. Non-goals

- No change to `AnalysisService`, its prompt, or `skill_gap_analysis`'s shape.
- No final weighted ranking, recommendation bands, or dashboard default-sort change.
- No content-hash dedup (parent spec §14.3 calls it a weak fallback; YAGNI).
- No `first_seen_at` / `last_seen_at` tracking.
- No configurable weights in the database — weights live in one exported constants object.
- No API exposure of the retrieval score (`JobListItem` is unchanged). The score is stored and in the enriched view for sub-project 4 to consume.

## 5. Architecture

Pure functions in a new `apps/api/src/pipeline/` folder, called from `IngestService.run()` — the same pattern sub-project 2 used for `apps/api/src/scraping/`. No NestJS DI: every stage is a function of its inputs plus the profile/context passed in.

```
scrapeResolvedCompanies()        (ATS path no longer filters; custom path still
   → CompanyScopedCandidate[]     uses eligibility for its Firecrawl-fallback decision)
normalizeCandidate()             → NormalizedJob
evaluateEligibility()            → { eligible: true } | { eligible: false, reason }
scoreRetrieval()                 → { score: 0..100, signals }
floor                            → score >= ingest.retrievalFloor
order by score desc
dedupAndInsert()                 → in-run dedup by url_hash / externalId,
                                   DB check by url_hash, cap maxNewJobsPerRun,
                                   insert with retrieval_score / signals / external_id
buildAnalysisPool()              → backlog query (includes this run's inserts),
                                   score rows missing a retrieval_score,
                                   order by score desc, take maxAnalysesPerRun
analyzeAndPersist()              (unchanged)
```

## 6. New and changed types

### `RawJobCandidate` ([firecrawl.types.ts](../../../apps/api/src/firecrawl/firecrawl.types.ts)) — two optional fields

```ts
/** Stable job ID from the source ATS (Greenhouse/Lever/Ashby). Absent for scraped pages. */
externalId?: string | null;
/** ATS-provided department(s), comma-joined. Absent for scraped pages. */
department?: string | null;
```

Optional so the Firecrawl, JSON-LD and Cheerio constructors need no change.

### `AtsJobListing` ([ats-clients.ts](../../../apps/api/src/discovery/ats-clients.ts))

Gains `externalId: string | null`, mapped from Greenhouse `id` (number → string), Lever `id`, Ashby `id`.

### `NormalizedJob` (new, `pipeline/normalize.ts`)

```ts
export interface NormalizedJob {
  candidate: RawJobCandidate;
  companyId: string;
  companyName: string;
  title: string;                 // trimmed, whitespace-collapsed
  description: string;           // normalizeWhitespace(markdown ?? snippet ?? '')
  location: string | null;       // trimmed, empty -> null
  isRemote: boolean;             // location or description says remote/wfh
  requiredYearsMin: number | null;
  mentionedSkills: string[];     // canonical slugs from the shared skill list
  externalId: string | null;
  department: string | null;
  urlHash: string;               // urlHash(candidate.url)
}
```

## 7. Normalization rules (`pipeline/normalize.ts`)

### `parseRequiredYears(text): number | null`

Scans the first 4000 characters. Recognised phrasings, each yielding a lower bound:

| Phrase | Lower bound |
|---|---|
| `3+ years`, `3 + yrs`, `3+ yrs of experience` | 3 |
| `2-4 years`, `2 – 4 years`, `2 to 4 years` | 2 |
| `minimum 3 years`, `minimum of 3 years`, `at least 3 years` | 3 |
| `3 years of experience`, `3 years experience`, `3 yrs exp` | 3 |

Rules: numbers greater than 20 are ignored (company age, "20+ years in business"); a bare `N years` with no `+`, no range, and no `experience`/`exp` within the next 40 characters is ignored; when several are found, return the **maximum** lower bound (the role's overall requirement, e.g. "5+ years experience, 2+ years with Kafka" → 5). No match → `null`.

### `extractMentionedSkills(text): string[]`

Word-bounded, case-insensitive scan for every `SEED_SKILLS` canonical name and alias from [packages/shared/src/skills.ts](../../../packages/shared/src/skills.ts). Canonical slug hyphens match a space or hyphen (`rest-api` matches "REST API" and "rest-api"). Ambiguous English words are never matched on their own: `go`, `rest`, `express`, `spring`, `nest`, `node`, `ts`, `js`, `py` (their unambiguous forms — `golang`, `restful`, `express.js`, `spring boot`, `nest.js`, `node.js` — still match). Returns de-duplicated canonical slugs.

### Location and remote

`location` = trimmed `candidate.locationHint`, empty → `null`. `isRemote` = location or the first 1500 characters of the description matches `remote`, `work from home`, `wfh`, `fully distributed`.

## 8. Eligibility (`pipeline/eligibility.ts`)

`evaluateEligibility(job: NormalizedJob, profile: CvProfile): EligibilityResult`, checks in this order, first failure wins:

| Reason code | Rule |
|---|---|
| `excluded_department` | `department` contains (word-bounded) any `profile.excluded_departments` entry |
| `excluded_role` | title contains any `profile.excluded_roles` entry |
| `leadership_or_intern` | title contains `staff` (except in "technical staff"), `principal`, `director`, `head of`, `vp`, `vice president`, `manager`, `architect`, `intern`, `internship` |
| `non_engineering_title` | title matches neither a `profile.target_roles` entry nor a generic engineering marker: `engineer`, `engineering`, `developer`, `development`, `sde`, `swe`, `programmer`, `technical staff`, `mts` |
| `experience_too_high` | `requiredYearsMin` > ceiling, where ceiling = `profile.seniority_max_years` if set, else `profile.experience_years + 3` if `experience_years` is set; skipped when both are null |
| `location_mismatch` | `location` is non-null and `isIndiaOrRemote(location, profile.preferred_locations)` is false |

A job with `location === null` passes (behavior change: it used to be rejected).

Word matching reuses `containsWord()` from [text.util.ts](../../../apps/api/src/common/text.util.ts), exported for this purpose (it already treats blank markers as never-matching).

`looksLikeRelevantRole()` is removed once its two call sites are replaced; its tests go with it.

## 9. Retrieval score (`pipeline/retrieval-score.ts`)

`scoreRetrieval(job: NormalizedJob, ctx: ScoringContext): RetrievalResult`

```ts
export interface ScoringContext {
  profile: CvProfile;
  cvSkillNames: string[];        // canonical slugs from cv_skills
  now: Date;
}
export interface RetrievalSignals {
  role: number; skills: number; experience: number;
  location: number; freshness: number; source: number;
  requiredYearsMin: number | null;
  mentionedSkills: string[];
  matchedSkills: string[];
}
export interface RetrievalResult { score: number; signals: RetrievalSignals; }
```

Weights live in `RETRIEVAL_WEIGHTS = { role: 25, skills: 35, experience: 20, location: 10, freshness: 5, source: 5 }`.

| Part | Rule |
|---|---|
| role (25) | title matches a `target_roles` entry → 25; else generic engineering marker → 12 (eligibility guarantees one of the two) |
| skills (35) | `J` = mentionedSkills, `C` = cvSkillNames. `J` empty → 14. Else `round(35 × min(1, |J ∩ C| / max(|J|, 4)))` |
| experience (20) | `exp` = `profile.experience_years`, `req` = requiredYearsMin. Evaluated in this order: (1) title contains `fresher`/`graduate`/`entry level`/`junior` and `exp` ≥ 2 → 10; (2) `exp` null or `req` null → 12, or 8 if the title contains `senior`/`sr`; (3) `req ≤ exp` → 20, `≤ exp+1` → 15, `≤ exp+2` → 9, `≤ exp+3` → 4, otherwise 0 |
| location (10) | `isRemote` or `location` is a preferred location → 10; `location` null → 5 |
| freshness (5) | from `candidate.postedDateIso`: ≤ 3 days → 5, ≤ 7 → 4, ≤ 14 → 2, older → 0, missing/unparseable → 3 |
| source (5) | `ats_api` → 5, `http_scrape` → 4, `firecrawl_scrape` → 3, anything else → 3 |

`score` = sum, an integer 0–100.

## 10. Selection (`pipeline/select.ts`)

- `applyFloor(scored, floor)` keeps entries with `score >= floor`.
- `orderByScore(scored)` sorts descending, ties broken by fresher `postedDateIso`, then title.
- `selectTopN(pool, n)` = `orderByScore(pool).slice(0, n)`.

## 11. Firecrawl fallback (sub-project 2 guarantee preserved)

`scrapeCustomCareerPage()` keeps its freshness filter and its "credible candidates" rule, but credible now means **passes `evaluateEligibility`** (which, through `non_engineering_title`, already excludes "Life at Acme"-style junk). It returns the fresh local results when any are credible, otherwise Firecrawl's results — unfiltered; eligibility is applied once, uniformly, in `run()`. `shouldFallBackToFirecrawl()` keeps its signature and meaning (empty credible list → fall back).

`scrapeAtsCompany()` stops filtering and maps every listing, carrying `externalId` and `department`.

## 12. Storage — migration `db/migrations/0008_processing_pipeline.sql`

```sql
alter table public.job_postings
  add column if not exists external_id text,
  add column if not exists retrieval_score integer check (retrieval_score between 0 and 100),
  add column if not exists retrieval_signals jsonb,
  add column if not exists location_normalized text generated always as (lower(btrim(location))) stored;

drop index if exists public.job_postings_user_company_title_key;
create unique index if not exists job_postings_user_company_title_location_key
  on public.job_postings (user_id, company_id, title_normalized, coalesce(location_normalized, ''))
  where company_id is not null;

create unique index if not exists job_postings_user_company_external_id_key
  on public.job_postings (user_id, company_id, external_id)
  where external_id is not null and company_id is not null;

create index if not exists job_postings_retrieval_score_idx
  on public.job_postings (user_id, retrieval_score desc);

-- Trim adjacent engineering roles out of excluded_roles (decision §3).
update public.cv_profile
set excluded_roles = coalesce((
  select jsonb_agg(r)
  from jsonb_array_elements_text(excluded_roles) as r
  where r not in ('platform engineer', 'devops engineer', 'site reliability',
                  'data engineer', 'security engineer', 'solutions engineer',
                  'ml engineer', 'machine learning engineer', 'ai engineer')
), '[]'::jsonb);
```

Plus `create or replace view public.job_postings_enriched` with `j.external_id, j.retrieval_score, j.retrieval_signals` appended as the last columns (Postgres only allows appending), followed by `alter view public.job_postings_enriched set (security_invoker = true)` again.

The new title+location index is strictly finer than the old title-only one, so every existing row stays unique under it. The migration is idempotent. **It is applied manually by the user** in the Supabase SQL Editor, like 0005–0007; implementers create the file only.

`DEFAULT_CV.excludedRoles` ([default-cv.ts](../../../apps/api/src/cv/default-cv.ts)) drops the same nine entries.

## 13. Config

[configuration.ts](../../../apps/api/src/config/configuration.ts) `ingest` section gains:

```ts
retrievalFloor: int('INGEST_RETRIEVAL_FLOOR', 40),
analysisBacklogDays: int('INGEST_ANALYSIS_BACKLOG_DAYS', 30),
```

`maxAnalysesPerRun` (40) and `maxNewJobsPerRun` (100) keep their meaning; `maxNewJobsPerRun` now caps the highest-scoring new jobs rather than the first ones found.

## 14. `IngestService.run()` wiring

1. Load `{ profile, skills }` from `CvService.getSnapshot()`; `cvSkillNames = skills.map(s => s.name)`.
2. Scrape (as above).
3. `normalizeCandidate` every candidate; `evaluateEligibility`; tally rejections by reason.
4. `scoreRetrieval` every eligible job; `applyFloor`; tally below-floor count; `orderByScore`.
5. `dedupAndInsert` takes the ordered `ScoredJob[]`, dedups in-run by `urlHash` and by `companyId + externalId`, checks the DB by `url_hash`, keeps the first `maxNewJobsPerRun`, and inserts with `external_id`, `retrieval_score`, `retrieval_signals`. A 23505 from either unique index stays a benign duplicate.
6. `buildAnalysisPool`: query `job_postings_enriched` for this user where `match_score is null`, `status = 'new'`, `scraped_at >= now - analysisBacklogDays`, limit 200, selecting `id, company_id, title, company_name, location, url, description_raw, posted_date, source, retrieval_score, retrieval_signals`. Rows with `retrieval_score is null` (saved before this migration) are normalized from their stored fields, scored, and their score written back. Order by score, take `maxAnalysesPerRun`, map to `InsertedJob`, analyze as today.

`IngestRunSummary` ([types.ts](../../../packages/shared/src/types.ts)) gains:

```ts
candidates_eligible: number;
candidates_below_floor: number;
rejection_reasons: Record<string, number>;
analysis_pool_size: number;
```

Existing fields keep their meaning (`candidates_found` = raw scraped count).

## 15. Testing

Fixture/in-memory unit tests, no network:

- `normalize.spec.ts` — every phrasing in §7's table, the >20 and bare-number exclusions, max-lower-bound selection, skill scan incl. ambiguous words (`"go to market"` → no `go`; `"golang"` → `go`), remote detection.
- `eligibility.spec.ts` — one test per reason code, plus: "Member of Technical Staff" eligible, "Internal Tools Engineer" eligible (not `intern`), null location eligible, both seniority fields null → no years rejection.
- `retrieval-score.spec.ts` — each part's boundaries, total for a strong and a weak job.
- `select.spec.ts` — floor, ordering, tie-breaks, N cap.
- `pipeline.spec.ts` — **composition test**: realistic candidates (a strong Backend Engineer, an MTS role, a Platform Engineer, a Staff Engineer, a "Life at Acme" page, a San Francisco role, a 7+-years role, a same-title-different-city pair) run through the real normalize → eligibility → score → floor → order with no mocked stage, asserting exactly which survive and in what order.
- `ingest.service.spec.ts` — `buildAnalysisPool`'s pure merge/score/order helper and the rejection tally helper.
- `ats-clients.spec.ts` — `externalId` mapped for each ATS (mocked `fetch`).

## 16. Acceptance criteria (parent spec §50 subset)

| Criterion | Satisfied by |
|---|---|
| Same job not inserted repeatedly | url_hash (unchanged) + external_id unique index |
| Same title in different locations not merged | title+location unique index replaces title-only |
| Missing date does not become a fake date | freshness treats missing as neutral, never synthesizes a date |
| Hard eligibility is deterministic | §8, pure function with reason codes |
| Borderline technical roles reach ranking | `target_roles` no longer gates; adjacent roles removed from `excluded_roles` |
| Analyze Top-N instead of first N inserted | §10 + §14 step 6 |
| "Why did I get only 12 jobs?" answerable | `rejection_reasons`, `candidates_below_floor` in the run summary |

## 17. Files touched

- `apps/api/src/pipeline/normalize.ts`, `eligibility.ts`, `retrieval-score.ts`, `select.ts` (new) + specs, `pipeline.spec.ts` (new)
- `apps/api/src/firecrawl/firecrawl.types.ts` (optional fields)
- `apps/api/src/discovery/ats-clients.ts` (+ new `ats-clients.spec.ts`)
- `apps/api/src/common/text.util.ts` (export `containsWord`; remove `looksLikeRelevantRole`) + spec
- `apps/api/src/ingest/ingest.service.ts` + spec
- `apps/api/src/config/configuration.ts`
- `apps/api/src/cv/default-cv.ts`
- `packages/shared/src/types.ts` (`IngestRunSummary`)
- `db/migrations/0008_processing_pipeline.sql` (new)
