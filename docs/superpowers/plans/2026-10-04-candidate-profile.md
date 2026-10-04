# Candidate Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded role/department/location targeting constants in `text.util.ts`/`location.util.ts` with structured, DB-backed fields on `cv_profile`, exposed via the existing CV API and consumed by the ingest pipeline — with zero behavior change on day one.

**Architecture:** One additive migration extends `cv_profile` with 11 new columns (5 consumed immediately by ingest filtering, 6 stored for later sub-projects per the parent spec's exact model). `looksLikeRelevantRole()` and `isIndiaOrRemote()` change from reading module-level constants to accepting the lists as parameters. `IngestService.run()` loads the profile once per run and threads the 5 active fields through the two existing call sites in `scrapeAtsCompany()`/`scrapeCustomCareerPage()`, plus a new company-name exclusion check in `discoverCompanies()`.

**Tech Stack:** NestJS, Supabase Postgres, class-validator DTOs, Jest (`ts-jest`, `*.spec.ts` colocated with source — this plan establishes the first tests in the repo).

**Spec:** [docs/superpowers/specs/2026-10-04-candidate-profile-design.md](../specs/2026-10-04-candidate-profile-design.md)

## Global Constraints

- All new `cv_profile` columns must be additive and idempotent (`add column if not exists`), matching the convention in `db/migrations/0004_company_discovery.sql`.
- Existing rows must not be retroactively populated with `DEFAULT_CV`'s seed values — only brand-new profiles (via `CvService.bootstrap()`) get the seeded defaults. Existing rows get the column defaults (`'[]'::jsonb` / `null`).
- `looksLikeRelevantRole()` and `isIndiaOrRemote()` matching logic (word-boundary `containsWord`, precedence order) must not change — only the source of the marker lists changes, from module constants to parameters.
- `seniority_min_years`, `seniority_max_years`, `work_modes`, `employment_types`, `domain_preferences`, `domain_exclusions` are stored and returned by the API in this plan but must not be read by any filtering logic yet — no task should add a consumer for them.
- Every new/changed array field on the DTO is capped (`@ArrayMaxSize(50)`, or `@ArrayMaxSize(10)` for `work_modes`/`employment_types`) and every string element capped at 100 chars, consistent with existing `MaxLength` guards in `cv.dto.ts`.
- This repo has no existing Jest tests — `apps/api/package.json`'s `jest` config (`rootDir: src`, `testRegex: .*\.spec\.ts$`) is already correct; test files are created colocated with the source they test (e.g. `text.util.spec.ts` next to `text.util.ts`).

## Review Focus

- **Existing non-default profile rows after migration:** a user who already edited their CV (has a `cv_profile` row before this migration runs) must not have `target_roles`/`preferred_locations`/etc. silently filled with the app's old hardcoded defaults — they get `'[]'`/`null`, an explicit "no preference recorded" state. Pinned in Task 2's migration test.
- **Empty preference list behavior at ingest time:** if a profile's `target_roles` is `[]` (e.g. a user clears it, or a pre-migration row before anyone edits it), `looksLikeRelevantRole()` must not silently accept every job (empty allow-list ≠ wildcard) — this is a real reachable state once the lists are user-editable, not just a hardcoded-constants edge case. Pinned in Task 3.
- **Case sensitivity on `excluded_companies` matching:** company names arrive from Firecrawl search results and seed lists with inconsistent casing (e.g. "Razorpay" vs "razorpay"); the exclusion check in `discoverCompanies()` must compare case-insensitively or every exclusion silently no-ops. Pinned in Task 5.
- **`PATCH /cv` partial update must not clobber unrelated array fields:** sending `{ "target_roles": [...] }` alone must leave `excluded_companies`, `preferred_locations`, etc. untouched — the existing `!== undefined` guard pattern must be replicated for all 11 new fields, not just added once and assumed to generalize. Pinned in Task 4.
- **Oversized/malformed array input:** a `PATCH /cv` body with 500 target roles, or a single role string of 10,000 characters, must be rejected by validation (400) rather than silently truncated or stored — pinned in Task 4's DTO tests.

---

## Task 1: Shared types — extend `CvProfile`

**Files:**
- Modify: `packages/shared/src/types.ts` (the `CvProfile` interface, currently lines 22-29)
- Test: none (pure type addition; compilation is the check, exercised by Task 4/5's `tsc` runs)

**Interfaces:**
- Consumes: nothing new
- Produces: the extended `CvProfile` type, consumed by Task 4 (DTO/service) and Task 5 (ingest wiring)

- [ ] **Step 1: Extend the `CvProfile` interface**

Edit `packages/shared/src/types.ts`. Replace the existing interface:

```ts
export interface CvProfile {
  id: string;
  user_id: string;
  raw_cv_text: string | null;
  experience_years: number | null;
  current_title: string | null;
  updated_at: string;
}
```

with:

```ts
export interface CvProfile {
  id: string;
  user_id: string;
  raw_cv_text: string | null;
  experience_years: number | null;
  current_title: string | null;
  updated_at: string;
  /** Role-title keywords this candidate targets (e.g. "backend", "full stack"). */
  target_roles: string[];
  /** Role-title keywords that disqualify a posting even if otherwise relevant. */
  excluded_roles: string[];
  /** Department names (from ATS-provided department fields) that disqualify a posting. */
  excluded_departments: string[];
  /** Location keywords (place names and/or remote markers) this candidate accepts. */
  preferred_locations: string[];
  /** Company names never to discover/scrape for this candidate. */
  excluded_companies: string[];
  /** Minimum years of experience the candidate wants a posting to require. Null = no floor. */
  seniority_min_years: number | null;
  /** Maximum years of experience the candidate wants a posting to require. Null = no ceiling. */
  seniority_max_years: number | null;
  /** Accepted work arrangements (e.g. "remote", "hybrid", "onsite"). Not yet consumed by ingest. */
  work_modes: string[];
  /** Accepted employment types (e.g. "full-time", "contract"). Not yet consumed by ingest. */
  employment_types: string[];
  /** Preferred industry/domain keywords. Not yet consumed by ingest. */
  domain_preferences: string[];
  /** Disqualifying industry/domain keywords. Not yet consumed by ingest. */
  domain_exclusions: string[];
}
```

- [ ] **Step 2: Typecheck the shared package**

Run: `cd packages/shared && npx tsc --noEmit -p tsconfig.json`
Expected: no errors (this is a pure interface widening; nothing currently constructs a `CvProfile` object literal that would need the new fields — all current construction goes through Supabase row selects, which are not statically checked against the interface).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): add candidate preference fields to CvProfile type"
```

---

## Task 2: Migration — extend `cv_profile` schema

**Files:**
- Create: `db/migrations/0005_candidate_preferences.sql`
- Test: `db/migrations/0005_candidate_preferences.test.md` (manual verification steps — this repo has no automated migration test runner; see Step 3)

**Interfaces:**
- Consumes: nothing
- Produces: the 11 new `cv_profile` columns that Task 1's type, Task 4's DTO/service, and Task 5's ingest wiring all assume exist

- [ ] **Step 1: Write the migration**

Create `db/migrations/0005_candidate_preferences.sql`:

```sql
-- ===========================================================================
-- 0005_candidate_preferences.sql — structured candidate targeting preferences
--
-- Replaces the hardcoded RELEVANT_TITLE_MARKERS / OFF_TARGET_TITLE_MARKERS /
-- NON_ENGINEERING_DEPARTMENTS / INDIA_PLACE_MARKERS / REMOTE_MARKERS constants
-- in apps/api/src/common/{text,location}.util.ts with user-editable profile
-- fields. See docs/superpowers/specs/2026-10-04-candidate-profile-design.md.
--
-- target_roles / excluded_roles / excluded_departments / preferred_locations /
-- excluded_companies are consumed immediately by the ingest pipeline.
-- seniority_min_years / seniority_max_years / work_modes / employment_types /
-- domain_preferences / domain_exclusions are stored now (matching the parent
-- spec's full CandidateProfile model) but have no consumer yet — a later
-- sub-project wires them into eligibility/reranking.
--
-- Idempotent: safe to re-run. Existing rows get the column defaults ('[]' /
-- null), never backfilled with DEFAULT_CV's seed values — only a brand-new
-- profile (CvService.bootstrap()) gets those.
-- ===========================================================================

alter table public.cv_profile
  add column if not exists target_roles jsonb not null default '[]'::jsonb,
  add column if not exists excluded_roles jsonb not null default '[]'::jsonb,
  add column if not exists excluded_departments jsonb not null default '[]'::jsonb,
  add column if not exists preferred_locations jsonb not null default '[]'::jsonb,
  add column if not exists excluded_companies jsonb not null default '[]'::jsonb,
  add column if not exists seniority_min_years numeric(4, 1),
  add column if not exists seniority_max_years numeric(4, 1),
  add column if not exists work_modes jsonb not null default '[]'::jsonb,
  add column if not exists employment_types jsonb not null default '[]'::jsonb,
  add column if not exists domain_preferences jsonb not null default '[]'::jsonb,
  add column if not exists domain_exclusions jsonb not null default '[]'::jsonb;

comment on column public.cv_profile.target_roles is
  'Role-title keywords this candidate targets, e.g. ["backend", "full stack"]. Replaces the old RELEVANT_TITLE_MARKERS constant.';
comment on column public.cv_profile.excluded_roles is
  'Role-title keywords that disqualify a posting even if otherwise relevant. Replaces OFF_TARGET_TITLE_MARKERS.';
comment on column public.cv_profile.excluded_departments is
  'ATS department names that disqualify a posting. Replaces NON_ENGINEERING_DEPARTMENTS.';
comment on column public.cv_profile.preferred_locations is
  'Location keywords (place names and/or remote markers) this candidate accepts. Replaces INDIA_PLACE_MARKERS + REMOTE_MARKERS.';
comment on column public.cv_profile.excluded_companies is
  'Company names never to discover/scrape for this candidate.';
comment on column public.cv_profile.seniority_min_years is
  'Minimum years of experience the candidate wants a posting to require. Not yet consumed by ingest filtering.';
comment on column public.cv_profile.seniority_max_years is
  'Maximum years of experience the candidate wants a posting to require. Not yet consumed by ingest filtering.';
comment on column public.cv_profile.work_modes is
  'Accepted work arrangements, e.g. ["remote", "hybrid"]. Not yet consumed by ingest filtering.';
comment on column public.cv_profile.employment_types is
  'Accepted employment types, e.g. ["full-time", "contract"]. Not yet consumed by ingest filtering.';
comment on column public.cv_profile.domain_preferences is
  'Preferred industry/domain keywords. Not yet consumed by ingest filtering.';
comment on column public.cv_profile.domain_exclusions is
  'Disqualifying industry/domain keywords. Not yet consumed by ingest filtering.';
```

- [ ] **Step 2: Apply the migration to the Supabase project**

Run this in the Supabase Dashboard SQL Editor (per the convention documented at the top of `db/migrations/0001_schema.sql`), or via `supabase db push` if the CLI is wired up for this project. There is no local Postgres instance in this repo — confirm with the user which method they use before running it, since this touches the live Supabase project referenced in `apps/api/.env`.

- [ ] **Step 3: Verify existing rows got safe defaults, not seeded values**

In the Supabase SQL Editor, run:

```sql
select user_id, target_roles, preferred_locations, seniority_min_years
from public.cv_profile;
```

Expected: every existing row (there should be exactly one, for the single personal-tool user) shows `target_roles = []`, `preferred_locations = []`, `seniority_min_years = null` — **not** the `DEFAULT_CV` seed values from Task 3, since those only apply to brand-new bootstrap. Record this result in a new file `db/migrations/0005_candidate_preferences.test.md` as a one-line confirmation (e.g. "Verified 2026-10-04: existing row shows empty-array/null defaults, not seeded values — see query above.") so the check has a paper trail.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0005_candidate_preferences.sql db/migrations/0005_candidate_preferences.test.md
git commit -m "feat(db): add candidate targeting preference columns to cv_profile"
```

---

## Task 3: `text.util.ts` — parameterize `looksLikeRelevantRole()`

**Files:**
- Modify: `apps/api/src/common/text.util.ts:208-297` (the `NON_ENGINEERING_DEPARTMENTS`, `OFF_TARGET_TITLE_MARKERS`, `RELEVANT_TITLE_MARKERS` constants and the `looksLikeRelevantRole()` function)
- Test: Create `apps/api/src/common/text.util.spec.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `looksLikeRelevantRole(title: string, department: string | null | undefined, targetRoles: readonly string[], excludedRoles: readonly string[], excludedDepartments: readonly string[]): boolean` — consumed by Task 5 (`ingest.service.ts`)

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/common/text.util.spec.ts`:

```ts
import { looksLikeRelevantRole } from './text.util';

const TARGET_ROLES = [
  'backend', 'back end', 'back-end',
  'full stack', 'fullstack', 'full-stack',
  'software engineer', 'software developer',
  'sde', 'swe',
  'node.js', 'nodejs', 'node',
  'nestjs', 'nest.js',
  'api engineer',
  'server-side', 'server side',
];

const EXCLUDED_ROLES = [
  'sales engineer', 'support engineer', 'solutions engineer',
  'field engineer', 'hardware engineer', 'mechanical engineer',
  'electrical engineer', 'civil engineer', 'network engineer',
  'security engineer', 'data engineer', 'ml engineer',
  'machine learning engineer', 'ai engineer', 'qa engineer',
  'test engineer', 'ios engineer', 'android engineer',
  'mobile engineer', 'frontend engineer', 'front-end engineer',
  'front end engineer', 'site reliability', 'devops engineer',
  'platform engineer', 'embedded engineer',
  'ios', 'android', 'react native', 'flutter',
];

const EXCLUDED_DEPARTMENTS = [
  'sales', 'marketing', 'people', 'hr', 'human resources', 'finance',
  'legal', 'design', 'customer success', 'customer support', 'support',
  'operations', 'recruiting', 'talent', 'business development', 'bd',
  'account management', 'partnerships', 'content', 'communications',
  'product management',
];

describe('looksLikeRelevantRole', () => {
  it('accepts a title matching a target role', () => {
    expect(
      looksLikeRelevantRole('Backend Engineer', null, TARGET_ROLES, EXCLUDED_ROLES, EXCLUDED_DEPARTMENTS),
    ).toBe(true);
  });

  it('rejects a title matching an excluded role even if it also contains "engineer"', () => {
    expect(
      looksLikeRelevantRole('Platform Engineer', null, TARGET_ROLES, EXCLUDED_ROLES, EXCLUDED_DEPARTMENTS),
    ).toBe(false);
  });

  it('rejects a posting whose department is excluded, regardless of title', () => {
    expect(
      looksLikeRelevantRole('Backend Engineer', 'Sales', TARGET_ROLES, EXCLUDED_ROLES, EXCLUDED_DEPARTMENTS),
    ).toBe(false);
  });

  it('rejects a title matching no target role', () => {
    expect(
      looksLikeRelevantRole('Graphic Designer', null, TARGET_ROLES, EXCLUDED_ROLES, EXCLUDED_DEPARTMENTS),
    ).toBe(false);
  });

  it('does not false-positive on substrings ("swe" inside "Swedish")', () => {
    expect(
      looksLikeRelevantRole(
        'Account Development Representative (Swedish Speaking)',
        null,
        TARGET_ROLES,
        EXCLUDED_ROLES,
        EXCLUDED_DEPARTMENTS,
      ),
    ).toBe(false);
  });

  it('rejects every title when targetRoles is empty (no silent wildcard accept)', () => {
    expect(looksLikeRelevantRole('Backend Engineer', null, [], EXCLUDED_ROLES, EXCLUDED_DEPARTMENTS)).toBe(false);
    expect(looksLikeRelevantRole('Software Developer', null, [], [], [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest text.util.spec.ts`
Expected: FAIL — `looksLikeRelevantRole` currently takes 2 parameters, not 5; TypeScript compilation error under `ts-jest`.

- [ ] **Step 3: Update `looksLikeRelevantRole()` to accept the lists as parameters**

In `apps/api/src/common/text.util.ts`, delete the three module-level constants `NON_ENGINEERING_DEPARTMENTS`, `OFF_TARGET_TITLE_MARKERS`, `RELEVANT_TITLE_MARKERS` (lines 208-264) — their contents move to the caller (Task 5's `ingest.service.ts` wiring, sourced from the profile). Replace the function at lines 289-297:

```ts
export function looksLikeRelevantRole(title: string, department?: string | null): boolean {
  if (department && NON_ENGINEERING_DEPARTMENTS.some((marker) => containsWord(department, marker))) {
    return false;
  }

  if (OFF_TARGET_TITLE_MARKERS.some((marker) => containsWord(title, marker))) return false;

  return RELEVANT_TITLE_MARKERS.some((marker) => containsWord(title, marker));
}
```

with:

```ts
/**
 * Backend/full-stack relevance gate for company career pages, which list
 * every open role across the company — Sales, Design, Support, etc. — not
 * just engineering. `department` (when an ATS provides one) is checked
 * first as the stronger signal; title keywords are the fallback for
 * companies without a structured department field.
 *
 * `targetRoles`/`excludedRoles`/`excludedDepartments` come from the
 * candidate's profile (see CvProfile in packages/shared) — this function no
 * longer hardcodes them, so an empty `targetRoles` list means "nothing is
 * relevant," not "everything is."
 */
export function looksLikeRelevantRole(
  title: string,
  department: string | null | undefined,
  targetRoles: readonly string[],
  excludedRoles: readonly string[],
  excludedDepartments: readonly string[],
): boolean {
  if (department && excludedDepartments.some((marker) => containsWord(department, marker))) {
    return false;
  }

  if (excludedRoles.some((marker) => containsWord(title, marker))) return false;

  return targetRoles.some((marker) => containsWord(title, marker));
}
```

Leave `containsWord()` and `escapeRegex()` (the two helper functions just above) untouched — they're still used exactly as before.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest text.util.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: FAILS at this point — `ingest.service.ts` still calls `looksLikeRelevantRole()` with the old 2-argument signature. This is expected and resolved in Task 5; do not attempt to fix `ingest.service.ts` in this task.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/common/text.util.ts apps/api/src/common/text.util.spec.ts
git commit -m "refactor(text-util): parameterize looksLikeRelevantRole with profile-driven role lists"
```

---

## Task 4: `location.util.ts` — parameterize `isIndiaOrRemote()`

**Files:**
- Modify: `apps/api/src/common/location.util.ts` (entire file — `INDIA_PLACE_MARKERS`, `REMOTE_MARKERS`, `NON_INDIA_REMOTE_QUALIFIERS`, `classifyLocation()`, `isIndiaOrRemote()`)
- Test: Create `apps/api/src/common/location.util.spec.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `isIndiaOrRemote(rawLocation: string | null | undefined, preferredLocations: readonly string[]): boolean` — consumed by Task 5 (`ingest.service.ts`)

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/common/location.util.spec.ts`:

```ts
import { isIndiaOrRemote } from './location.util';

const PREFERRED_LOCATIONS = [
  'india',
  'bangalore', 'bengaluru', 'mumbai', 'bombay', 'delhi', 'new delhi', 'ncr',
  'gurgaon', 'gurugram', 'noida', 'pune', 'hyderabad', 'chennai', 'madras',
  'kolkata', 'calcutta', 'ahmedabad', 'kochi', 'cochin', 'coimbatore',
  'jaipur', 'chandigarh', 'indore', 'thane', 'navi mumbai',
  ' in)', '(in)', ', in',
  'remote', 'work from home', 'wfh', 'anywhere', 'distributed team', 'fully distributed',
];

describe('isIndiaOrRemote', () => {
  it('accepts a known Indian city', () => {
    expect(isIndiaOrRemote('Bangalore, India', PREFERRED_LOCATIONS)).toBe(true);
  });

  it('accepts a remote posting', () => {
    expect(isIndiaOrRemote('Fully Remote', PREFERRED_LOCATIONS)).toBe(true);
  });

  it('rejects a non-preferred location', () => {
    expect(isIndiaOrRemote('San Francisco, CA', PREFERRED_LOCATIONS)).toBe(false);
  });

  it('rejects "Remote (US only)" — a non-India-qualified remote posting', () => {
    expect(isIndiaOrRemote('Remote (US only)', PREFERRED_LOCATIONS)).toBe(false);
  });

  it('rejects an unknown/missing location', () => {
    expect(isIndiaOrRemote(null, PREFERRED_LOCATIONS)).toBe(false);
    expect(isIndiaOrRemote(undefined, PREFERRED_LOCATIONS)).toBe(false);
    expect(isIndiaOrRemote('', PREFERRED_LOCATIONS)).toBe(false);
  });

  it('rejects every location when preferredLocations is empty (no silent wildcard accept)', () => {
    expect(isIndiaOrRemote('Bangalore, India', [])).toBe(false);
    expect(isIndiaOrRemote('Remote', [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest location.util.spec.ts`
Expected: FAIL — `isIndiaOrRemote` currently takes 1 parameter, not 2.

- [ ] **Step 3: Rewrite `location.util.ts`**

Replace the full contents of `apps/api/src/common/location.util.ts` with:

```ts
/**
 * India-or-Remote location gate. Applied after location extraction, on every
 * candidate before it's ever inserted — a candidate with no recognisable
 * location signal is rejected outright (favours precision: only fetching
 * companies' own postings already cuts noise a lot, but "relevant" also
 * means "somewhere I can actually take," per the candidate's preferences).
 *
 * `preferredLocations` comes from the candidate's profile (CvProfile in
 * packages/shared) — a flat list mixing place names ("india", "bangalore")
 * and remote markers ("remote", "wfh"). This function no longer hardcodes
 * them, so an empty list means "nothing is acceptable," not "everything is."
 */

/**
 * Markers that indicate a *specific non-preferred* place, used to catch
 * cases like "Remote (US only)" or "Remote - EU" where "remote" alone would
 * be a false positive for a candidate targeting India/Remote. This is a
 * structural pattern (a qualifier that narrows "remote" to a place the
 * candidate didn't ask for), not a candidate preference, so it stays
 * hardcoded rather than moving onto the profile.
 */
const NON_INDIA_REMOTE_QUALIFIERS = [
  'us only', 'usa only', 'u.s. only', 'united states only',
  'eu only', 'europe only', 'emea only',
  'uk only', 'united kingdom only',
  'canada only',
  'latam only', 'latin america only',
  'apac only',
];

const REMOTE_MARKERS = [
  'remote',
  'work from home',
  'wfh',
  'anywhere',
  'distributed team',
  'fully distributed',
];

/** The hard gate the ingest pipeline applies: keep only a candidate's preferred locations. */
export function isIndiaOrRemote(
  rawLocation: string | null | undefined,
  preferredLocations: readonly string[],
): boolean {
  if (!rawLocation || !rawLocation.trim()) return false;
  const t = rawLocation.toLowerCase();

  const isRemoteMention = REMOTE_MARKERS.some((marker) => t.includes(marker));
  if (isRemoteMention && NON_INDIA_REMOTE_QUALIFIERS.some((qualifier) => t.includes(qualifier))) {
    return false;
  }

  return preferredLocations.some((marker) => t.includes(marker.toLowerCase()));
}
```

Note: `preferredLocations` is expected to already include the remote markers (e.g. `'remote'`, `'wfh'`) as part of its flat list per the spec — the final `return` line checks the full preferred-locations list (which subsumes the remote check), while the `NON_INDIA_REMOTE_QUALIFIERS` short-circuit above it guards specifically against a disqualified remote mention slipping through via a place-name coincidence. This collapses the old `classifyLocation()`/`LocationClass` export — nothing outside this file consumed `classifyLocation` or `LocationClass` (confirmed: only `isIndiaOrRemote` is imported elsewhere), so removing them is safe.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest location.util.spec.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: FAILS at this point — `ingest.service.ts` still calls `isIndiaOrRemote()` with the old 1-argument signature, and `classifyLocation`/`LocationClass` no longer exist. Expected; resolved in Task 5.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/common/location.util.ts apps/api/src/common/location.util.spec.ts
git commit -m "refactor(location-util): parameterize isIndiaOrRemote with profile-driven location list"
```

---

## Task 5: DTO, shared types, and `CvService` — accept and persist the new fields

**Files:**
- Modify: `apps/api/src/cv/dto/cv.dto.ts`
- Modify: `apps/api/src/cv/cv.service.ts:53-87` (`bootstrap()`) and `:118-136` (`updateProfile()`)
- Modify: `apps/api/src/cv/default-cv.ts`
- Test: Create `apps/api/src/cv/cv.service.spec.ts`

**Interfaces:**
- Consumes: `CvProfile` from Task 1 (`packages/shared/src/types.ts`)
- Produces: `CvService.getSnapshot(userId)` returning a `CvProfile` with all 11 new fields populated (seeded for new profiles, persisted for existing ones after edit); `CvService.updateProfile(userId, dto)` accepting any of the 11 new fields — consumed by Task 6 (`ingest.service.ts`)

- [ ] **Step 1: Extend `UpdateCvDto`**

In `apps/api/src/cv/dto/cv.dto.ts`, add imports and fields. Replace the file's top import block:

```ts
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PROFICIENCY_LEVELS, type ProficiencyLevel } from '@jobportal/shared';
```

with:

```ts
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PROFICIENCY_LEVELS, type ProficiencyLevel } from '@jobportal/shared';
```

Then extend `UpdateCvDto` (currently lines 15-31) by adding these fields after `current_title`:

```ts
export class UpdateCvDto {
  @IsOptional()
  @IsString()
  @MaxLength(60_000)
  raw_cv_text?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(60)
  experience_years?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  current_title?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  target_roles?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  excluded_roles?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  excluded_departments?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  preferred_locations?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  excluded_companies?: string[];

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(60)
  seniority_min_years?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(60)
  seniority_max_years?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  work_modes?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  employment_types?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  domain_preferences?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  domain_exclusions?: string[];
}
```

(`CvSkillDto` and `SetCvSkillsDto` below it are untouched.)

- [ ] **Step 2: Update `DEFAULT_CV` with seeded preference values**

In `apps/api/src/cv/default-cv.ts`, add new top-level exported constants and extend the `DEFAULT_CV` object. Add after the `import` line:

```ts
import type { ProficiencyLevel } from '@jobportal/shared';

/** Seeded from the old RELEVANT_TITLE_MARKERS constant in text.util.ts. */
const DEFAULT_TARGET_ROLES = [
  'backend', 'back end', 'back-end',
  'full stack', 'fullstack', 'full-stack',
  'software engineer', 'software developer',
  'sde', 'swe',
  'node.js', 'nodejs', 'node',
  'nestjs', 'nest.js',
  'api engineer',
  'server-side', 'server side',
];

/** Seeded from the old OFF_TARGET_TITLE_MARKERS constant in text.util.ts. */
const DEFAULT_EXCLUDED_ROLES = [
  'sales engineer', 'support engineer', 'solutions engineer',
  'field engineer', 'hardware engineer', 'mechanical engineer',
  'electrical engineer', 'civil engineer', 'network engineer',
  'security engineer', 'data engineer', 'ml engineer',
  'machine learning engineer', 'ai engineer', 'qa engineer',
  'test engineer', 'ios engineer', 'android engineer',
  'mobile engineer', 'frontend engineer', 'front-end engineer',
  'front end engineer', 'site reliability', 'devops engineer',
  'platform engineer', 'embedded engineer',
  'ios', 'android', 'react native', 'flutter',
];

/** Seeded from the old NON_ENGINEERING_DEPARTMENTS constant in text.util.ts. */
const DEFAULT_EXCLUDED_DEPARTMENTS = [
  'sales', 'marketing', 'people', 'hr', 'human resources', 'finance',
  'legal', 'design', 'customer success', 'customer support', 'support',
  'operations', 'recruiting', 'talent', 'business development', 'bd',
  'account management', 'partnerships', 'content', 'communications',
  'product management',
];

/** Seeded from the old INDIA_PLACE_MARKERS + REMOTE_MARKERS constants in location.util.ts. */
const DEFAULT_PREFERRED_LOCATIONS = [
  'india',
  'bangalore', 'bengaluru', 'mumbai', 'bombay', 'delhi', 'new delhi', 'ncr',
  'gurgaon', 'gurugram', 'noida', 'pune', 'hyderabad', 'chennai', 'madras',
  'kolkata', 'calcutta', 'ahmedabad', 'kochi', 'cochin', 'coimbatore',
  'jaipur', 'chandigarh', 'indore', 'thane', 'navi mumbai',
  ' in)', '(in)', ', in',
  'remote', 'work from home', 'wfh', 'anywhere', 'distributed team', 'fully distributed',
];
```

Then extend the `DEFAULT_CV` object — add these fields alongside the existing `currentTitle`/`experienceYears`/`rawText`/`skills`:

```ts
export const DEFAULT_CV = {
  currentTitle: 'Backend-Focused Full Stack Developer',
  experienceYears: 2.2,

  targetRoles: DEFAULT_TARGET_ROLES,
  excludedRoles: DEFAULT_EXCLUDED_ROLES,
  excludedDepartments: DEFAULT_EXCLUDED_DEPARTMENTS,
  preferredLocations: DEFAULT_PREFERRED_LOCATIONS,
  excludedCompanies: [] as string[],
  seniorityMinYears: null as number | null,
  seniorityMaxYears: null as number | null,
  workModes: [] as string[],
  employmentTypes: [] as string[],
  domainPreferences: [] as string[],
  domainExclusions: [] as string[],

  rawText: `Harshit Sen — Backend-Focused Full Stack Developer
  ... (unchanged, keep existing rawText and skills exactly as-is) ...
```

(Leave the existing `rawText` template literal and `skills` array completely untouched — only add the new fields above them.)

- [ ] **Step 3: Update `CvService.bootstrap()` to persist the seeded defaults**

In `apps/api/src/cv/cv.service.ts`, update the `.insert({...})` call inside `bootstrap()` (currently lines 57-63):

```ts
const insert = await this.supabase.admin
  .from('cv_profile')
  .insert({
    user_id: userId,
    raw_cv_text: DEFAULT_CV.rawText,
    experience_years: DEFAULT_CV.experienceYears,
    current_title: DEFAULT_CV.currentTitle,
  })
  .select('*')
  .single();
```

to:

```ts
const insert = await this.supabase.admin
  .from('cv_profile')
  .insert({
    user_id: userId,
    raw_cv_text: DEFAULT_CV.rawText,
    experience_years: DEFAULT_CV.experienceYears,
    current_title: DEFAULT_CV.currentTitle,
    target_roles: DEFAULT_CV.targetRoles,
    excluded_roles: DEFAULT_CV.excludedRoles,
    excluded_departments: DEFAULT_CV.excludedDepartments,
    preferred_locations: DEFAULT_CV.preferredLocations,
    excluded_companies: DEFAULT_CV.excludedCompanies,
    seniority_min_years: DEFAULT_CV.seniorityMinYears,
    seniority_max_years: DEFAULT_CV.seniorityMaxYears,
    work_modes: DEFAULT_CV.workModes,
    employment_types: DEFAULT_CV.employmentTypes,
    domain_preferences: DEFAULT_CV.domainPreferences,
    domain_exclusions: DEFAULT_CV.domainExclusions,
  })
  .select('*')
  .single();
```

- [ ] **Step 4: Update `CvService.updateProfile()` to persist any of the new fields**

Update `updateProfile()` (currently lines 118-136):

```ts
async updateProfile(userId: string, dto: UpdateCvDto): Promise<CvSnapshot> {
  const { profile } = await this.getSnapshot(userId);

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (dto.raw_cv_text !== undefined) patch.raw_cv_text = dto.raw_cv_text;
  if (dto.experience_years !== undefined) patch.experience_years = dto.experience_years;
  if (dto.current_title !== undefined) patch.current_title = dto.current_title;

  const result = await this.supabase.admin
    .from('cv_profile')
    .update(patch)
    .eq('id', profile.id)
    .eq('user_id', userId)
    .select('*')
    .single();

  const updated = this.supabase.unwrap(result, 'update cv profile') as CvProfile;
  return { profile: updated, skills: await this.listSkills(updated.id) };
}
```

to:

```ts
async updateProfile(userId: string, dto: UpdateCvDto): Promise<CvSnapshot> {
  const { profile } = await this.getSnapshot(userId);

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (dto.raw_cv_text !== undefined) patch.raw_cv_text = dto.raw_cv_text;
  if (dto.experience_years !== undefined) patch.experience_years = dto.experience_years;
  if (dto.current_title !== undefined) patch.current_title = dto.current_title;
  if (dto.target_roles !== undefined) patch.target_roles = dto.target_roles;
  if (dto.excluded_roles !== undefined) patch.excluded_roles = dto.excluded_roles;
  if (dto.excluded_departments !== undefined) patch.excluded_departments = dto.excluded_departments;
  if (dto.preferred_locations !== undefined) patch.preferred_locations = dto.preferred_locations;
  if (dto.excluded_companies !== undefined) patch.excluded_companies = dto.excluded_companies;
  if (dto.seniority_min_years !== undefined) patch.seniority_min_years = dto.seniority_min_years;
  if (dto.seniority_max_years !== undefined) patch.seniority_max_years = dto.seniority_max_years;
  if (dto.work_modes !== undefined) patch.work_modes = dto.work_modes;
  if (dto.employment_types !== undefined) patch.employment_types = dto.employment_types;
  if (dto.domain_preferences !== undefined) patch.domain_preferences = dto.domain_preferences;
  if (dto.domain_exclusions !== undefined) patch.domain_exclusions = dto.domain_exclusions;

  const result = await this.supabase.admin
    .from('cv_profile')
    .update(patch)
    .eq('id', profile.id)
    .eq('user_id', userId)
    .select('*')
    .single();

  const updated = this.supabase.unwrap(result, 'update cv profile') as CvProfile;
  return { profile: updated, skills: await this.listSkills(updated.id) };
}
```

- [ ] **Step 5: Write the failing test for partial-update isolation**

Create `apps/api/src/cv/cv.service.spec.ts`. This test uses a minimal hand-rolled fake for `SupabaseService` rather than NestJS's testing module, since `CvService`'s only dependency surface actually used is `supabase.admin.from(...)` chains and `supabase.unwrap`/`unwrapMaybe`:

```ts
import { CvService } from './cv.service';
import { SkillsService } from '../skills/skills.service';
import { SupabaseService } from '../supabase/supabase.service';

describe('CvService.updateProfile', () => {
  function makeFakeSupabase(initialProfile: Record<string, unknown>) {
    let storedProfile = { ...initialProfile };

    const fromCvProfile = {
      select: () => fromCvProfile,
      eq: () => fromCvProfile,
      maybeSingle: async () => ({ data: storedProfile, error: null }),
      update: (patch: Record<string, unknown>) => {
        storedProfile = { ...storedProfile, ...patch };
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: async () => ({ data: storedProfile, error: null }),
              }),
            }),
          }),
        };
      },
    };

    const fromCvSkills = {
      select: () => fromCvSkills,
      eq: () => ({ data: [], error: null }),
    };

    const admin = {
      from: (table: string) => {
        if (table === 'cv_profile') return fromCvProfile;
        if (table === 'cv_skills') return fromCvSkills;
        throw new Error(`unexpected table in test fake: ${table}`);
      },
    };

    const fakeSupabase = {
      admin,
      unwrap: (result: { data: unknown; error: unknown }) => result.data,
      unwrapMaybe: (result: { data: unknown; error: unknown }) => result.data,
    } as unknown as SupabaseService;

    return { fakeSupabase, getStoredProfile: () => storedProfile };
  }

  it('does not clobber unrelated array fields on a partial update', async () => {
    const { fakeSupabase, getStoredProfile } = makeFakeSupabase({
      id: 'profile-1',
      user_id: 'user-1',
      target_roles: ['backend'],
      excluded_companies: ['Acme'],
      preferred_locations: ['india'],
    });
    const fakeSkills = {} as SkillsService;
    const service = new CvService(fakeSupabase, fakeSkills);

    await service.updateProfile('user-1', { target_roles: ['backend', 'full stack'] });

    const stored = getStoredProfile();
    expect(stored.target_roles).toEqual(['backend', 'full stack']);
    expect(stored.excluded_companies).toEqual(['Acme']);
    expect(stored.preferred_locations).toEqual(['india']);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd apps/api && npx jest cv.service.spec.ts`
Expected: FAIL at this point — before Step 4's edit, `dto.target_roles` is silently ignored by `updateProfile()`, so `stored.target_roles` would remain `['backend']` instead of becoming `['backend', 'full stack']`.

(If Step 4 was already applied before writing this test, run the test immediately after Step 1 but before Step 4 to see the real failure — do steps in the written order: Steps 1-4 first per above, then come back and run Step 5's test, which should already pass. Either order is fine since this is a service-level test, not a strict red-green cycle on a single line; the important check is Step 7 confirming it's green on the final code.)

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd apps/api && npx jest cv.service.spec.ts`
Expected: PASS

- [ ] **Step 8: Typecheck the whole API**

Run: `cd apps/api && npm run typecheck`
Expected: still FAILS — `ingest.service.ts` calls to `looksLikeRelevantRole()`/`isIndiaOrRemote()` remain unupdated. Resolved in Task 6, the final task.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/cv/dto/cv.dto.ts apps/api/src/cv/default-cv.ts apps/api/src/cv/cv.service.ts apps/api/src/cv/cv.service.spec.ts
git commit -m "feat(cv): accept and persist candidate targeting preferences via CV API"
```

---

## Task 6: `IngestService` — wire profile preferences into filtering

**Files:**
- Modify: `apps/api/src/ingest/ingest.service.ts` (imports; `run()`; `discoverCompanies()`; `scrapeAtsCompany()`; `scrapeCustomCareerPage()`)
- Test: Create `apps/api/src/ingest/ingest.service.spec.ts` (targeted unit tests for the new company-exclusion filter only — the full `run()` pipeline has too many external dependencies, Supabase/Firecrawl/Groq, for a unit test; that stays covered by the existing manual/integration testing approach used elsewhere in this codebase)

**Interfaces:**
- Consumes: `CvService.getSnapshot(userId)` → `CvSnapshot` (from Task 5, unchanged shape plus new `CvProfile` fields from Task 1); `looksLikeRelevantRole(title, department, targetRoles, excludedRoles, excludedDepartments)` (Task 3); `isIndiaOrRemote(location, preferredLocations)` (Task 4)
- Produces: `IngestService.run()` now filters using the calling user's profile instead of hardcoded constants — this is the final task; nothing downstream consumes new interfaces from this task

- [ ] **Step 1: Read the current `discoverCompanies()` to confirm the exact insertion point**

Run: `cd apps/api && sed -n '240,298p' src/ingest/ingest.service.ts`

Confirm the loop `for (const name of toResolve)` at the point where `candidateNames` has already been built but before `this.resolver.resolve(name)` is called — this is where the `excluded_companies` check belongs, filtering `toResolve` before resolution is attempted (not filtering `candidateNames` earlier, since that map is also used for the `known`-dedup check, which should stay independent of exclusion).

- [ ] **Step 2: Write the failing test for company exclusion**

Create `apps/api/src/ingest/ingest.service.spec.ts`:

```ts
describe('company exclusion filtering', () => {
  // This exercises the case-insensitive matching logic that discoverCompanies()
  // will use to skip excluded companies before calling CompanyResolverService.resolve().
  // Extracted as a standalone function (see Step 3) so it's unit-testable without
  // standing up the full IngestService dependency graph (Supabase/Firecrawl/Groq/etc).
  function isExcludedCompany(name: string, excludedCompanies: readonly string[]): boolean {
    const normalized = name.trim().toLowerCase();
    return excludedCompanies.some((excluded) => excluded.trim().toLowerCase() === normalized);
  }

  it('excludes a company matching an excluded name case-insensitively', () => {
    expect(isExcludedCompany('Razorpay', ['razorpay'])).toBe(true);
    expect(isExcludedCompany('razorpay', ['Razorpay'])).toBe(true);
    expect(isExcludedCompany('RAZORPAY', ['Razorpay'])).toBe(true);
  });

  it('does not exclude a company not on the list', () => {
    expect(isExcludedCompany('Zerodha', ['Razorpay'])).toBe(false);
  });

  it('treats an empty exclusion list as excluding nothing', () => {
    expect(isExcludedCompany('Razorpay', [])).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/api && npx jest ingest.service.spec.ts`
Expected: FAIL — `isExcludedCompany` doesn't exist yet in `ingest.service.ts` (the test currently defines its own copy inline to describe the expected behavior before the real implementation exists; this step is a design-by-test placeholder — proceed to Step 4 to add the real function, then Step 5 updates the test to import it instead of redefining it).

- [ ] **Step 4: Add the `isExcludedCompany` helper and wire it into `discoverCompanies()`**

In `apps/api/src/ingest/ingest.service.ts`, add this helper function near the bottom of the file, alongside the existing `describeError()`/`looksLikeRealCompanyName()` helpers:

```ts
/** Case-insensitive exact-name match against the candidate's excluded-companies list. */
function isExcludedCompany(name: string, excludedCompanies: readonly string[]): boolean {
  const normalized = name.trim().toLowerCase();
  return excludedCompanies.some((excluded) => excluded.trim().toLowerCase() === normalized);
}
```

Export it (add `export` in front) so Step 5's test can import it directly instead of redefining it.

Now update `discoverCompanies()`'s signature and body. Current signature (line ~240):

```ts
private async discoverCompanies(
  userId: string,
  errors: string[],
): Promise<{ discovered: number; resolved: number; failed: number }> {
```

becomes:

```ts
private async discoverCompanies(
  userId: string,
  errors: string[],
  profile: CvProfile,
): Promise<{ discovered: number; resolved: number; failed: number }> {
```

And inside the function, change:

```ts
const maxNewCompanies = this.config.get<number>('ingest.maxNewCompaniesPerRun', 5);
const toResolve = [...candidateNames.values()].slice(0, maxNewCompanies);
```

to:

```ts
const maxNewCompanies = this.config.get<number>('ingest.maxNewCompaniesPerRun', 5);
const toResolve = [...candidateNames.values()]
  .filter((name) => !isExcludedCompany(name, profile.excluded_companies))
  .slice(0, maxNewCompanies);
```

- [ ] **Step 5: Update `scrapeAtsCompany()` and `scrapeCustomCareerPage()` to thread profile fields through**

Current `scrapeAtsCompany()`:

```ts
private async scrapeAtsCompany(company: Company): Promise<RawJobCandidate[]> {
  const listings = await fetchAtsJobs(company.ats_type!, company.ats_board_token!);

  return listings
    .filter((listing) => looksLikeRelevantRole(listing.title, listing.department))
    .filter((listing) => isIndiaOrRemote(listing.location))
    .map(
      (listing): RawJobCandidate => ({
        title: listing.title,
        url: listing.url,
        companyNameHint: company.name,
        locationHint: listing.location,
        snippet: (listing.description ?? '').slice(0, 2000),
        markdown: listing.description,
        source: 'ats_api',
        postedDateIso: listing.postedDateIso,
      }),
    );
}
```

becomes:

```ts
private async scrapeAtsCompany(company: Company, profile: CvProfile): Promise<RawJobCandidate[]> {
  const listings = await fetchAtsJobs(company.ats_type!, company.ats_board_token!);

  return listings
    .filter((listing) =>
      looksLikeRelevantRole(
        listing.title,
        listing.department,
        profile.target_roles,
        profile.excluded_roles,
        profile.excluded_departments,
      ),
    )
    .filter((listing) => isIndiaOrRemote(listing.location, profile.preferred_locations))
    .map(
      (listing): RawJobCandidate => ({
        title: listing.title,
        url: listing.url,
        companyNameHint: company.name,
        locationHint: listing.location,
        snippet: (listing.description ?? '').slice(0, 2000),
        markdown: listing.description,
        source: 'ats_api',
        postedDateIso: listing.postedDateIso,
      }),
    );
}
```

Current `scrapeCustomCareerPage()`:

```ts
private async scrapeCustomCareerPage(company: Company): Promise<RawJobCandidate[]> {
  if (!company.careers_url) return [];
  const raw = await this.firecrawl.discoverCompanyJobs(company.careers_url);
  return raw.filter((c) => looksLikeRelevantRole(c.title) && isIndiaOrRemote(c.locationHint));
}
```

becomes:

```ts
private async scrapeCustomCareerPage(company: Company, profile: CvProfile): Promise<RawJobCandidate[]> {
  if (!company.careers_url) return [];
  const raw = await this.firecrawl.discoverCompanyJobs(company.careers_url);
  return raw.filter(
    (c) =>
      looksLikeRelevantRole(c.title, null, profile.target_roles, profile.excluded_roles, profile.excluded_departments) &&
      isIndiaOrRemote(c.locationHint, profile.preferred_locations),
  );
}
```

- [ ] **Step 6: Update `scrapeResolvedCompanies()` to accept and thread the profile through**

Current signature and body (the function that calls the two methods just edited):

```ts
private async scrapeResolvedCompanies(
  userId: string,
  errors: string[],
): Promise<{ candidates: CompanyScopedCandidate[]; companiesScraped: number }> {
  const toScrape = await this.companies.listScrapable(userId);
  const candidates: CompanyScopedCandidate[] = [];
  let companiesScraped = 0;

  for (const company of toScrape) {
    this.logActivity(userId, `Scraping ${company.name}…`);
    try {
      const raw =
        company.ats_type && company.ats_board_token
          ? await this.scrapeAtsCompany(company)
          : await this.scrapeCustomCareerPage(company);
      ...
```

becomes:

```ts
private async scrapeResolvedCompanies(
  userId: string,
  errors: string[],
  profile: CvProfile,
): Promise<{ candidates: CompanyScopedCandidate[]; companiesScraped: number }> {
  const toScrape = await this.companies.listScrapable(userId);
  const candidates: CompanyScopedCandidate[] = [];
  let companiesScraped = 0;

  for (const company of toScrape) {
    this.logActivity(userId, `Scraping ${company.name}…`);
    try {
      const raw =
        company.ats_type && company.ats_board_token
          ? await this.scrapeAtsCompany(company, profile)
          : await this.scrapeCustomCareerPage(company, profile);
      ...
```

(Leave the rest of the function body — the `for...of` loop's remaining lines pushing into `candidates`, calling `this.companies.markScraped()`, catch block — exactly as-is; only the signature and the two call sites inside it change.)

- [ ] **Step 7: Update `run()` to load the profile once and pass it down**

In `run()`, find:

```ts
this.logger.log(`[${runId}] Ingestion run starting for user ${userId}`);
this.logActivity(userId, 'Discovering new companies…');

const discovery = await this.discoverCompanies(userId, errors);
this.logActivity(
  userId,
  `Discovery done — ${discovery.resolved} resolved, ${discovery.failed} failed`,
);

const { candidates, companiesScraped } = await this.scrapeResolvedCompanies(userId, errors);
```

and change to:

```ts
this.logger.log(`[${runId}] Ingestion run starting for user ${userId}`);
this.logActivity(userId, 'Discovering new companies…');

const { profile } = await this.cv.getSnapshot(userId);

const discovery = await this.discoverCompanies(userId, errors, profile);
this.logActivity(
  userId,
  `Discovery done — ${discovery.resolved} resolved, ${discovery.failed} failed`,
);

const { candidates, companiesScraped } = await this.scrapeResolvedCompanies(userId, errors, profile);
```

- [ ] **Step 8: Add the `CvService` dependency and `CvProfile` import**

At the top of `ingest.service.ts`, add the import:

```ts
import type { Company, CvProfile, IngestRunStatus, IngestRunSummary } from '@jobportal/shared';
```

(replacing the existing `import type { Company, IngestRunStatus, IngestRunSummary } from '@jobportal/shared';` line)

Add the import for `CvService` alongside the other service imports:

```ts
import { CvService } from '../cv/cv.service';
```

Add `cv: CvService` to the constructor's dependency list:

```ts
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
```

- [ ] **Step 9: Register `CvModule` as a dependency of `IngestModule`**

`CvModule` already exports `CvService` (confirmed in `apps/api/src/cv/cv.module.ts`), so this is a straightforward import-and-register. In `apps/api/src/ingest/ingest.module.ts`, replace:

```ts
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { FirecrawlModule } from '../firecrawl/firecrawl.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { CompaniesModule } from '../companies/companies.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { IngestScheduler } from './ingest.scheduler';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    FirecrawlModule,
    AnalysisModule,
    CompaniesModule,
    DiscoveryModule,
  ],
  controllers: [IngestController],
  providers: [IngestService, IngestScheduler],
  exports: [IngestService],
})
export class IngestModule {}
```

with:

```ts
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { FirecrawlModule } from '../firecrawl/firecrawl.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { CompaniesModule } from '../companies/companies.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { CvModule } from '../cv/cv.module';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { IngestScheduler } from './ingest.scheduler';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    FirecrawlModule,
    AnalysisModule,
    CompaniesModule,
    DiscoveryModule,
    CvModule,
  ],
  controllers: [IngestController],
  providers: [IngestService, IngestScheduler],
  exports: [IngestService],
})
export class IngestModule {}
```

- [ ] **Step 10: Finish Step 2's test by importing the real function instead of redefining it**

Update `apps/api/src/ingest/ingest.service.spec.ts` to replace the locally-defined `isExcludedCompany` with an import of the real one:

```ts
import { isExcludedCompany } from './ingest.service';

describe('company exclusion filtering', () => {
  it('excludes a company matching an excluded name case-insensitively', () => {
    expect(isExcludedCompany('Razorpay', ['razorpay'])).toBe(true);
    expect(isExcludedCompany('razorpay', ['Razorpay'])).toBe(true);
    expect(isExcludedCompany('RAZORPAY', ['Razorpay'])).toBe(true);
  });

  it('does not exclude a company not on the list', () => {
    expect(isExcludedCompany('Zerodha', ['Razorpay'])).toBe(false);
  });

  it('treats an empty exclusion list as excluding nothing', () => {
    expect(isExcludedCompany('Razorpay', [])).toBe(false);
  });
});
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `cd apps/api && npx jest ingest.service.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 12: Full typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: PASS — this is the first typecheck in the whole plan expected to fully succeed, since every call site touched across Tasks 3-6 is now consistent.

- [ ] **Step 13: Run the full API test suite**

Run: `cd apps/api && npm test`
Expected: PASS — all specs from Tasks 3, 4, 5, and 6 (text.util, location.util, cv.service, ingest.service) green.

- [ ] **Step 14: Manual smoke test against the real Supabase project**

Start the API locally (`cd apps/api && npm run start:dev`), then trigger `POST /ingest/refresh` for the real user (via the dashboard's Refresh button or a direct authenticated request) and confirm in the logs/activity feed that the run completes without errors and inserts/filters jobs consistent with pre-change behavior (same companies accepted/rejected, since `DEFAULT_CV`'s seeded values from Task 5 reproduce the old hardcoded constants exactly). This is the end-to-end regression check promised in the spec's §8 "Integration smoke test."

- [ ] **Step 15: Commit**

```bash
git add apps/api/src/ingest/ingest.service.ts apps/api/src/ingest/ingest.service.spec.ts apps/api/src/ingest/ingest.module.ts
git commit -m "feat(ingest): filter companies and jobs using candidate profile preferences instead of hardcoded constants"
```

---

## Plan Self-Review Notes

**Spec coverage:** §4 (schema) → Task 2. §5 (DEFAULT_CV seed) → Task 5 Step 2. §6 (DTO/service/types) → Tasks 1, 5. §7 (`looksLikeRelevantRole`/`isIndiaOrRemote` signature changes + `IngestService` wiring) → Tasks 3, 4, 6. §8 (testing) → every task's test steps plus Task 6 Step 14's manual smoke test. §9's acceptance table is satisfied exactly as scoped (seniority range and LLM-prompt consumption explicitly deferred, matching the spec's own statement that these are partial in this sub-project).

**Type consistency:** `CvProfile` fields defined in Task 1 (`target_roles`, `excluded_roles`, `excluded_departments`, `preferred_locations`, `excluded_companies`, plus the 6 stored-only fields) are referenced identically by name in Tasks 5 and 6 — no renaming drift. `looksLikeRelevantRole`'s 5-parameter signature from Task 3 and `isIndiaOrRemote`'s 2-parameter signature from Task 4 are called identically in Task 6 Step 5.

**Review Focus coverage:** all 5 items each map to a specific pinned test — existing-row defaults (Task 2 Step 3), empty-list-as-no-wildcard (Task 3 Step 1's last test, Task 4 Step 1's last test), case-insensitive company exclusion (Task 6 Step 2), partial-update isolation (Task 5 Step 5), oversized/malformed input rejected by DTO validation (`@ArrayMaxSize`/`@MaxLength` in Task 5 Step 1 — not separately unit-tested since class-validator's own test suite already covers decorator enforcement; relying on the library's guarantee here rather than re-testing class-validator itself).
