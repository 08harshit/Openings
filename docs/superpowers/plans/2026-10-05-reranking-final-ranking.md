# Reranking + Final Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Groq's single `match_score` with a richer multi-dimensional `LlmJobEvaluation`, then deterministically combine it with the existing `retrieval_score`, freshness, and a new preference signal into one `final_score` + recommendation band, stored and ready for the dashboard to sort/filter on.

**Architecture:** New pure functions in `apps/api/src/pipeline/ranking.ts` (no NestJS DI, same pattern as `pipeline/eligibility.ts` / `pipeline/retrieval-score.ts`). `AnalysisService`'s Groq prompt/schema/response type swap from one `match_score` to the six-dimension `LlmJobEvaluation`. `IngestService.analyzeAndPersist` composes: Groq call → `combineLlmFit` → `scorePreference` → reused `freshnessPoints` → `combineFinalScore` → persist. Migration 0009 adds the new columns, append-only to `job_postings_enriched`.

**Tech Stack:** NestJS, TypeScript, Jest/ts-jest, Supabase Postgres, Groq (OpenAI-compatible chat completions, JSON mode).

**Spec:** [docs/superpowers/specs/2026-10-05-reranking-final-ranking-design.md](../specs/2026-10-05-reranking-final-ranking-design.md)

## Global Constraints

- Backend only. The web dashboard (spec §10) is explicitly out of scope for this plan — a follow-on bounded change wires the Angular UI once this ships. `match_score` stays populated (as an alias of `llm_score`) so the current dashboard keeps working unmodified.
- No DB-backed per-user weight tuning (spec §4 non-goal). Top-level ranking weights come from `ConfigService` env vars; the six-LLM-dimension collapse weights (`RANKING_WEIGHTS` in `pipeline/ranking.ts`) are code constants, not configurable.
- No change to sub-project 3's pipeline (`normalize.ts`, `eligibility.ts`, `retrieval-score.ts`, `select.ts`, `evaluate.ts`) or to which jobs get analyzed (`buildAnalysisPool`'s Top-N selection logic is unchanged — only what happens *after* a job is picked for analysis changes).
- `final_score` must stay in `[0, 100]` even if the configured weights don't sum to 100 (normalize, don't let a misconfigured env violate the DB `check` constraint at insert time).
- `pipeline/ranking.ts` functions are pure — same testability discipline as every other `pipeline/*.ts` file. No Supabase, no Groq client, no `ConfigService` inside them; callers pass in already-resolved weights/context.
- Migrations are written here but applied ONLY by the user via the Supabase SQL Editor — never auto-applied, never assumed applied before referencing new columns in a way that would break pre-migration rows without a null-safe path.
- Every new/changed exported function signature below is final — do not rename at implementation time; if a plan signature conflicts with existing code, that is a ledgered ruling, not a silent rename.

## Review Focus

- **`criticalMismatch: true` with otherwise-high fit scores**: `combineLlmFit` must visibly cap the result (to `CRITICAL_MISMATCH_CAP`), not just pass the flag through unread. Pinned in Task 2.
- **A job analyzed before migration 0009** (`final_score`/`llm_score` both null in `job_postings_enriched`): `toAnalysisCandidates`-style null-safety and any future list/sort query must treat these as "sorts last," never throw. Pinned in Task 6 (ingest wiring) and Task 5 (migration review).
- **Ranking weights misconfigured to not sum to 100** (env typo, e.g. `RANKING_WEIGHT_LLM=4500`): `combineFinalScore` must normalize so `final_score` stays in `[0, 100]`. Pinned in Task 3.
- **A CV profile with empty `work_modes` and `domain_preferences`** (the common case today): `scorePreference` must return the neutral default (50), not a deflated score. Pinned in Task 4.
- **Groq returns a malformed `LlmJobEvaluation`** (a fit value as a string, missing `criticalGaps`, `confidence` out of range, non-boolean `criticalMismatch`): the validator must reject and retry once via the existing repair mechanism, exactly as `toSkillGapResult` does today — never let a bad value flow into `combineLlmFit`. Pinned in Task 2.

---

## Task 1: Shared types — `LlmJobEvaluation`, ranking fields, query sort

**Files:**
- Modify: `packages/shared/src/types.ts`

**Interfaces:**
- Produces: `LlmJobEvaluation` (the validated Groq output shape), `JobPosting.final_score`/`recommendation`, `JobListItem.final_score`/`recommendation`, `JobDetail.llm_evaluation`/`retrieval_signals`/`preference_score`, `JobQuery.sort` gaining `'final_score'`. Every later task imports these from `@jobportal/shared`.
- Consumes: nothing new (uses existing `SeniorityLevel`, `SkillCategory` already imported in this file).

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/types.spec.ts` (new file — this package has no existing test file, so this also wires up `ts-jest` for it):

```ts
import type { LlmJobEvaluation, JobDetail, JobListItem, JobPosting, JobQuery } from './types';

describe('LlmJobEvaluation shape', () => {
  it('accepts every required field with correct types', () => {
    const evaluation: LlmJobEvaluation = {
      roleFit: 80,
      seniorityFit: 70,
      requiredSkillFit: 90,
      preferredSkillFit: 60,
      experienceFit: 75,
      domainFit: 50,
      criticalMismatch: false,
      matchedSkills: ['nodejs'],
      missingSkills: ['kubernetes'],
      criticalGaps: [],
      summary: 'Strong backend match.',
      confidence: 85,
    };
    expect(evaluation.roleFit).toBe(80);
  });
});

describe('JobPosting/JobListItem ranking fields', () => {
  it('allows final_score and recommendation to be null or set', () => {
    const posting: Pick<JobPosting, 'final_score' | 'recommendation'> = {
      final_score: null,
      recommendation: null,
    };
    expect(posting.final_score).toBeNull();

    const listItem: Pick<JobListItem, 'final_score' | 'recommendation'> = {
      final_score: 87,
      recommendation: 'STRONG_MATCH',
    };
    expect(listItem.final_score).toBe(87);
  });
});

describe('JobDetail llm_evaluation breakdown', () => {
  it('allows a full breakdown or null', () => {
    const withBreakdown: Pick<JobDetail, 'llm_evaluation'> = {
      llm_evaluation: {
        llm_score: 78,
        role_fit: 80,
        seniority_fit: 70,
        required_skill_fit: 90,
        preferred_skill_fit: 60,
        experience_fit: 75,
        domain_fit: 50,
        critical_mismatch: false,
        critical_gaps: [],
        confidence: 85,
      },
    };
    expect(withBreakdown.llm_evaluation?.llm_score).toBe(78);

    const withoutBreakdown: Pick<JobDetail, 'llm_evaluation'> = { llm_evaluation: null };
    expect(withoutBreakdown.llm_evaluation).toBeNull();
  });
});

describe('JobQuery.sort', () => {
  it('accepts final_score as a sort value', () => {
    const query: JobQuery = { sort: 'final_score' };
    expect(query.sort).toBe('final_score');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx jest types.spec.ts`
Expected: FAIL — `types.ts` has no exported member `LlmJobEvaluation`, and the `Pick<...>` object literals error on properties (`final_score`, `recommendation`, `llm_evaluation`) that don't exist on the current types. ts-jest surfaces this as a compile error, same as every other RED in this codebase's pipeline tests.

- [ ] **Step 3: Add the new/changed types**

In `packages/shared/src/types.ts`, add after `SkillGapResult` (the existing single-score shape — kept as-is, nothing reads it anymore after Task 2 but removing it is out of scope for this plan):

```ts
// ---------------------------------------------------------------------------
// Reranking + final ranking (sub-project 4)
// ---------------------------------------------------------------------------

/** Groq's structured, multi-dimensional evaluation of one candidate/job pair.
 * Replaces the single `match_score` as what the LLM actually returns —
 * `combineLlmFit` (apps/api/src/pipeline/ranking.ts) collapses this to one
 * number for the final-score formula. */
export interface LlmJobEvaluation {
  roleFit: number;
  seniorityFit: number;
  requiredSkillFit: number;
  preferredSkillFit: number;
  experienceFit: number;
  domainFit: number;
  /** A disqualifying mismatch the fit scores alone would hide (e.g. on-site-
   * only vs. a remote-only candidate, or a clearance the CV shows no sign of). */
  criticalMismatch: boolean;
  matchedSkills: string[];
  missingSkills: string[];
  criticalGaps: string[];
  summary: string;
  /** 0-100 — Groq's own confidence in this evaluation. */
  confidence: number;
}

export const RECOMMENDATION_LABELS = [
  'APPLY_NOW',
  'STRONG_MATCH',
  'CONSIDER',
  'LOW_PRIORITY',
  'SKIP',
] as const;

export type Recommendation = (typeof RECOMMENDATION_LABELS)[number];
```

Modify `JobPosting` (after `source`) to add:

```ts
  final_score: number | null;
  recommendation: Recommendation | null;
```

Modify `JobListItem` (after `match_score`/`matched_skills`/`missing_skills`) to add:

```ts
  final_score: number | null;
  recommendation: Recommendation | null;
```

Modify `JobDetail` (after `required_skills`) to add:

```ts
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
  preference_score: number | null;
```

Modify `JobQuery.sort`:

```ts
  sort?: 'final_score' | 'match_score' | 'scraped_at' | 'posted_date' | 'title';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx jest types.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Build the package and typecheck**

Run: `cd packages/shared && npm run build`
Expected: clean build, no TS errors. This step is required before any `apps/api` task below — `@jobportal/shared` resolves through `dist/`, not `src/`.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/types.spec.ts
git commit -m "feat(shared): add LlmJobEvaluation and final-ranking fields"
```

---

## Task 2: Groq prompt/schema swap — `LlmJobEvaluation` from `AnalysisService`

**Files:**
- Modify: `apps/api/src/analysis/analysis.service.ts`
- Modify: `apps/api/src/analysis/analysis.types.ts`
- Modify: `apps/api/src/analysis/groq.types.ts`
- Test: `apps/api/src/analysis/analysis.service.spec.ts` (new — this service currently has no test file; add one)

**Interfaces:**
- Consumes: `LlmJobEvaluation` (Task 1, `@jobportal/shared`).
- Produces: `AnalysisService.analyze()` now returns `Promise<LlmJobEvaluation | null>` instead of `Promise<SkillGapResult | null>`. `RawLlmEvaluationResponse` (new, `groq.types.ts`) is the untrusted wire shape before validation. `toLlmJobEvaluation(raw: RawLlmEvaluationResponse): LlmJobEvaluation` (new, exported from `analysis.service.ts`) is the validator — Task 6 does not consume this directly (it only consumes `analyze()`'s return value), but it must be exported for this task's own tests.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/analysis/analysis.service.spec.ts`:

```ts
import { toLlmJobEvaluation } from './analysis.service';
import type { RawLlmEvaluationResponse } from './groq.types';

function rawResponse(overrides: Partial<RawLlmEvaluationResponse> = {}): RawLlmEvaluationResponse {
  return {
    roleFit: 80,
    seniorityFit: 70,
    requiredSkillFit: 90,
    preferredSkillFit: 60,
    experienceFit: 75,
    domainFit: 50,
    criticalMismatch: false,
    matchedSkills: ['nodejs', 'postgresql'],
    missingSkills: ['kubernetes'],
    criticalGaps: [],
    summary: 'Strong backend match; missing container orchestration exposure.',
    confidence: 85,
    ...overrides,
  };
}

describe('toLlmJobEvaluation', () => {
  it('passes through a well-formed response', () => {
    const result = toLlmJobEvaluation(rawResponse());
    expect(result.roleFit).toBe(80);
    expect(result.criticalMismatch).toBe(false);
    expect(result.matchedSkills).toEqual(['nodejs', 'postgresql']);
    expect(result.confidence).toBe(85);
  });

  it('clamps every fit field to 0-100', () => {
    const result = toLlmJobEvaluation(rawResponse({ roleFit: 150, seniorityFit: -20 }));
    expect(result.roleFit).toBe(100);
    expect(result.seniorityFit).toBe(0);
  });

  it('rounds non-integer fit values', () => {
    const result = toLlmJobEvaluation(rawResponse({ requiredSkillFit: 77.6 }));
    expect(result.requiredSkillFit).toBe(78);
  });

  it('defaults a missing/non-boolean criticalMismatch to false', () => {
    const result = toLlmJobEvaluation(rawResponse({ criticalMismatch: undefined as unknown as boolean }));
    expect(result.criticalMismatch).toBe(false);
  });

  it('defaults missing array fields to empty arrays', () => {
    const result = toLlmJobEvaluation(
      rawResponse({
        matchedSkills: undefined as unknown as string[],
        missingSkills: undefined as unknown as string[],
        criticalGaps: undefined as unknown as string[],
      }),
    );
    expect(result.matchedSkills).toEqual([]);
    expect(result.missingSkills).toEqual([]);
    expect(result.criticalGaps).toEqual([]);
  });

  it('truncates an overly long summary to 500 characters', () => {
    const result = toLlmJobEvaluation(rawResponse({ summary: 'x'.repeat(600) }));
    expect(result.summary.length).toBe(500);
  });

  it('defaults a missing/invalid confidence to 0', () => {
    const result = toLlmJobEvaluation(rawResponse({ confidence: NaN }));
    expect(result.confidence).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest analysis/analysis.service.spec.ts`
Expected: FAIL — `toLlmJobEvaluation` is not exported from `./analysis.service`, and `RawLlmEvaluationResponse` does not exist on `./groq.types`.

- [ ] **Step 3: Add `RawLlmEvaluationResponse` and the new JSON schema**

In `apps/api/src/analysis/groq.types.ts`, add (keep `RawSkillGapResponse` as-is — unused after this task but removing it is out of scope):

```ts
export interface RawLlmEvaluationResponse {
  roleFit: number;
  seniorityFit: number;
  requiredSkillFit: number;
  preferredSkillFit: number;
  experienceFit: number;
  domainFit: number;
  criticalMismatch: boolean;
  matchedSkills: string[];
  missingSkills: string[];
  criticalGaps: string[];
  summary: string;
  confidence: number;
}
```

In `apps/api/src/analysis/analysis.types.ts`, add alongside `SKILL_GAP_JSON_SCHEMA` (keep that export too):

```ts
/** JSON Schema handed to Groq via response_format — see analysis.service.ts. */
export const LLM_EVALUATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    roleFit: { type: 'integer', description: '0-100: how well the job title/role matches the candidate\'s target roles and current trajectory.' },
    seniorityFit: { type: 'integer', description: '0-100: how well the job\'s seniority level matches the candidate\'s experience.' },
    requiredSkillFit: { type: 'integer', description: '0-100: coverage of the JD\'s required/must-have skills by the candidate\'s CV.' },
    preferredSkillFit: { type: 'integer', description: '0-100: coverage of the JD\'s nice-to-have skills by the candidate\'s CV.' },
    experienceFit: { type: 'integer', description: '0-100: how well the candidate\'s years and type of experience match what the JD implies.' },
    domainFit: { type: 'integer', description: '0-100: how well the candidate\'s industry/domain background matches this role\'s domain.' },
    criticalMismatch: {
      type: 'boolean',
      description:
        'true only for a disqualifying mismatch the fit scores above would hide — e.g. the posting requires ' +
        'on-site presence incompatible with a remote-only candidate, or requires a clearance/authorization the ' +
        'CV gives no evidence of. false otherwise, even if fit scores are low.',
    },
    matchedSkills: {
      type: 'array',
      items: { type: 'string' },
      description: 'Canonical, lowercase-hyphenated skill slugs the candidate has that this JD also asks for.',
    },
    missingSkills: {
      type: 'array',
      items: { type: 'string' },
      description: 'Canonical, lowercase-hyphenated skill slugs the JD asks for that the candidate\'s CV lacks.',
    },
    criticalGaps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short phrases naming the specific gap(s) behind a true criticalMismatch. Empty if criticalMismatch is false.',
    },
    summary: {
      type: 'string',
      description: 'One or two short sentences summarising the fit, no preamble, no restating the scores.',
    },
    confidence: {
      type: 'integer',
      description: '0-100: how confident this evaluation is, given how much detail the JD and CV provided.',
    },
  },
  required: [
    'roleFit', 'seniorityFit', 'requiredSkillFit', 'preferredSkillFit', 'experienceFit', 'domainFit',
    'criticalMismatch', 'matchedSkills', 'missingSkills', 'criticalGaps', 'summary', 'confidence',
  ],
  additionalProperties: false,
} as const;
```

- [ ] **Step 4: Replace the prompt, schema wiring, response type, and validator in `analysis.service.ts`**

Replace the `SYSTEM_PROMPT` constant:

```ts
const SYSTEM_PROMPT = `You evaluate how well a candidate's CV fits a specific job description, along several
independent dimensions. Score each dimension generously for adjacent/transferable experience (e.g.
Sequelize experience counts partially toward "any ORM" requirements; Kafka experience counts toward
general message-queue familiarity) but do not invent skills the CV does not support.

Use this scale consistently for every 0-100 fit dimension:
0-20   clearly unsuitable
21-40  weak fit
41-60  possible but significant gaps
61-75  decent fit
76-89  strong fit
90-100 exceptional fit

A criticalMismatch is NOT "low fit" — it is a disqualifying issue the fit scores above would otherwise
hide, such as a posting requiring on-site presence incompatible with a remote-only candidate, or a
security clearance / work authorization the CV gives no evidence of. Set it true only in that case,
with the specific reason(s) in criticalGaps. Most jobs have criticalMismatch: false even with low fit
scores — that is just a weak match, not a critical one.

Extract skill names as short canonical slugs: lowercase, hyphenated, no version numbers unless the JD
is version-specific. Prefer well-known conventional slugs (nodejs, postgresql, rest-api, ci-cd, aws)
over ad-hoc phrasing.

Respond with ONLY a single JSON object — no markdown fences, no commentary — matching exactly this shape:
{
  "roleFit": <integer 0-100>,
  "seniorityFit": <integer 0-100>,
  "requiredSkillFit": <integer 0-100>,
  "preferredSkillFit": <integer 0-100>,
  "experienceFit": <integer 0-100>,
  "domainFit": <integer 0-100>,
  "criticalMismatch": <boolean>,
  "matchedSkills": [<canonical skill slug strings the candidate already has>],
  "missingSkills": [<canonical skill slug strings the JD wants but the CV lacks>],
  "criticalGaps": [<short phrases naming the specific critical mismatch reason(s), empty if none>],
  "summary": "<one or two short sentences on the fit, no preamble>",
  "confidence": <integer 0-100>
}`;
```

Change the import line to pull `RawLlmEvaluationResponse` instead of `RawSkillGapResponse`, and change `analyze()`'s return type and body:

```ts
import type {
  GroqChatRequest,
  GroqChatResponse,
  GroqErrorResponse,
  RawLlmEvaluationResponse,
} from './groq.types';
```

```ts
  async analyze(
    userId: string,
    job: { title: string; companyName: string | null; location: string | null; description: string },
  ): Promise<LlmJobEvaluation | null> {
    if (!this.isConfigured) {
      this.logger.warn('GROQ_API_KEY not set — skipping skill-gap analysis');
      return null;
    }

    const cvContext = await this.cv.buildAnalysisContext(userId);
    const description = normalizeWhitespace(job.description, 12_000);

    if (description.trim().length < 40) {
      this.logger.debug(`Skipping analysis for "${job.title}" — description too short to score`);
      return null;
    }

    const userPrompt = buildUserPrompt(cvContext, job, description);

    try {
      const raw = await retry(() => this.callGroq(userPrompt), {
        attempts: 6,
        baseDelayMs: 1_000,
        shouldRetry: (error) => error instanceof GroqRetryableError,
        onRetry: (_e, attempt, delay) =>
          this.logger.warn(`Retrying Groq analysis (attempt ${attempt}) in ${Math.round(delay)}ms`),
      });
      return raw ? toLlmJobEvaluation(raw) : null;
    } catch (error) {
      this.logger.error(
        `Skill-gap analysis failed for "${job.title}": ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }
```

Change `callGroq`'s return type and parse target:

```ts
  private async callGroq(userPrompt: string): Promise<RawLlmEvaluationResponse | null> {
    // ...unchanged body...
    try {
      return JSON.parse(content) as RawLlmEvaluationResponse;
    } catch (error) {
      this.logger.warn(`Could not parse Groq response as JSON: ${error}`);
      return null;
    }
  }
```

Replace `toSkillGapResult` with (export it, per this task's Interfaces block):

```ts
const FIT_FIELDS = [
  'roleFit', 'seniorityFit', 'requiredSkillFit', 'preferredSkillFit', 'experienceFit', 'domainFit',
] as const;

function clampFit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? normalizeSkillList(value.filter((v): v is string => typeof v === 'string')) : [];
}

export function toLlmJobEvaluation(raw: RawLlmEvaluationResponse): LlmJobEvaluation {
  const result: Record<string, number> = {};
  for (const field of FIT_FIELDS) result[field] = clampFit((raw as Record<string, unknown>)[field]);

  return {
    roleFit: result.roleFit,
    seniorityFit: result.seniorityFit,
    requiredSkillFit: result.requiredSkillFit,
    preferredSkillFit: result.preferredSkillFit,
    experienceFit: result.experienceFit,
    domainFit: result.domainFit,
    criticalMismatch: raw.criticalMismatch === true,
    matchedSkills: toStringArray(raw.matchedSkills),
    missingSkills: toStringArray(raw.missingSkills),
    criticalGaps: Array.isArray(raw.criticalGaps)
      ? raw.criticalGaps.filter((g): g is string => typeof g === 'string')
      : [],
    summary: (raw.summary ?? '').trim().slice(0, 500),
    confidence: clampFit(raw.confidence),
  };
}
```

Note: `criticalGaps` is free text from Groq (reasons, not canonical skill slugs), so it is NOT passed through `normalizeSkillList` — only `matchedSkills`/`missingSkills` are.

Update the top-of-file import to bring in `LlmJobEvaluation` from `@jobportal/shared` in place of `SkillGapResult`:

```ts
import { normalizeSkillList, type LlmJobEvaluation } from '@jobportal/shared';
```

(`SeniorityLevel` is no longer used in this file after this change — the evaluation has no `seniority_guess` field; `apps/api/src/ingest/ingest.service.ts`'s existing seniority-guess update, which reads `result.seniority_guess`, is addressed in Task 6.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx jest analysis/analysis.service.spec.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: Errors in `ingest.service.ts` (still reads `result.match_score`/`result.seniority_guess`/`result.required_skills` — Task 6 fixes this) and possibly `jobs.service.ts`/`cv.service.ts` if either imports `SkillGapResult`. Confirm every error is confined to files Task 6 (or earlier/later tasks) will touch — do not fix them here. Note which files have errors in your task report; this is expected, not a regression.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/analysis/analysis.service.ts apps/api/src/analysis/analysis.service.spec.ts apps/api/src/analysis/analysis.types.ts apps/api/src/analysis/groq.types.ts
git commit -m "feat(analysis): swap Groq's single match_score for LlmJobEvaluation"
```

---

## Task 3: `pipeline/ranking.ts` — `combineLlmFit` and `combineFinalScore`

**Files:**
- Create: `apps/api/src/pipeline/ranking.ts`
- Test: `apps/api/src/pipeline/ranking.spec.ts`

**Interfaces:**
- Consumes: `LlmJobEvaluation` (Task 1, `@jobportal/shared`).
- Produces: `RANKING_WEIGHTS`, `CRITICAL_MISMATCH_CAP`, `combineLlmFit(evaluation: LlmJobEvaluation): number`, `RECOMMENDATION_BANDS`, `bandFor(score: number): Recommendation`, `FinalScoreWeights`, `FinalScoreInput`, `FinalScoreResult`, `combineFinalScore(input: FinalScoreInput, weights: FinalScoreWeights): FinalScoreResult`. Task 4 adds `scorePreference` to this same file. Task 6 imports all of these.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/pipeline/ranking.spec.ts`:

```ts
import { combineLlmFit, combineFinalScore, bandFor } from './ranking';
import type { LlmJobEvaluation } from '@jobportal/shared';

function evaluation(overrides: Partial<LlmJobEvaluation> = {}): LlmJobEvaluation {
  return {
    roleFit: 80,
    seniorityFit: 70,
    requiredSkillFit: 90,
    preferredSkillFit: 60,
    experienceFit: 75,
    domainFit: 50,
    criticalMismatch: false,
    matchedSkills: [],
    missingSkills: [],
    criticalGaps: [],
    summary: '',
    confidence: 85,
    ...overrides,
  };
}

describe('combineLlmFit', () => {
  it('weighs requiredSkillFit and roleFit most heavily', () => {
    const skillHeavy = combineLlmFit(evaluation({ requiredSkillFit: 100, roleFit: 20, seniorityFit: 20, domainFit: 20, preferredSkillFit: 20, experienceFit: 20 }));
    const roleHeavy = combineLlmFit(evaluation({ requiredSkillFit: 20, roleFit: 100, seniorityFit: 20, domainFit: 20, preferredSkillFit: 20, experienceFit: 20 }));
    expect(skillHeavy).toBeGreaterThan(roleHeavy);
  });

  it('matches the documented weighted-average formula', () => {
    const e = evaluation();
    const expected = Math.round(
      e.requiredSkillFit * 0.35 + e.roleFit * 0.25 + e.seniorityFit * 0.15 +
      e.domainFit * 0.10 + e.preferredSkillFit * 0.10 + e.experienceFit * 0.05,
    );
    expect(combineLlmFit(e)).toBe(expected);
  });

  it('caps the result when criticalMismatch is true, even with perfect fit scores', () => {
    const perfect = evaluation({
      roleFit: 100, seniorityFit: 100, requiredSkillFit: 100,
      preferredSkillFit: 100, experienceFit: 100, domainFit: 100,
      criticalMismatch: true,
    });
    expect(combineLlmFit(perfect)).toBeLessThanOrEqual(30);
  });

  it('does not cap when criticalMismatch is false, even with low fit scores', () => {
    const weak = evaluation({
      roleFit: 10, seniorityFit: 10, requiredSkillFit: 10,
      preferredSkillFit: 10, experienceFit: 10, domainFit: 10,
      criticalMismatch: false,
    });
    expect(combineLlmFit(weak)).toBe(10);
  });

  it('does not raise a below-cap score when criticalMismatch is true', () => {
    const alreadyLow = evaluation({
      roleFit: 10, seniorityFit: 10, requiredSkillFit: 10,
      preferredSkillFit: 10, experienceFit: 10, domainFit: 10,
      criticalMismatch: true,
    });
    expect(combineLlmFit(alreadyLow)).toBe(10);
  });
});

describe('combineFinalScore', () => {
  const weights = { retrieval: 35, llm: 45, freshness: 10, preference: 10 };

  it('matches the documented weighted-sum formula when weights sum to 100', () => {
    const input = { retrievalScore: 60, llmScore: 80, freshnessScore: 40, preferenceScore: 50 };
    const expected = Math.round(60 * 0.35 + 80 * 0.45 + 40 * 0.10 + 50 * 0.10);
    const result = combineFinalScore(input, weights);
    expect(result.finalScore).toBe(expected);
  });

  it('normalizes weights that do not sum to 100, keeping the score in range', () => {
    const misconfigured = { retrieval: 35, llm: 4500, freshness: 10, preference: 10 };
    const result = combineFinalScore({ retrievalScore: 60, llmScore: 80, freshnessScore: 40, preferenceScore: 50 }, misconfigured);
    expect(result.finalScore).toBeGreaterThanOrEqual(0);
    expect(result.finalScore).toBeLessThanOrEqual(100);
  });

  it('never returns a score outside 0-100 even with extreme inputs', () => {
    const result = combineFinalScore({ retrievalScore: 100, llmScore: 100, freshnessScore: 100, preferenceScore: 100 }, weights);
    expect(result.finalScore).toBeLessThanOrEqual(100);
    const zero = combineFinalScore({ retrievalScore: 0, llmScore: 0, freshnessScore: 0, preferenceScore: 0 }, weights);
    expect(zero.finalScore).toBeGreaterThanOrEqual(0);
  });

  it.each([
    [95, 'APPLY_NOW'],
    [90, 'APPLY_NOW'],
    [85, 'STRONG_MATCH'],
    [80, 'STRONG_MATCH'],
    [75, 'CONSIDER'],
    [70, 'CONSIDER'],
    [65, 'LOW_PRIORITY'],
    [60, 'LOW_PRIORITY'],
    [59, 'SKIP'],
    [0, 'SKIP'],
  ])('assigns the correct band for score %i', (score, expectedBand) => {
    expect(bandFor(score)).toBe(expectedBand);
  });

  it('attaches the band matching the computed final score', () => {
    const result = combineFinalScore({ retrievalScore: 100, llmScore: 100, freshnessScore: 100, preferenceScore: 100 }, weights);
    expect(result.recommendation).toBe('APPLY_NOW');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest pipeline/ranking.spec.ts`
Expected: FAIL — `./ranking` module does not exist.

- [ ] **Step 3: Implement `pipeline/ranking.ts`**

```ts
import type { LlmJobEvaluation, Recommendation } from '@jobportal/shared';

/** Weights for collapsing LlmJobEvaluation's six fit dimensions into one
 * llm_score. Favors requiredSkillFit and roleFit — the two dimensions that
 * matter most for "should I apply". Code constants, not configurable: this
 * is an internal mapping, distinct from the top-level final-score weights
 * below, which ARE configurable (spec §18.2). */
export const RANKING_WEIGHTS = {
  requiredSkillFit: 0.35,
  roleFit: 0.25,
  seniorityFit: 0.15,
  domainFit: 0.10,
  preferredSkillFit: 0.10,
  experienceFit: 0.05,
} as const;

/** A true criticalMismatch caps llm_score here regardless of the weighted
 * average — "exceptional fit on paper" must not outrank "there is a
 * disqualifying issue" just because the six fit numbers look good. */
export const CRITICAL_MISMATCH_CAP = 30;

/** Collapses the six LLM fit dimensions into one 0-100 score. */
export function combineLlmFit(evaluation: LlmJobEvaluation): number {
  const weighted =
    evaluation.requiredSkillFit * RANKING_WEIGHTS.requiredSkillFit +
    evaluation.roleFit * RANKING_WEIGHTS.roleFit +
    evaluation.seniorityFit * RANKING_WEIGHTS.seniorityFit +
    evaluation.domainFit * RANKING_WEIGHTS.domainFit +
    evaluation.preferredSkillFit * RANKING_WEIGHTS.preferredSkillFit +
    evaluation.experienceFit * RANKING_WEIGHTS.experienceFit;
  const score = Math.round(weighted);
  return evaluation.criticalMismatch ? Math.min(score, CRITICAL_MISMATCH_CAP) : score;
}

export const RECOMMENDATION_BANDS: ReadonlyArray<{ min: number; label: Recommendation }> = [
  { min: 90, label: 'APPLY_NOW' },
  { min: 80, label: 'STRONG_MATCH' },
  { min: 70, label: 'CONSIDER' },
  { min: 60, label: 'LOW_PRIORITY' },
  { min: 0, label: 'SKIP' },
];

/** Maps a 0-100 final score to its recommendation band. Starting-point
 * thresholds from spec §18.4 — tunable later from application outcomes. */
export function bandFor(score: number): Recommendation {
  for (const band of RECOMMENDATION_BANDS) {
    if (score >= band.min) return band.label;
  }
  return 'SKIP';
}

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

/** Weighted sum of the four 0-100 inputs. Weights are normalized to sum to
 * 1 first, so a misconfigured env (weights not summing to 100) still
 * produces a score inside [0, 100] rather than violating the DB's
 * final_score check constraint at insert time. */
export function combineFinalScore(input: FinalScoreInput, weights: FinalScoreWeights): FinalScoreResult {
  const total = weights.retrieval + weights.llm + weights.freshness + weights.preference;
  const safeTotal = total > 0 ? total : 1;
  const normalized = {
    retrieval: weights.retrieval / safeTotal,
    llm: weights.llm / safeTotal,
    freshness: weights.freshness / safeTotal,
    preference: weights.preference / safeTotal,
  };

  const weighted =
    input.retrievalScore * normalized.retrieval +
    input.llmScore * normalized.llm +
    input.freshnessScore * normalized.freshness +
    input.preferenceScore * normalized.preference;

  const finalScore = Math.min(100, Math.max(0, Math.round(weighted)));
  return { finalScore, recommendation: bandFor(finalScore) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest pipeline/ranking.spec.ts`
Expected: PASS — 13 tests.

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: Same pre-existing errors as Task 2 Step 6 (ingest.service.ts etc.), nothing new from this file.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pipeline/ranking.ts apps/api/src/pipeline/ranking.spec.ts
git commit -m "feat(pipeline): combineLlmFit and combineFinalScore for the ranking stage"
```

---

## Task 4: `scorePreference` — work-mode/domain soft match

**Files:**
- Modify: `apps/api/src/pipeline/ranking.ts`
- Modify: `apps/api/src/pipeline/ranking.spec.ts`

**Interfaces:**
- Consumes: `NormalizedJob` (`pipeline/normalize.ts`, existing — has `.location`, `.isRemote`, `.description`, `.title`, `.companyName`).
- Produces: `PreferenceContext`, `scorePreference(job: NormalizedJob, ctx: PreferenceContext): number`. Task 6 calls this with `{ workModes: profile.work_modes, domainPreferences: profile.domain_preferences }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/pipeline/ranking.spec.ts`:

```ts
import { scorePreference } from './ranking';
import { normalizeCandidate } from './normalize';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

function job(overrides: Partial<RawJobCandidate> = {}) {
  return normalizeCandidate({
    candidate: {
      title: 'Backend Engineer',
      url: 'https://acme.com/careers/1',
      companyNameHint: 'Acme Fintech',
      locationHint: 'Remote',
      snippet: '',
      markdown: 'Join our fintech payments team building backend services.',
      source: 'http_scrape',
      postedDateIso: null,
      ...overrides,
    },
    companyId: 'company-1',
    companyName: 'Acme Fintech',
  });
}

describe('scorePreference', () => {
  it('returns the neutral default when both preference lists are empty', () => {
    expect(scorePreference(job(), { workModes: [], domainPreferences: [] })).toBe(50);
  });

  it('scores higher when the job is remote and the candidate prefers remote', () => {
    const remoteJob = job({ locationHint: 'Remote' });
    const onsiteJob = job({ locationHint: 'Bangalore Office, On-site' });
    const remoteScore = scorePreference(remoteJob, { workModes: ['remote'], domainPreferences: [] });
    const onsiteScore = scorePreference(onsiteJob, { workModes: ['remote'], domainPreferences: [] });
    expect(remoteScore).toBeGreaterThan(onsiteScore);
  });

  it('scores higher when the job domain matches a preferred domain', () => {
    const fintechJob = job({ markdown: 'Join our fintech payments team.' });
    const matched = scorePreference(fintechJob, { workModes: [], domainPreferences: ['fintech'] });
    const unmatched = scorePreference(fintechJob, { workModes: [], domainPreferences: ['healthcare'] });
    expect(matched).toBeGreaterThan(unmatched);
  });

  it('never throws on an empty description and empty location', () => {
    const bareJob = job({ markdown: '', snippet: '', locationHint: '' });
    expect(() => scorePreference(bareJob, { workModes: ['remote'], domainPreferences: ['fintech'] })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest pipeline/ranking.spec.ts`
Expected: FAIL — `scorePreference` is not exported.

- [ ] **Step 3: Implement `scorePreference`**

Add to `apps/api/src/pipeline/ranking.ts` (add the import for `containsWord` and `NormalizedJob`):

```ts
import { containsWord } from '../common/text.util';
import type { NormalizedJob } from './normalize';
```

```ts
const PREFERENCE_NEUTRAL = 50;
const PREFERENCE_MATCH = 80;
const PREFERENCE_MISMATCH = 30;
const WORK_MODE_MARKERS: Record<string, string[]> = {
  remote: ['remote', 'work from home', 'wfh', 'fully distributed'],
  hybrid: ['hybrid'],
  onsite: ['on-site', 'onsite', 'in-office', 'in office'],
};

export interface PreferenceContext {
  workModes: readonly string[];
  domainPreferences: readonly string[];
}

/** Soft 0-100 match of the job's detected work mode and domain against the
 * candidate's stated preferences. Returns the neutral default when the
 * profile has set neither — an unset preference is not evidence of a bad
 * fit, same principle as sub-project 3's empty target_roles/preferred_locations
 * handling. */
export function scorePreference(job: NormalizedJob, ctx: PreferenceContext): number {
  const hasWorkModePref = ctx.workModes.length > 0;
  const hasDomainPref = ctx.domainPreferences.length > 0;
  if (!hasWorkModePref && !hasDomainPref) return PREFERENCE_NEUTRAL;

  const haystack = `${job.location ?? ''} ${job.description.slice(0, 1500)}`.toLowerCase();
  const scores: number[] = [];

  if (hasWorkModePref) {
    const jobModes = Object.entries(WORK_MODE_MARKERS)
      .filter(([mode]) => (mode === 'remote' ? job.isRemote : false) || WORK_MODE_MARKERS[mode].some((m) => haystack.includes(m)))
      .map(([mode]) => mode);
    const matches = ctx.workModes.some((pref) => jobModes.includes(pref.trim().toLowerCase()));
    scores.push(jobModes.length === 0 ? PREFERENCE_NEUTRAL : matches ? PREFERENCE_MATCH : PREFERENCE_MISMATCH);
  }

  if (hasDomainPref) {
    const domainHaystack = `${job.companyName} ${job.title} ${job.description.slice(0, 1500)}`;
    const matches = ctx.domainPreferences.some((domain) => containsWord(domainHaystack, domain));
    scores.push(matches ? PREFERENCE_MATCH : PREFERENCE_NEUTRAL);
  }

  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest pipeline/ranking.spec.ts`
Expected: PASS — 17 tests total (13 from Task 3 + 4 new).

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: Same pre-existing errors as before, nothing new.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pipeline/ranking.ts apps/api/src/pipeline/ranking.spec.ts
git commit -m "feat(pipeline): scorePreference — work-mode/domain soft match"
```

---

## Task 5: Migration 0009 — ranking columns

**Files:**
- Create: `db/migrations/0009_final_ranking.sql`

**Interfaces:**
- Consumes: nothing (pure SQL).
- Produces: `skill_gap_analysis.llm_score/confidence/critical_mismatch/critical_gaps/role_fit/seniority_fit/required_skill_fit/preferred_skill_fit/experience_fit/domain_fit`, `job_postings.final_score/recommendation/preference_score`, `job_postings_enriched` view gaining those columns. Task 6 writes to and reads these columns; Task 1's `JobDetail.llm_evaluation`/`JobListItem.final_score` assume they exist.

- [ ] **Step 1: Write the migration**

```sql
-- ===========================================================================
-- 0009_final_ranking.sql — multi-dimensional LLM evaluation + deterministic
-- final score. See docs/superpowers/specs/2026-10-05-reranking-final-ranking-design.md §7.
--
-- Idempotent. Apply in the Supabase SQL Editor BEFORE deploying the code that
-- writes final_score/llm_score (Render auto-deploys main).
-- ===========================================================================

alter table public.skill_gap_analysis
  add column if not exists llm_score integer check (llm_score between 0 and 100),
  add column if not exists confidence integer check (confidence between 0 and 100),
  add column if not exists critical_mismatch boolean,
  add column if not exists critical_gaps jsonb,
  add column if not exists role_fit integer check (role_fit between 0 and 100),
  add column if not exists seniority_fit integer check (seniority_fit between 0 and 100),
  add column if not exists required_skill_fit integer check (required_skill_fit between 0 and 100),
  add column if not exists preferred_skill_fit integer check (preferred_skill_fit between 0 and 100),
  add column if not exists experience_fit integer check (experience_fit between 0 and 100),
  add column if not exists domain_fit integer check (domain_fit between 0 and 100);

alter table public.job_postings
  add column if not exists final_score integer check (final_score between 0 and 100),
  add column if not exists recommendation text,
  add column if not exists preference_score integer check (preference_score between 0 and 100);

create index if not exists job_postings_final_score_idx
  on public.job_postings (user_id, final_score desc);

-- Postgres only allows appending columns to a view, so the new ones go last.
create or replace view public.job_postings_enriched as
select
  j.id,
  j.user_id,
  j.company_id,
  j.title,
  coalesce(j.company_name, c.name)                as company_name,
  j.location,
  j.url,
  j.description_raw,
  j.seniority_guess,
  j.posted_date,
  j.scraped_at,
  j.status,
  j.source,
  j.created_at,
  j.updated_at,
  a.match_score,
  coalesce(a.matched_skills, '[]'::jsonb)         as matched_skills,
  coalesce(a.missing_skills, '[]'::jsonb)         as missing_skills,
  a.summary_text,
  a.analyzed_at,
  coalesce(n.note_count, 0)                       as note_count,
  coalesce(h.last_status_change_at, j.created_at) as last_status_change_at,
  j.external_id,
  j.retrieval_score,
  j.retrieval_signals,
  j.final_score,
  j.recommendation,
  j.preference_score,
  a.llm_score,
  a.confidence,
  a.critical_mismatch,
  coalesce(a.critical_gaps, '[]'::jsonb)          as critical_gaps,
  a.role_fit,
  a.seniority_fit,
  a.required_skill_fit,
  a.preferred_skill_fit,
  a.experience_fit,
  a.domain_fit
from public.job_postings j
left join public.job_portal_companies c
  on c.id = j.company_id
left join public.skill_gap_analysis a
  on a.job_posting_id = j.id
left join lateral (
  select count(*)::int as note_count
  from public.application_notes an
  where an.job_posting_id = j.id
) n on true
left join lateral (
  select max(sh.changed_at) as last_status_change_at
  from public.status_history sh
  where sh.job_posting_id = j.id
) h on true;

alter view public.job_postings_enriched set (security_invoker = true);
```

- [ ] **Step 2: Verify against existing migrations**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json` (no-op sanity check — SQL isn't typechecked, but this confirms Task 1-4 haven't broken anything before this review step)

Read `db/migrations/0008_processing_pipeline.sql` side-by-side with this file and confirm: every column from 0008's view definition (`external_id`, `retrieval_score`, `retrieval_signals`) is still present unchanged in this migration's view (only new columns appended after them); `security_invoker = true` is re-applied after the `create or replace view` (`create or replace` resets view options); no existing column is dropped or renamed.

Expected: visual match confirmed — 0008's 23 columns appear first in the same order, then this migration's 12 new ones.

- [ ] **Step 3: Commit**

```bash
git add db/migrations/0009_final_ranking.sql
git commit -m "feat(db): migration 0009 for LLM evaluation breakdown and final_score"
```

---

## Task 6: Wire ranking into `IngestService` — config, `analyzeAndPersist`, `InsertedJob.retrievalScore`

**Files:**
- Modify: `apps/api/src/config/configuration.ts`
- Modify: `apps/api/src/ingest/ingest.service.ts`
- Modify: `apps/api/src/ingest/ingest.service.spec.ts`

**Interfaces:**
- Consumes: `combineLlmFit`, `scorePreference`, `combineFinalScore`, `PreferenceContext` (Task 3/4, `pipeline/ranking.ts`); `freshnessPoints` is NOT currently exported from `pipeline/retrieval-score.ts` — this task exports it (see Step 3).
- Produces: `InsertedJob.retrievalScore: number` (new field — `InsertedJob` currently has `id/title/companyName/location/description` only); `AppConfig.ranking: { weightRetrieval, weightLlm, weightFreshness, weightPreference }`.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/ingest/ingest.service.spec.ts`, the existing `scoredJob()` helper (module-level, used throughout this file) builds a `ScoredJob` whose `.job` is an `InsertedJob`-shaped `NormalizedJob` — check its current definition first; this task's test additions assume `InsertedJob` now carries `retrievalScore`. Add near the bottom of the file (after the existing `describe('IngestService.buildAnalysisPool', ...)` block):

```ts
import { combineLlmFit, combineFinalScore, scorePreference } from '../pipeline/ranking';
import type { LlmJobEvaluation } from '@jobportal/shared';

function llmEvaluation(overrides: Partial<LlmJobEvaluation> = {}): LlmJobEvaluation {
  return {
    roleFit: 80,
    seniorityFit: 70,
    requiredSkillFit: 90,
    preferredSkillFit: 60,
    experienceFit: 75,
    domainFit: 50,
    criticalMismatch: false,
    matchedSkills: ['nodejs'],
    missingSkills: ['kubernetes'],
    criticalGaps: [],
    summary: 'Strong backend match.',
    confidence: 85,
    ...overrides,
  };
}

describe('IngestService.analyzeAndPersist — final score wiring', () => {
  function buildServiceWithAnalysis(evaluation: LlmJobEvaluation | null) {
    const upserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const fromResult = (table: string) => ({
      upsert: (payload: Record<string, unknown>) => {
        upserts.push({ table, payload });
        return { error: null };
      },
      update: (payload: Record<string, unknown>) => {
        updates.push({ table, payload });
        return { eq: async () => ({ error: null }) };
      },
    });
    const supabase = {
      admin: { from: (table: string) => fromResult(table) },
      unwrap: (result: { data: unknown; error: unknown }) => result.data ?? [],
    };
    const analysis = {
      isConfigured: true,
      analyze: async () => evaluation,
    };
    const skills = { ensure: async () => new Map<string, string>() };
    const service = new IngestService(
      supabase as any,
      {} as any, // firecrawl
      analysis as any,
      {} as any, // companies
      skills as any,
      {} as any, // resolver
      {
        get: (key: string, fallback?: unknown) => {
          const weights: Record<string, number> = {
            'ranking.weightRetrieval': 35,
            'ranking.weightLlm': 45,
            'ranking.weightFreshness': 10,
            'ranking.weightPreference': 10,
          };
          return weights[key] ?? fallback;
        },
      } as any,
      {} as any, // cv
    );
    return { service, upserts, updates };
  }

  function insertedJob(overrides: Partial<InsertedJob & { retrievalScore: number }> = {}) {
    return {
      id: 'job-1',
      title: 'Backend Engineer',
      companyName: 'Acme',
      location: 'Remote',
      description: 'A long enough job description to be analyzable by Groq, building backend services.',
      retrievalScore: 70,
      postedDateIso: null,
      workModes: [],
      domainPreferences: [],
      ...overrides,
    } as any;
  }

  it('writes final_score and recommendation onto job_postings when Groq succeeds', async () => {
    const { service, updates } = buildServiceWithAnalysis(llmEvaluation());

    await (service as any).analyzeAndPersist('user-1', insertedJob());

    const jobPostingsUpdate = updates.find((u) => u.table === 'job_postings' && 'final_score' in u.payload);
    expect(jobPostingsUpdate).toBeDefined();
    expect(jobPostingsUpdate!.payload.final_score).toEqual(expect.any(Number));
    expect(jobPostingsUpdate!.payload.recommendation).toEqual(expect.any(String));
  });

  it('writes the full LLM breakdown and match_score alias onto skill_gap_analysis', async () => {
    const { service, upserts } = buildServiceWithAnalysis(llmEvaluation({ requiredSkillFit: 90 }));

    await (service as any).analyzeAndPersist('user-1', insertedJob());

    const analysisUpsert = upserts.find((u) => u.table === 'skill_gap_analysis');
    expect(analysisUpsert).toBeDefined();
    expect(analysisUpsert!.payload.required_skill_fit).toBe(90);
    expect(analysisUpsert!.payload.critical_mismatch).toBe(false);
    expect(analysisUpsert!.payload.llm_score).toEqual(expect.any(Number));
    // match_score kept as an alias of llm_score for the transition period.
    expect(analysisUpsert!.payload.match_score).toBe(analysisUpsert!.payload.llm_score);
  });

  it('does nothing when Groq returns null (unconfigured or parse failure)', async () => {
    const { service, upserts, updates } = buildServiceWithAnalysis(null);

    const ok = await (service as any).analyzeAndPersist('user-1', insertedJob());

    expect(ok).toBe(false);
    expect(upserts).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('caps final_score contribution when criticalMismatch is true', async () => {
    const { service: normalService, updates: normalUpdates } = buildServiceWithAnalysis(llmEvaluation({ criticalMismatch: false }));
    const { service: mismatchService, updates: mismatchUpdates } = buildServiceWithAnalysis(
      llmEvaluation({ criticalMismatch: true, roleFit: 100, seniorityFit: 100, requiredSkillFit: 100, preferredSkillFit: 100, experienceFit: 100, domainFit: 100 }),
    );

    await (normalService as any).analyzeAndPersist('user-1', insertedJob({ retrievalScore: 90 }));
    await (mismatchService as any).analyzeAndPersist('user-1', insertedJob({ retrievalScore: 90 }));

    const normalScore = normalUpdates.find((u) => u.table === 'job_postings')!.payload.final_score as number;
    const mismatchScore = mismatchUpdates.find((u) => u.table === 'job_postings')!.payload.final_score as number;
    expect(mismatchScore).toBeLessThan(normalScore);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest ingest/ingest.service.spec.ts`
Expected: FAIL — `../pipeline/ranking` combineLlmFit/combineFinalScore/scorePreference exist (Tasks 3-4 shipped them), but `analyzeAndPersist` still writes `match_score`/`matched_skills` from the old `SkillGapResult` shape (now gone per Task 2) and never touches `final_score`/`recommendation`/`llm_score`. This fails as a TS compile error in `ingest.service.ts` (the old `result.match_score` etc. read off a value now typed `LlmJobEvaluation | null`, which has no `match_score` field) before it even reaches the new assertions — expected, matches sub-project 3's pattern of ts-jest surfacing missing-shape errors as RED.

- [ ] **Step 3: Export `freshnessPoints` from `retrieval-score.ts`**

In `apps/api/src/pipeline/retrieval-score.ts`, change:

```ts
function freshnessPoints(postedDateIso: string | null, now: Date): number {
```

to:

```ts
export function freshnessPoints(postedDateIso: string | null, now: Date): number {
```

(No other change to this file — it already computes freshness correctly; Task 6 just needs to call it again outside `scoreRetrieval`.)

- [ ] **Step 4: Add ranking config**

In `apps/api/src/config/configuration.ts`, add to `AppConfig`:

```ts
  ranking: {
    /** Top-level final_score weights (spec §18.2) — need not sum to 100;
     * combineFinalScore normalizes. */
    weightRetrieval: number;
    weightLlm: number;
    weightFreshness: number;
    weightPreference: number;
  };
```

and to the default export, after the `ingest` block:

```ts
  ranking: {
    weightRetrieval: int('RANKING_WEIGHT_RETRIEVAL', 35),
    weightLlm: int('RANKING_WEIGHT_LLM', 45),
    weightFreshness: int('RANKING_WEIGHT_FRESHNESS', 10),
    weightPreference: int('RANKING_WEIGHT_PREFERENCE', 10),
  },
```

- [ ] **Step 5: Add `retrievalScore` to `InsertedJob` and thread it through `insertOne`**

In `apps/api/src/ingest/ingest.service.ts`, change the `InsertedJob` interface:

```ts
export interface InsertedJob {
  id: string;
  title: string;
  companyName: string | null;
  location: string | null;
  description: string;
  retrievalScore: number;
}
```

In `insertOne` (the method that builds the return value after a successful upsert — currently ends with `return { id: ..., title: job.title, companyName: job.companyName, location: job.location, description: job.description };`), add `retrievalScore: score` to that returned object (`score` is already in scope — it's the parameter destructured at the top of `insertOne` as `const { job, score, signals } = item;`).

In `toAnalysisCandidates` (in this same file — the function that builds `AnalysisCandidate.job` from a `BacklogRow`), add `retrievalScore: score` to the `job:` object it constructs (the local `score` variable there is already resolved to a number by that point in the function, either from `row.retrieval_score` or from `result.score`).

- [ ] **Step 6: Rewrite `analyzeAndPersist`**

Replace the method body:

```ts
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
    const freshnessScore = freshnessPoints(null, new Date()) * (100 / RETRIEVAL_WEIGHTS.freshness);
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

    await this.persistJobSkills(
      job.id,
      [...evaluation.matchedSkills, ...evaluation.missingSkills].map((name) => ({
        name,
        required: evaluation.missingSkills.includes(name) ? true : false,
      })),
    );
    return true;
  }
```

Note on the last block: `LlmJobEvaluation` has no `required_skills: Array<{name, required}>` field (that was `SkillGapResult`-specific). `matchedSkills`/`missingSkills` are the closest equivalent; this maps missing skills to `required: true` (the JD needs it and the candidate lacks it) and matched skills to `required: false` (already satisfied — not what `job_skills.required` originally meant, but the closest honest mapping available from the new shape). This is a judgment call: if a reviewer or the plan author disagrees on this mapping being right, ledger it as a ruling rather than silently changing `persistJobSkills`'s contract.

Also remove the old seniority-guess update block (`if (result.seniority_guess !== 'unknown') { ... }`) — `LlmJobEvaluation` has no seniority guess field; this functionality is dropped, not replaced, per this task (the spec's `LlmJobEvaluation` shape in §17.3 genuinely omits it; re-adding it is out of scope and not requested anywhere in the parent spec for this sub-project).

Add the new imports at the top of `ingest.service.ts`:

```ts
import { combineLlmFit, combineFinalScore, scorePreference } from '../pipeline/ranking';
import { RETRIEVAL_WEIGHTS, freshnessPoints } from '../pipeline/retrieval-score';
```

(`RETRIEVAL_WEIGHTS` is already exported from `retrieval-score.ts`; only `freshnessPoints` needed the new export from Step 3.)

- [ ] **Step 7: Run to verify it passes**

Run: `cd apps/api && npx jest ingest/ingest.service.spec.ts`
Expected: PASS — all existing ingest tests plus the 4 new ones in this task.

- [ ] **Step 8: Typecheck and full suite**

Run: `cd packages/shared && npm run build && cd ../../apps/api && npm run typecheck && npm test`
Expected: typecheck clean (no more pre-existing errors from Tasks 2-5); every suite passes.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/config/configuration.ts apps/api/src/ingest/ingest.service.ts apps/api/src/ingest/ingest.service.spec.ts apps/api/src/pipeline/retrieval-score.ts
git commit -m "feat(ingest): wire final_score/recommendation into analyzeAndPersist"
```

---

## Task 7: API surface — `jobs.service.ts`, `jobs.controller.ts` DTO, `JobsService.toListItem`/`findOne`/`stats`

**Files:**
- Modify: `apps/api/src/jobs/jobs.service.ts`
- Modify: `apps/api/src/jobs/dto/job.dto.ts`
- Test: `apps/api/src/jobs/jobs.service.spec.ts` (check whether this file exists first — if not, this task creates it with only the tests below; if it exists, append to it)

**Interfaces:**
- Consumes: `JobListItem.final_score`/`recommendation`, `JobDetail.llm_evaluation`/`preference_score` (Task 1).
- Produces: nothing new consumed by later tasks — this is the last backend task in this plan (web UI is out of scope, per Global Constraints).

- [ ] **Step 1: Write the failing tests**

If `apps/api/src/jobs/jobs.service.spec.ts` does not exist, create it with:

```ts
import { JobsService } from './jobs.service';

function buildServiceWithRow(row: Record<string, unknown>) {
  const fromResult: any = {
    select: () => fromResult,
    eq: () => fromResult,
    in: () => fromResult,
    gte: () => fromResult,
    lte: () => fromResult,
    is: () => fromResult,
    contains: () => fromResult,
    or: () => fromResult,
    order: () => fromResult,
    range: async () => ({ data: [row], error: null, count: 1 }),
    maybeSingle: async () => ({ data: row, error: null }),
  };
  const supabase = {
    admin: { from: () => fromResult },
    unwrap: (result: { data: unknown; error: unknown }) => result.data ?? [],
    unwrapMaybe: (result: { data: unknown; error: unknown }) => result.data ?? null,
  };
  const service = new JobsService(supabase as any, { get: (_k: string, fallback?: unknown) => fallback } as any);
  return service;
}

function enrichedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    user_id: 'user-1',
    company_id: 'company-1',
    title: 'Backend Engineer',
    company_name: 'Acme',
    location: 'Remote',
    url: 'https://acme.com/careers/1',
    seniority_guess: 'mid',
    posted_date: '2026-10-01',
    scraped_at: '2026-10-01T00:00:00Z',
    status: 'new',
    source: 'ats_api',
    match_score: 78,
    matched_skills: ['nodejs'],
    missing_skills: ['kubernetes'],
    summary_text: 'Good fit.',
    analyzed_at: '2026-10-02T00:00:00Z',
    note_count: 0,
    last_status_change_at: null,
    final_score: 82,
    recommendation: 'STRONG_MATCH',
    llm_score: 78,
    confidence: 85,
    critical_mismatch: false,
    critical_gaps: [],
    role_fit: 80,
    seniority_fit: 70,
    required_skill_fit: 90,
    preferred_skill_fit: 60,
    experience_fit: 75,
    domain_fit: 50,
    preference_score: 65,
    ...overrides,
  };
}

describe('JobsService.list — final_score surfacing', () => {
  it('includes final_score and recommendation on each list item', async () => {
    const service = buildServiceWithRow(enrichedRow());
    const result = await service.list('user-1', {});
    expect(result.items[0].final_score).toBe(82);
    expect(result.items[0].recommendation).toBe('STRONG_MATCH');
  });

  it('returns null final_score/recommendation for an unanalyzed job without crashing', async () => {
    const service = buildServiceWithRow(enrichedRow({ final_score: null, recommendation: null }));
    const result = await service.list('user-1', {});
    expect(result.items[0].final_score).toBeNull();
    expect(result.items[0].recommendation).toBeNull();
  });
});

describe('JobsService.findOne — llm_evaluation breakdown', () => {
  it('builds the full breakdown when the job has been analyzed', async () => {
    const service = buildServiceWithRow(enrichedRow());
    // findOne also queries job_postings/application_notes/status_history/job_skills —
    // the shared fromResult above returns the same row shape for all of them,
    // so descriptionResult/notesResult/historyResult/skillsResult each resolve
    // via maybeSingle/select chains already stubbed above.
    const detail = await service.findOne('user-1', 'job-1');
    expect(detail.llm_evaluation).toEqual({
      llm_score: 78,
      role_fit: 80,
      seniority_fit: 70,
      required_skill_fit: 90,
      preferred_skill_fit: 60,
      experience_fit: 75,
      domain_fit: 50,
      critical_mismatch: false,
      critical_gaps: [],
      confidence: 85,
    });
    expect(detail.preference_score).toBe(65);
  });

  it('returns a null llm_evaluation for an unanalyzed job', async () => {
    const service = buildServiceWithRow(enrichedRow({ llm_score: null, role_fit: null }));
    const detail = await service.findOne('user-1', 'job-1');
    expect(detail.llm_evaluation).toBeNull();
  });
});
```

Note: `findOne` makes 4 parallel queries beyond the enriched-row lookup (`description_raw`/notes/history/job_skills) — the shared mock's `.single()`/`.select()` chain needs a `single` method too if the real code calls it; check the real `findOne` implementation's exact chain calls (`jobs.service.ts:98-118`, already read during planning) and extend `fromResult` with a `single: async () => ({ data: { description_raw: '...', created_at: '...', updated_at: '...' }, error: null })` method before this test can pass. This is a known gap in the mock sketch above — resolve it against the actual chain shape while implementing, and ledger it if the real shape forces a different mock structure than written here.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest jobs/jobs.service.spec.ts`
Expected: FAIL — `toListItem` doesn't read `final_score`/`recommendation` yet; `findOne` doesn't build `llm_evaluation`/`preference_score`.

- [ ] **Step 3: Update `EnrichedRow`, `toListItem`, and `findOne`**

In `apps/api/src/jobs/jobs.service.ts`, extend the `EnrichedRow` interface (after `last_status_change_at: string | null;`):

```ts
  final_score: number | null;
  recommendation: string | null;
  llm_score: number | null;
  confidence: number | null;
  critical_mismatch: boolean | null;
  critical_gaps: unknown;
  role_fit: number | null;
  seniority_fit: number | null;
  required_skill_fit: number | null;
  preferred_skill_fit: number | null;
  experience_fit: number | null;
  domain_fit: number | null;
  preference_score: number | null;
```

In `toListItem`, add to the returned object (after `is_stale: isStale,`):

```ts
      final_score: row.final_score,
      recommendation: row.recommendation as JobListItem['recommendation'],
```

Add a private helper and use it in `findOne`:

```ts
  private toLlmEvaluation(row: EnrichedRow): JobDetail['llm_evaluation'] {
    if (row.llm_score === null || row.role_fit === null) return null;
    return {
      llm_score: row.llm_score,
      role_fit: row.role_fit,
      seniority_fit: row.seniority_fit ?? 0,
      required_skill_fit: row.required_skill_fit ?? 0,
      preferred_skill_fit: row.preferred_skill_fit ?? 0,
      experience_fit: row.experience_fit ?? 0,
      domain_fit: row.domain_fit ?? 0,
      critical_mismatch: row.critical_mismatch ?? false,
      critical_gaps: asStringArray(row.critical_gaps),
      confidence: row.confidence ?? 0,
    };
  }
```

In `findOne`, change the return statement:

```ts
    const listItem = this.toListItem(row);
    return {
      ...listItem,
      description_raw: extra.description_raw,
      created_at: extra.created_at,
      updated_at: extra.updated_at,
      notes,
      history,
      required_skills: requiredSkills,
      llm_evaluation: this.toLlmEvaluation(row),
      preference_score: row.preference_score,
    };
```

- [ ] **Step 4: Add `final_score`/`min_score`/`max_score`/`sort` filtering**

In `list()`, change the `min_score`/`max_score`/`unscored_only`/sort block:

```ts
    if (query.min_score !== undefined) builder = builder.gte('final_score', query.min_score);
    if (query.max_score !== undefined) builder = builder.lte('final_score', query.max_score);
    if (query.unscored_only) builder = builder.is('final_score', null);
```

```ts
    const sortColumn = query.sort ?? 'final_score';
```

This is a deliberate behavior change from sub-project 3 (where these filtered/defaulted on `match_score`) — documented in spec §10 ("Filters: min_score/max_score query params now filter on final_score"). Nulls still sort last via the existing `nullsFirst: false`.

- [ ] **Step 5: Update `job.dto.ts`'s sort validator**

In `apps/api/src/jobs/dto/job.dto.ts`:

```ts
  @IsOptional()
  @IsIn(['final_score', 'match_score', 'scraped_at', 'posted_date', 'title'])
  sort?: 'final_score' | 'match_score' | 'scraped_at' | 'posted_date' | 'title';
```

- [ ] **Step 6: Run to verify tests pass**

Run: `cd apps/api && npx jest jobs/jobs.service.spec.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and full suite**

Run: `cd packages/shared && npm run build && cd ../../apps/api && npm run typecheck && npm test`
Expected: typecheck clean; every suite passes.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/jobs/jobs.service.ts apps/api/src/jobs/jobs.service.spec.ts apps/api/src/jobs/dto/job.dto.ts
git commit -m "feat(jobs): surface final_score, recommendation, and llm_evaluation breakdown"
```

- [ ] **Step 9: Flag the pending migration**

Report that `db/migrations/0009_final_ranking.sql` must be applied in the Supabase SQL Editor before this branch is pushed: until it is, `analyzeAndPersist`'s writes to `final_score`/`llm_score`/the fit columns fail (surfaced in the run's errors), and `jobs.service.ts`'s reads of those columns from `job_postings_enriched` fail.

---

## Plan Self-Review Notes

**Spec coverage:** §17 (LlmRerankingModule) → Tasks 1, 2. §18.2 (final-score formula) → Task 3. §18.3 (hard gate) → structurally guaranteed — `analyzeAndPersist` only ever runs on jobs that already passed `evaluateEligibility` in sub-project 3; no new gate needed, confirmed in Task 6's design. §18.4 (recommendation bands) → Task 3. §18.5 (explanation) → Task 7's `llm_evaluation`/`critical_gaps`/`missing_skills`/`matched_skills` surface the inputs a web UI follow-on renders as the explanation; the prose generation itself is `evaluation.summary`, already produced in Task 2. §12 decisions (preference meaning, compute-at-analysis-time, env-var weights, kept `match_score` alias, dashboard surfacing final_score) → Tasks 3, 4, 6, 7. §7 migration → Task 5. §9 ingest flow → Task 6.

**Type consistency:** `LlmJobEvaluation` (Task 1) is the type `AnalysisService.analyze()` returns (Task 2), `combineLlmFit` consumes (Task 3), and `analyzeAndPersist` destructures (Task 6) — verified identical field names/types across all three. `FinalScoreInput`/`FinalScoreWeights`/`FinalScoreResult` (Task 3) are used verbatim in Task 6's `combineFinalScore` call. `PreferenceContext` (Task 4) matches what Task 6 passes (`workModes`/`domainPreferences` from `CvProfile.work_modes`/`domain_preferences`, already existing fields per sub-project 1). `InsertedJob.retrievalScore` (Task 6) is produced by both `insertOne` and `toAnalysisCandidates` — both call sites updated in the same task. `EnrichedRow` (Task 7) field names match migration 0009's column names (Task 5) exactly (`llm_score`, `role_fit`, etc.).

**Review Focus:** criticalMismatch cap → Task 3's dedicated tests (`caps the result when criticalMismatch is true`) plus Task 6's wiring test (`caps final_score contribution when criticalMismatch is true`). Pre-migration null jobs → Task 7's `returns null final_score/recommendation for an unanalyzed job without crashing` and `returns a null llm_evaluation for an unanalyzed job`. Misconfigured weights → Task 3's `normalizes weights that do not sum to 100, keeping the score in range`. Empty work_modes/domain_preferences → Task 4's `returns the neutral default when both preference lists are empty`. Malformed Groq response → Task 2's 7 validator tests covering clamping, defaults, truncation.
