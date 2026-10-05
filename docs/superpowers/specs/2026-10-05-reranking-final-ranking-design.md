# Sub-project 4: Reranking + Final Ranking — Design Spec

**Parent document:** [job_search_automation_spec.md](../../../job_search_automation_spec.md) §17 (LlmRerankingModule), §18 (RankingModule)
**Status:** Approved for implementation planning
**Scope:** Backend (Groq prompt/schema swap, new deterministic ranking stage, migration) + web dashboard (sort/filter on the new score, recommendation chip, score breakdown on the job detail view).

---

## 1. Problem

Today, Groq's single `match_score` (0–100) **is** the final ranking: `jobs.service.ts` sorts and filters on it directly, and the dashboard shows it as the only score. This conflates two different judgments the parent spec keeps separate:

1. **Semantic fit** — does this candidate's CV actually fit this specific job? Only an LLM can judge this well, and it should judge it along several axes (role, seniority, specific skills, domain), not collapse straight to one number.
2. **Should I spend time on this one** — a deterministic combination of semantic fit *and* signals the LLM never sees as reliably as code does: how closely retrieval already matched this job, how fresh the posting is, and how well it matches the candidate's stated preferences (remote/hybrid, domain).

Because these are conflated, two real jobs scored similarly by Groq cannot be distinguished by freshness or preference fit, and there is no explanation of *why* a job ranks where it does beyond one number and a one-line summary.

## 2. Goal

Split semantic fit from the final decision:

- Groq returns a **structured, multi-dimensional evaluation** (`LlmJobEvaluation`) instead of one `match_score`.
- A new deterministic stage (`pipeline/ranking.ts`, pure functions, no DI — same pattern as sub-project 3) combines `retrieval_score` (sub-project 3) + the LLM evaluation + freshness + a preference signal into one `final_score`, plus a recommendation band.
- The dashboard sorts and filters on `final_score` by default, with a band chip, and a per-job breakdown explaining the number.

## 3. Decisions (made with the user during brainstorming)

| Question | Decision |
|---|---|
| Build richer Groq output, or just a final-score formula on the existing `match_score`? | Both halves, per spec §17–18: richer `LlmJobEvaluation` from Groq, and the separate deterministic `RankingModule`. |
| What does the formula's "preference" component mean? | Soft match of the job's detected work mode (remote/hybrid/onsite) and domain against `cv_profile.work_modes` / `domain_preferences`. Neutral (50) when the profile has none set — same "don't silently zero out an unset preference" principle as sub-project 3's empty-list handling. |
| Where is `final_score` computed? | At analysis time, in the same ingest flow that calls Groq today (`analyzeAndPersist`). Stored like `match_score` is today — the dashboard reads a column, no runtime recompute. |
| How configurable are the four top-level weights (retrieval/llm/freshness/preference)? | `ConfigService` env vars, same pattern as `INGEST_RETRIEVAL_FLOOR`. Not a DB-editable per-user setting (YAGNI until outcomes data exists to tune against). |
| How do the six `LlmJobEvaluation` fit fields collapse into one `llm_score`? | Weighted average favoring `requiredSkillFit` and `roleFit`; `criticalMismatch` hard-caps the result regardless of the average. Constants live in `pipeline/ranking.ts`, not configurable (internal mapping, not the spec's tunable top-level formula). |
| What happens to the existing `match_score` column/field? | Kept, not dropped. Written as an alias of `llm_score` for the transition period so nothing with an un-migrated read silently breaks. Removed in a later cleanup once the web UI change ships. |
| What does the dashboard show? | `final_score` is the primary sort/filter, shown with its band as a chip in list/Kanban. The job detail view shows the full breakdown: retrieval_score, llm_score (with its six sub-fits), freshness, preference, the weighted formula, final_score, band. |

## 4. Non-goals

- No per-user, DB-backed weight tuning (§18.2 mentions it as a future direction; out of scope here).
- No change to sub-project 3's pipeline (normalize/eligibility/retrieval-score/floor) or to which jobs get analyzed — `buildAnalysisPool`'s Top-N selection is unchanged.
- No re-ranking of already-analyzed jobs when the CV profile changes (stored scores go stale until the next analysis; acceptable per sub-project 3's same ruling on `retrieval_score`).
- No application-outcome feedback loop (band accuracy is not tuned from accept/reject history).
- No removal of the `match_score` column in this sub-project — that is a follow-up once the web UI no longer reads it directly.
- No changes to `AnalysisService`'s retry/rate-limit handling, repair-prompt mechanism, or Groq transport — only the system prompt, JSON schema, and the response type change.

## 5. Architecture

```
analyzeAndPersist(job)                      (ingest.service.ts — existing call site)
  → AnalysisService.analyze()               (prompt/schema swap)
      → LlmJobEvaluation                    (new shape, replaces SkillGapResult)
  → combineLlmFit(evaluation)               → llm_score (pipeline/ranking.ts, pure)
  → scorePreference(job, profile)           → preference_score (pipeline/ranking.ts, pure)
  → freshnessPoints(postedDateIso, now)     (reused from pipeline/retrieval-score.ts)
  → combineFinalScore(...)                  → { final_score, recommendation } (pure)
  → persist: skill_gap_analysis gains the LLM breakdown + llm_score;
             job_postings gains final_score + recommendation
```

Every new function in `pipeline/ranking.ts` is a pure function of its inputs, consistent with `pipeline/eligibility.ts`, `pipeline/retrieval-score.ts`, `pipeline/select.ts` — no NestJS DI, independently unit-testable, composed in `IngestService`.

## 6. New and changed types

### `LlmJobEvaluation` (new, replaces `SkillGapResult` as Groq's output shape)

In `@jobportal/shared`:

```ts
export interface LlmJobEvaluation {
  roleFit: number;            // 0-100
  seniorityFit: number;       // 0-100
  requiredSkillFit: number;   // 0-100
  preferredSkillFit: number;  // 0-100
  experienceFit: number;      // 0-100
  domainFit: number;          // 0-100
  criticalMismatch: boolean;
  matchedSkills: string[];
  missingSkills: string[];
  criticalGaps: string[];
  summary: string;
  confidence: number;         // 0-100 — Groq's own confidence in this evaluation
}
```

`required_skills: Array<{ name, required }>` (today's field, used to populate `job_skills`) is **kept** alongside this — nothing currently reads it depends on `match_score`, so it is unaffected by the prompt/schema change.

### `RawLlmEvaluationResponse` (new, `analysis/groq.types.ts`) — mirrors `LlmJobEvaluation` as the untrusted wire shape before validation, same pattern as today's `RawSkillGapResponse`.

### `pipeline/ranking.ts` (new file)

```ts
export const RANKING_WEIGHTS = {
  requiredSkillFit: 0.35,
  roleFit: 0.25,
  seniorityFit: 0.15,
  domainFit: 0.10,
  preferredSkillFit: 0.10,
  experienceFit: 0.05,
} as const;

const CRITICAL_MISMATCH_CAP = 30;

/** Collapses the six LLM fit dimensions into one 0-100 score. A
 * criticalMismatch caps the result — a model that says "great skills fit"
 * but also flags a critical mismatch (e.g. visa/work-authorization,
 * on-site-only vs. remote-only) must not rank as if nothing were wrong. */
export function combineLlmFit(evaluation: LlmJobEvaluation): number;

export interface PreferenceContext {
  workModes: readonly string[];       // cv_profile.work_modes
  domainPreferences: readonly string[]; // cv_profile.domain_preferences
}

/** Soft 0-100 match of the job's detected work mode and domain against the
 * candidate's stated preferences. Neutral (50) when the profile has set
 * neither — an unset preference is not evidence of a bad fit. */
export function scorePreference(job: NormalizedJob, ctx: PreferenceContext): number;

export const RECOMMENDATION_BANDS = [
  { min: 90, label: 'APPLY_NOW' },
  { min: 80, label: 'STRONG_MATCH' },
  { min: 70, label: 'CONSIDER' },
  { min: 60, label: 'LOW_PRIORITY' },
  { min: 0,  label: 'SKIP' },
] as const;

export type Recommendation = (typeof RECOMMENDATION_BANDS)[number]['label'];

export interface FinalScoreWeights {
  retrieval: number;
  llm: number;
  freshness: number;
  preference: number;
}

export interface FinalScoreInput {
  retrievalScore: number;
  llmScore: number;
  freshnessScore: number;
  preferenceScore: number;
}

export interface FinalScoreResult {
  finalScore: number;
  recommendation: Recommendation;
}

/** Weighted sum of the four 0-100 inputs, normalized if the weights don't
 * sum to 100 (so a misconfigured env doesn't silently produce an
 * out-of-range score), then mapped to a recommendation band. */
export function combineFinalScore(input: FinalScoreInput, weights: FinalScoreWeights): FinalScoreResult;
```

### `JobPosting` / `JobListItem` / `JobDetail` (`packages/shared/src/types.ts`)

```ts
// JobPosting (row) — two new nullable columns
final_score: number | null;
recommendation: string | null;

// JobListItem — surfaced for the list/Kanban view
final_score: number | null;
recommendation: string | null;

// JobDetail — full breakdown for the detail view
llm_evaluation: {
  llm_score: number;
  role_fit: number;
  seniority_fit: number;
  required_skill_fit: number;
  preferred_skill_fit: number;
  experience_fit: number;
  domain_fit: number;
  critical_mismatch: boolean;
  critical_gaps: string[];
  confidence: number;
} | null;
retrieval_signals: RetrievalSignals | null;  // already stored since sub-project 3, not yet surfaced
preference_score: number | null;
```

### `JobQuery`

```ts
sort?: 'final_score' | 'match_score' | 'scraped_at' | 'posted_date' | 'title';
```

Default sort changes from `'scraped_at'` to `'final_score'` (nulls last — unanalyzed jobs sort after scored ones, same `nullsFirst: false` convention `jobs.service.ts` already uses).

## 7. Database (migration 0009)

Idempotent, same conventions as 0008 (`add column if not exists`, append-only view columns, re-apply `security_invoker`).

```sql
alter table public.skill_gap_analysis
  add column if not exists llm_score integer check (llm_score between 0 and 100),
  add column if not exists confidence integer check (confidence between 0 and 100),
  add column if not exists critical_mismatch boolean,
  add column if not exists critical_gaps jsonb,
  add column if not exists role_fit integer,
  add column if not exists seniority_fit integer,
  add column if not exists required_skill_fit integer,
  add column if not exists preferred_skill_fit integer,
  add column if not exists experience_fit integer,
  add column if not exists domain_fit integer;

alter table public.job_postings
  add column if not exists final_score integer check (final_score between 0 and 100),
  add column if not exists recommendation text,
  add column if not exists preference_score integer;

create index if not exists job_postings_final_score_idx
  on public.job_postings (user_id, final_score desc);

-- job_postings_enriched view: append final_score, recommendation, llm_score,
-- confidence, critical_mismatch, critical_gaps, the six fit columns, and
-- preference_score to the existing select list (same append-only pattern as
-- 0008 — Postgres only allows appending to a view's column list).
-- alter view ... set (security_invoker = true); re-applied after the
-- create-or-replace, same as 0008.
```

`match_score` is untouched by this migration — `analyzeAndPersist` keeps writing it (as an alias of `llm_score`) so any code still reading it keeps working.

## 8. Prompt changes (`AnalysisService`)

The system prompt (today a single paragraph plus one JSON shape) is replaced with the §17.4 scoring-semantics table embedded directly in the prompt, so Groq anchors each 0–100 fit dimension consistently:

```
0-20   clearly unsuitable
21-40  weak fit
41-60  possible but significant gaps
61-75  decent fit
76-89  strong fit
90-100 exceptional fit
```

applied per-dimension (role, seniority, required skills, preferred skills, experience, domain), not just to one overall number. The "never invent skills" instruction (already present) is kept verbatim. `criticalMismatch` is defined in the prompt as: a disqualifying mismatch the semantic score alone would hide — e.g. the posting requires on-site presence the candidate's profile rules out, or requires a clearance/authorization the CV gives no evidence of. The JSON schema (`groq.types.ts`'s `SKILL_GAP_JSON_SCHEMA`-equivalent) is rewritten to the `LlmJobEvaluation` shape; validation keeps the existing discipline (reject malformed, range-clamp 0–100, one repair-prompt retry) — `toSkillGapResult` is replaced by an equivalent `toLlmJobEvaluation` validator.

## 9. Ingest flow changes

`analyzeAndPersist` (today ends after writing `skill_gap_analysis` + `job_skills` + updating `seniority_guess`) gains, after a successful Groq call:

```
llm_score = combineLlmFit(evaluation)
preference_score = scorePreference(normalizedJob, { workModes: profile.work_modes, domainPreferences: profile.domain_preferences })
freshness_score = freshnessPoints(job.postedDateIso, now)   // reused from retrieval-score.ts
{ finalScore, recommendation } = combineFinalScore(
  { retrievalScore: job.retrieval_score, llmScore: llm_score, freshnessScore: freshness_score, preferenceScore: preference_score },
  weightsFromConfig(),
)
```

then both `skill_gap_analysis` (llm_score + the six fits + confidence + critical_mismatch + critical_gaps, plus `match_score: llm_score` for the transition alias) and `job_postings` (`final_score`, `recommendation`, `preference_score`) are written. `weightsFromConfig()` reads `RANKING_WEIGHT_RETRIEVAL` / `RANKING_WEIGHT_LLM` / `RANKING_WEIGHT_FRESHNESS` / `RANKING_WEIGHT_PREFERENCE` (defaults 35/45/10/10) via `ConfigService`, same pattern as `ingest.retrievalFloor`.

`job.retrieval_score` — stored since sub-project 3 — needs to be read back onto `InsertedJob` (today `InsertedJob` carries `id/title/companyName/location/description` only) so `analyzeAndPersist` has it without a second query; `InsertedJob` gains `retrievalScore: number`.

## 10. Web dashboard changes

- **List/Kanban sort:** default changes to "Best match" (`final_score`); existing sort options remain, `match_score` kept as a selectable legacy option during the transition.
- **Score chip:** each job card shows the recommendation band as a colored chip (APPLY_NOW=green, STRONG_MATCH=teal, CONSIDER=yellow, LOW_PRIORITY=orange, SKIP=gray) instead of/alongside the raw number.
- **Detail view:** new "Why this score" section — retrieval_score, llm_score with its six sub-fits as a small bar/list, freshness, preference, and the final weighted sum, mirroring spec §18.5's "why it ranks highly / strong overlaps / missing critical skills / potential concerns" using `criticalGaps` and `missingSkills` for the concerns and `matchedSkills` for overlaps.
- **Filters:** `min_score`/`max_score` query params now filter on `final_score` (documented as a behavior change from sub-project 3, where they filtered `match_score`).

## 11. Testing

- `pipeline/ranking.spec.ts` — pure-function tests, no DI, same style as `pipeline/eligibility.spec.ts` / `pipeline/retrieval-score.spec.ts`: `combineLlmFit` (weighted average, criticalMismatch cap, boundary at exactly the cap), `scorePreference` (both preferences unset → neutral 50, remote job vs. onsite-only profile, domain match/mismatch), `combineFinalScore` (weights sum to 100, weights normalized when misconfigured, each band boundary).
- `analysis.service.spec.ts` — prompt/schema swap: validator rejects out-of-range fit values, missing fields, non-boolean `criticalMismatch`; repair-retry path still exercised.
- `ingest.service.spec.ts` — `analyzeAndPersist` writes `final_score`/`recommendation`/`preference_score` onto `job_postings` and the full breakdown onto `skill_gap_analysis`, using a fake `LlmJobEvaluation`; `match_score` is still written as an alias.
- A composition test (`pipeline/ranking.spec.ts` or a new `pipeline/final-ranking.spec.ts`) feeding one hand-built `LlmJobEvaluation` + retrieval signals through the whole chain to a known `final_score`, mirroring sub-project 3's `pipeline.spec.ts`.

## Review Focus

- **`criticalMismatch: true` with high fit scores everywhere else** — the cap must actually suppress `final_score`/the band, not just sit unread in the stored row; a reasonable person expects "critical mismatch" to visibly tank the ranking, not just appear as a flag nobody surfaces.
- **A job analyzed before this migration** (`llm_score`/`final_score` both null) — list/detail views and the default sort must not crash or silently exclude it; it should sort after scored jobs, same `nullsFirst: false` convention as today.
- **Preference weights misconfigured to not sum to 100** (env typo) — `combineFinalScore` must normalize, not emit a `final_score` outside 0–100 that the `check` constraint then rejects at insert time.
- **A CV profile with empty `work_modes` and `domain_preferences`** (the common case today — sub-project 1 shipped these fields but nothing populates them automatically) — `scorePreference` must return the neutral default, not a deflated score that silently punishes every job.
- **Groq returns a malformed `LlmJobEvaluation`** (fit value as a string, missing `criticalGaps`, confidence out of range) — the validator must reject and retry once, exactly as `toSkillGapResult` does today, not let a bad value flow into `combineLlmFit`.
