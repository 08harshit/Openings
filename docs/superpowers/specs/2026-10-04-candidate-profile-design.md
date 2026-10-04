# Sub-project 1: Candidate Profile — Design Spec

**Parent document:** [job_search_automation_spec.md](../../../job_search_automation_spec.md) §7 (CandidateProfileModule)
**Status:** Approved for implementation planning
**Scope:** Backend only — schema, API, and ingest wiring. No new Angular UI.

---

## 1. Problem

Today, "who the candidate is and what they want" is split across two places:

- **Structured, editable:** `cv_profile` + `cv_skills` tables — raw CV text, experience years, current title, skill list with proficiency. Editable via `GET/PATCH /cv` and `PUT/POST/DELETE /cv/skills`.
- **Hardcoded, compile-time constants:** target roles, excluded roles/departments, and location preferences live as regex/keyword lists baked into [text.util.ts](../../../apps/api/src/common/text.util.ts) (`RELEVANT_TITLE_MARKERS`, `OFF_TARGET_TITLE_MARKERS`, `NON_ENGINEERING_DEPARTMENTS`) and [location.util.ts](../../../apps/api/src/common/location.util.ts) (`INDIA_PLACE_MARKERS`, `REMOTE_MARKERS`).

This violates the parent spec's §7.1 principle ("The profile must not depend on compile-time constants") and was flagged as the audit's **Critical** finding F1: changing what jobs the system targets currently requires a code change and redeploy, not an app setting.

## 2. Goal

Extend the existing `cv_profile` table with the full set of structured preference fields from the parent spec's §7.2 `CandidateProfile` model, expose them through the existing CV API, and wire the fields that the current pipeline can already act on (target roles, excluded roles/departments, preferred locations, excluded companies) into ingest's deterministic filters — replacing the hardcoded constants with user-editable data while keeping identical matching behavior on day one.

Fields the current pipeline has no consumer for yet (seniority range, work modes, employment types, domain preferences/exclusions) are added to the schema and API now, per the parent spec's exact model, but are **stored only** — not consumed — until the sub-projects that need them (Processing Pipeline, Reranking) are built. This avoids a second schema migration later and keeps this sub-project aligned with parent-spec §7.2/§7.4 exactly, rather than a scoped-down subset.

## 3. Non-goals

- No new Angular settings/profile UI. Fields are edited via the existing `PATCH /cv` API (curl/Postman/future UI).
- No smarter-than-keyword matching. `target_roles`/`excluded_roles`/`preferred_locations` are matched with the same word-boundary substring logic (`containsWord`) used today — just sourced from data instead of constants. Semantic/fuzzy matching is explicitly deferred to the Processing Pipeline sub-project's `EligibilityModule`.
- No change to `requiredSkills`/`preferredSkills` representation — the existing `cv_skills` table + `proficiency` already covers this; the parent spec's `requiredSkills`/`preferredSkills` arrays on `CandidateProfile` map onto the existing skills table, not new columns.
- No change to Groq prompts or analysis output shape — that's Sub-project 4.
- No consumption of `seniority_min_years`/`seniority_max_years`/`work_modes`/`employment_types`/`domain_preferences`/`domain_exclusions` in this sub-project (stored only, per Goal section).

## 4. Schema change

New migration `db/migrations/0005_candidate_preferences.sql`, extending `public.cv_profile`:

```sql
alter table public.cv_profile
  add column if not exists target_roles jsonb not null default '[]'::jsonb,
  add column if not exists excluded_roles jsonb not null default '[]'::jsonb,
  add column if not exists excluded_departments jsonb not null default '[]'::jsonb,
  add column if not exists preferred_locations jsonb not null default '[]'::jsonb,
  add column if not exists excluded_companies jsonb not null default '[]'::jsonb,
  add column if not exists seniority_min_years numeric(4,1),
  add column if not exists seniority_max_years numeric(4,1),
  add column if not exists work_modes jsonb not null default '[]'::jsonb,
  add column if not exists employment_types jsonb not null default '[]'::jsonb,
  add column if not exists domain_preferences jsonb not null default '[]'::jsonb,
  add column if not exists domain_exclusions jsonb not null default '[]'::jsonb;
```

All new columns are plain string arrays stored as `jsonb` (consistent with the existing `matched_skills`/`missing_skills` jsonb columns on `skill_gap_analysis`), except the two numeric seniority bounds. Idempotent (`if not exists`) per the existing migration convention ([0004_company_discovery.sql](../../../db/migrations/0004_company_discovery.sql) uses the same pattern).

No backfill `update` statement is needed beyond the column defaults — existing rows get `'[]'::jsonb` for array fields and `null` for seniority bounds, which is a safe "no preference recorded" state distinct from an empty-but-intentional list. Default *values* matching today's hardcoded constants are seeded only for brand-new profiles via `DEFAULT_CV` (see §5), not retrofitted onto existing rows — a user who already edited their CV shouldn't have new arrays silently populated with the app's old hardcoded defaults.

## 5. `DEFAULT_CV` seed update

[default-cv.ts](../../../apps/api/src/cv/default-cv.ts) gains default values for the 5 immediately-consumed fields, seeded from today's hardcoded constants so a fresh bootstrap produces byte-for-byte the same filtering behavior as today:

```ts
targetRoles: [
  'backend', 'full stack', 'software engineer', 'software developer',
  'sde', 'swe', 'node.js', 'nestjs', 'api engineer', 'server-side',
], // from RELEVANT_TITLE_MARKERS

excludedRoles: [
  'sales engineer', 'support engineer', 'solutions engineer', /* ...full OFF_TARGET_TITLE_MARKERS list */
],

excludedDepartments: [
  'sales', 'marketing', 'people', 'hr', /* ...full NON_ENGINEERING_DEPARTMENTS list */
],

preferredLocations: [
  'india', 'bangalore', 'bengaluru', 'mumbai', /* ...full INDIA_PLACE_MARKERS list */
  'remote', 'work from home', 'wfh', /* ...full REMOTE_MARKERS list */
],

excludedCompanies: [], // none today
```

`seniorityMinYears`/`seniorityMaxYears`/`workModes`/`employmentTypes`/`domainPreferences`/`domainExclusions` default to `null`/`[]` — there is no current hardcoded equivalent to seed from.

## 6. API changes

### DTO ([cv.dto.ts](../../../apps/api/src/cv/dto/cv.dto.ts))

`UpdateCvDto` gains optional validated fields:

```ts
@IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(50)
target_roles?: string[];

@IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(50)
excluded_roles?: string[];

@IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(50)
excluded_departments?: string[];

@IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(50)
preferred_locations?: string[];

@IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(50)
excluded_companies?: string[];

@IsOptional() @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(60)
seniority_min_years?: number;

@IsOptional() @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(60)
seniority_max_years?: number;

@IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(10)
work_modes?: string[];

@IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(10)
employment_types?: string[];

@IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(50)
domain_preferences?: string[];

@IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(50)
domain_exclusions?: string[];
```

Each array element additionally capped at a short max length (e.g. 100 chars) to match the spirit of existing `MaxLength` guards elsewhere in the DTO.

### Service ([cv.service.ts](../../../apps/api/src/cv/cv.service.ts))

`CvService.updateProfile()` extends its `patch` object to include any of the new fields present in the DTO (same `!== undefined` pattern already used for `raw_cv_text`/`experience_years`/`current_title`). `CvService.bootstrap()` extends its `insert` call with the `DEFAULT_CV` values from §5.

### Shared types ([types.ts](../../../packages/shared/src/types.ts))

`CvProfile` interface gains the 11 new fields (arrays typed `string[]`, seniority bounds typed `number | null`), matching the DB row shape exactly — same convention as the rest of the interface.

### Response shape

`GET /cv` and `PATCH /cv` already return the full `CvProfile` row via `select('*')` — no controller change needed beyond the DTO/type additions; the new columns appear automatically.

## 7. Ingest wiring — the actual behavior change

### `looksLikeRelevantRole()` signature change ([text.util.ts](../../../apps/api/src/common/text.util.ts))

```ts
// Before
export function looksLikeRelevantRole(title: string, department?: string | null): boolean

// After
export function looksLikeRelevantRole(
  title: string,
  department: string | null | undefined,
  targetRoles: readonly string[],
  excludedRoles: readonly string[],
  excludedDepartments: readonly string[],
): boolean
```

Logic is unchanged — same `containsWord()` word-boundary matching, same precedence (department check first, then excluded-role title check, then target-role title check) — only the three marker lists become parameters instead of module-level constants.

### `isIndiaOrRemote()` / `classifyLocation()` signature change ([location.util.ts](../../../apps/api/src/common/location.util.ts))

```ts
// Before
export function isIndiaOrRemote(rawLocation: string | null | undefined): boolean

// After
export function isIndiaOrRemote(
  rawLocation: string | null | undefined,
  preferredLocations: readonly string[],
): boolean
```

`preferredLocations` is expected to contain both place names (e.g. `"india"`, `"bangalore"`) and remote markers (e.g. `"remote"`, `"wfh"`) in one flat list, matching the merged `DEFAULT_CV` seed in §5 — the "India vs Remote" sub-classification (`classifyLocation`'s `LocationClass` return) collapses into a simpler "does this location string contain any preferred-location marker" check, since the remote-vs-specific-place distinction was only ever used to feed the single `isIndiaOrRemote()` boolean gate. `NON_INDIA_REMOTE_QUALIFIERS` (e.g. "US only", "EU only") stays as a hardcoded negative-qualifier list — it's a structural pattern ("remote (X only)"), not a candidate preference, so it doesn't belong on the profile.

### `IngestService` wiring ([ingest.service.ts](../../../apps/api/src/ingest/ingest.service.ts))

`run()` loads the user's `CvProfile` once per run (via `CvService.getSnapshot()`, already called elsewhere in the codebase) before `discoverCompanies()`/`scrapeResolvedCompanies()` run, and threads the 5 fields through:

- `discoverCompanies()`: skip any candidate company name matching `excluded_companies` (case-insensitive) before calling `CompanyResolverService.resolve()`.
- `scrapeAtsCompany()`: pass `target_roles`/`excluded_roles`/`excluded_departments` into `looksLikeRelevantRole()`, `preferred_locations` into `isIndiaOrRemote()`.
- `scrapeCustomCareerPage()`: same wiring.

Loading the profile once per run (not once per job) matches the parent spec's §7.3 guidance that `buildMatchingContext()` should be prepared once per run rather than reconstructed per job.

## 8. Testing

- Unit tests for the new `looksLikeRelevantRole(title, department, targetRoles, excludedRoles, excludedDepartments)` signature: verify identical pass/fail results to the current hardcoded-constant behavior when called with the `DEFAULT_CV` seed values from §5, across the existing test cases (e.g. "Platform Engineer" still excluded, "Backend Engineer" still included).
- Unit tests for the new `isIndiaOrRemote(location, preferredLocations)` signature: same parity check against `DEFAULT_CV`'s seeded `preferred_locations`.
- Migration test: apply `0005_candidate_preferences.sql` against a copy of the current schema, confirm existing `cv_profile` rows get the documented defaults (`'[]'` / `null`) and no existing row's `raw_cv_text`/`experience_years`/`current_title`/skills are touched.
- API test: `PATCH /cv` with each new field individually and in combination; confirm `GET /cv` round-trips the values; confirm validation rejects oversized arrays/strings.
- Integration smoke test: run `IngestService.run()` against a fixture user whose profile has the `DEFAULT_CV` seed values and confirm the same companies/jobs are accepted/rejected as before this change (regression check against hardcoded-constant behavior).

## 9. Acceptance criteria (mapped to parent spec §7.4)

| Parent spec criterion | How this sub-project satisfies it |
|---|---|
| User can change target roles without changing code | `PATCH /cv` with `target_roles` |
| User can change location without redeploying | `PATCH /cv` with `preferred_locations` |
| User can set preferred and excluded skills | Already satisfied by existing `cv_skills` + `proficiency`; `excluded_roles`/`excluded_departments` added here for role-level (not skill-level) exclusion |
| User can set seniority range | `PATCH /cv` with `seniority_min_years`/`seniority_max_years` — **stored, not yet consumed** (no pipeline stage reads it until Processing Pipeline sub-project) |
| LLM prompts consume structured profile data | Not yet — Groq prompt still reads `CvService.buildAnalysisContext()`'s existing title/experience/skills/raw-text shape. Extending the prompt with target roles/exclusions is Sub-project 4 (Reranking) scope, since that's where the Groq call itself is restructured. |

The last two rows are intentionally partial in this sub-project — flagged here rather than silently dropped, consistent with the parent spec's phased approach (§48 Phase 2 scopes this sub-project to "move roles/locations/seniority/work mode/exclusions from source constants to database-driven preferences," which is a data-model move; *consuming* seniority/work-mode in filtering is implicitly Phase 4's eligibility work, and consuming it in LLM prompts is Phase 6's reranking work).

## 10. Files touched

- `db/migrations/0005_candidate_preferences.sql` (new)
- `apps/api/src/cv/default-cv.ts`
- `apps/api/src/cv/dto/cv.dto.ts`
- `apps/api/src/cv/cv.service.ts`
- `apps/api/src/common/text.util.ts`
- `apps/api/src/common/location.util.ts`
- `apps/api/src/ingest/ingest.service.ts`
- `packages/shared/src/types.ts`
- New/updated test files for `text.util.ts`, `location.util.ts`, `cv.service.ts`, migration
