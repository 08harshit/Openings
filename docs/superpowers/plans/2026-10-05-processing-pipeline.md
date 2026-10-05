# Processing Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a deterministic pipeline between scraping and Groq — normalize → eligibility (hard rejects only) → cheap retrieval score → floor → dedup/insert → Top-N to Groq — so borderline engineering roles reach scoring, Groq analyzes the best jobs (including a backlog), and distinct requisitions stop being merged.

**Architecture:** Five pure-function modules in a new `apps/api/src/pipeline/` folder (`normalize`, `eligibility`, `retrieval-score`, `select`, `evaluate`), no NestJS DI. `IngestService.run()` calls `evaluateCandidates()` after scraping, inserts the ordered above-floor jobs with their score and ATS ID, then builds a Top-N analysis pool from saved-but-unanalyzed jobs. One migration (`0008`) adds columns, swaps the dedup index for a location-aware one, and trims adjacent roles from live profiles.

**Tech Stack:** NestJS, TypeScript, Jest (`ts-jest`, `*.spec.ts` colocated), Supabase/Postgres.

**Spec:** [docs/superpowers/specs/2026-10-05-processing-pipeline-design.md](../specs/2026-10-05-processing-pipeline-design.md)

## Global Constraints

- Pipeline modules are plain exported functions — no `@Injectable`, no constructor DI.
- Pipeline functions never throw on odd-but-possible input: empty strings, null locations, null/missing dates, numeric profile fields that arrive as strings from PostgREST.
- `RETRIEVAL_WEIGHTS = { role: 25, skills: 35, experience: 20, location: 10, freshness: 5, source: 5 }` — exact values.
- Score floor default 40 (`INGEST_RETRIEVAL_FLOOR`), backlog window default 30 days (`INGEST_ANALYSIS_BACKLOG_DAYS`), backlog query limit 200.
- The nine adjacent roles removed from `excluded_roles`: `platform engineer`, `devops engineer`, `site reliability`, `data engineer`, `security engineer`, `solutions engineer`, `ml engineer`, `machine learning engineer`, `ai engineer`.
- No live network or database calls in any test (`global.fetch` and the Supabase client are mocked).
- `packages/shared` resolves via its built `dist/` — after editing anything in `packages/shared/src`, run `cd packages/shared && npm run build` before typechecking `apps/api`.
- Migration `0008_processing_pipeline.sql` is **created only**, never applied by an implementer. The user applies it in the Supabase SQL Editor, and it must be applied **before** this branch is pushed (Render auto-deploys `main`).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Numeric profile fields arriving as strings** (`experience_years: "2.2"` from PostgREST's `numeric`): eligibility's years ceiling and the experience score must coerce, not compare strings. Pinned in Task 3.
- **A candidate with an empty description** (Firecrawl snippet-only results): normalize and score must return neutral values, not throw. Pinned in Task 4.
- **A large ATS board where more jobs pass the floor than `maxNewJobsPerRun`**: the cap must keep the highest-scoring jobs, not the first-scraped. Pinned in Task 7.
- **Same title, same company, different city**: both survive in-run dedup and both are kept. Pinned in Task 5 and Task 7.
- **A backlog row saved before the migration** (null `retrieval_score`, possibly null `description_raw`): it is scored from stored fields without throwing and ranked, not skipped. Pinned in Task 7.

---

## Task 1: Plumbing — ATS job IDs, optional candidate fields, export `containsWord`

**Files:**
- Modify: `apps/api/src/firecrawl/firecrawl.types.ts` (`RawJobCandidate`)
- Modify: `apps/api/src/discovery/ats-clients.ts` (`AtsJobListing` + the three provider mappers)
- Modify: `apps/api/src/common/text.util.ts` (`containsWord` becomes exported)
- Test: Create `apps/api/src/discovery/ats-clients.spec.ts`; modify `apps/api/src/common/text.util.spec.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `RawJobCandidate.externalId?: string | null`, `RawJobCandidate.department?: string | null`; `AtsJobListing.externalId: string | null`; `export function containsWord(haystack: string, marker: string): boolean` — consumed by Tasks 2, 3, 4, 7

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/discovery/ats-clients.spec.ts`:

```ts
import { fetchAtsJobs } from './ats-clients';

describe('fetchAtsJobs externalId mapping', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockJson(body: unknown): void {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => body } as Response);
  }

  it('maps a Greenhouse numeric id to a string externalId', async () => {
    mockJson({
      jobs: [
        {
          id: 4012345,
          title: 'Backend Engineer',
          absolute_url: 'https://boards.greenhouse.io/acme/jobs/4012345',
          location: { name: 'Bangalore' },
          departments: [{ name: 'Engineering' }],
        },
      ],
    });

    const jobs = await fetchAtsJobs('greenhouse', 'acme');

    expect(jobs[0].externalId).toBe('4012345');
  });

  it('maps a Lever id', async () => {
    mockJson([{ id: 'a1b2-c3d4', text: 'Backend Engineer', hostedUrl: 'https://jobs.lever.co/acme/a1b2-c3d4' }]);

    const jobs = await fetchAtsJobs('lever', 'acme');

    expect(jobs[0].externalId).toBe('a1b2-c3d4');
  });

  it('maps an Ashby id', async () => {
    mockJson({ jobs: [{ id: 'f00d-0001', title: 'Backend Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/f00d-0001' }] });

    const jobs = await fetchAtsJobs('ashby', 'acme');

    expect(jobs[0].externalId).toBe('f00d-0001');
  });

  it('uses null when the ATS omits an id', async () => {
    mockJson({ jobs: [{ title: 'Backend Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' }] });

    const jobs = await fetchAtsJobs('greenhouse', 'acme');

    expect(jobs[0].externalId).toBeNull();
  });
});
```

In `apps/api/src/common/text.util.spec.ts`, change the first line from:

```ts
import { looksLikeRelevantRole } from './text.util';
```

to:

```ts
import { containsWord, looksLikeRelevantRole } from './text.util';
```

and append at the end of the file:

```ts
describe('containsWord', () => {
  it('matches a whole word case-insensitively', () => {
    expect(containsWord('Senior Backend Engineer', 'backend')).toBe(true);
  });

  it('does not match inside a longer word', () => {
    expect(containsWord('Internal Tools Engineer', 'intern')).toBe(false);
  });

  it('never matches a blank marker', () => {
    expect(containsWord('Anything at all', '   ')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest ats-clients.spec.ts text.util.spec.ts`
Expected: FAIL — `text.util.spec.ts` fails to compile (`containsWord` is not exported); `ats-clients.spec.ts` fails its assertions (`externalId` is `undefined`).

- [ ] **Step 3: Add the optional fields to `RawJobCandidate`**

In `apps/api/src/firecrawl/firecrawl.types.ts`, inside `export interface RawJobCandidate`, after the `postedDateIso: string | null;` line, add:

```ts
  /** Stable job ID from the source ATS (Greenhouse/Lever/Ashby). Absent for scraped pages. */
  externalId?: string | null;
  /** ATS-provided department(s), comma-joined. Absent for scraped pages. */
  department?: string | null;
```

- [ ] **Step 4: Map ATS job IDs**

In `apps/api/src/discovery/ats-clients.ts`:

Add to `export interface AtsJobListing` (after `description: string | null;`):

```ts
  /** The ATS's own job ID, used for dedup. Null when the platform omits it. */
  externalId: string | null;
```

In `tryGreenhouse`, add `id?: number;` as the first field of the `jobs?: Array<{ ... }>` element type, and add to the mapped object (after `description: ...`):

```ts
        externalId: j.id !== undefined && j.id !== null ? String(j.id) : null,
```

In `tryLever`, add `id?: string;` as the first field of the element type, and add to the mapped object:

```ts
        externalId: j.id ?? null,
```

In `tryAshby`, add `id?: string;` as the first field of the `jobs?: Array<{ ... }>` element type, and add to the mapped object:

```ts
        externalId: j.id ?? null,
```

- [ ] **Step 5: Export `containsWord`**

In `apps/api/src/common/text.util.ts`, change `function containsWord(haystack: string, marker: string): boolean {` to `export function containsWord(haystack: string, marker: string): boolean {`. No other change.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/api && npx jest ats-clients.spec.ts text.util.spec.ts`
Expected: PASS (4 + existing text.util tests + 3 new containsWord tests)

- [ ] **Step 7: Typecheck and full suite**

Run: `cd apps/api && npm run typecheck && npm test`
Expected: typecheck clean; all suites pass.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/firecrawl/firecrawl.types.ts apps/api/src/discovery/ats-clients.ts apps/api/src/discovery/ats-clients.spec.ts apps/api/src/common/text.util.ts apps/api/src/common/text.util.spec.ts
git commit -m "feat(ats): capture ATS job IDs; export containsWord for the pipeline"
```

---

## Task 2: `normalize.ts` — parse each candidate once

**Files:**
- Create: `apps/api/src/pipeline/normalize.ts`
- Test: Create `apps/api/src/pipeline/normalize.spec.ts`

**Interfaces:**
- Consumes: `RawJobCandidate` (with Task 1's optional fields); `SEED_SKILLS` from `@jobportal/shared`; `normalizeWhitespace` from `../common/text.util`; `urlHash` from `../common/url.util`
- Produces:
  - `export interface ScopedCandidate { candidate: RawJobCandidate; companyId: string; companyName: string }`
  - `export interface NormalizedJob { candidate; companyId; companyName; title: string; description: string; location: string | null; isRemote: boolean; requiredYearsMin: number | null; mentionedSkills: string[]; externalId: string | null; department: string | null; urlHash: string }`
  - `export function parseRequiredYears(text: string): number | null`
  - `export function extractMentionedSkills(text: string): string[]`
  - `export function normalizeCandidate(scoped: ScopedCandidate): NormalizedJob`
  — consumed by Tasks 3, 4, 5, 7

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/pipeline/normalize.spec.ts`:

```ts
import { extractMentionedSkills, normalizeCandidate, parseRequiredYears } from './normalize';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

describe('parseRequiredYears', () => {
  it.each([
    ['3+ years of experience in Node.js', 3],
    ['We need 3 + yrs of backend work', 3],
    ['2-4 years of experience', 2],
    ['2 – 4 years', 2],
    ['2 to 4 years building APIs', 2],
    ['Minimum 3 years', 3],
    ['minimum of 3 years', 3],
    ['at least 3 years', 3],
    ['3 years of experience', 3],
    ['3 years experience with Postgres', 3],
    ['3 yrs exp', 3],
  ])('reads %p as %p', (text, expected) => {
    expect(parseRequiredYears(text)).toBe(expected);
  });

  it('returns the largest lower bound when several are stated', () => {
    expect(parseRequiredYears('5+ years experience overall, 2+ years with Kafka')).toBe(5);
  });

  it('does not double-count the upper end of a range', () => {
    expect(parseRequiredYears('2-4 years of experience')).toBe(2);
  });

  it('ignores implausible numbers like company age', () => {
    expect(parseRequiredYears('We have been in business for 25+ years')).toBeNull();
  });

  it('ignores a bare "N years" with no experience context', () => {
    expect(parseRequiredYears('Founded 5 years ago in Bangalore')).toBeNull();
  });

  it('returns null for empty text or text with no years', () => {
    expect(parseRequiredYears('')).toBeNull();
    expect(parseRequiredYears('Great culture, free lunch')).toBeNull();
  });
});

describe('extractMentionedSkills', () => {
  it('finds canonical skills via their aliases', () => {
    const skills = extractMentionedSkills('Build services in Node.js and PostgreSQL behind a REST API');
    expect(skills).toEqual(expect.arrayContaining(['nodejs', 'postgresql', 'rest-api']));
  });

  it('does not match ambiguous English words on their own', () => {
    const skills = extractMentionedSkills('Our go to market team will express interest; rest of the team is in spring mode');
    expect(skills).not.toContain('go');
    expect(skills).not.toContain('expressjs');
    expect(skills).not.toContain('rest-api');
    expect(skills).not.toContain('spring-boot');
  });

  it('still matches the unambiguous forms', () => {
    const skills = extractMentionedSkills('Golang, Express.js and Spring Boot');
    expect(skills).toEqual(expect.arrayContaining(['go', 'expressjs', 'spring-boot']));
  });

  it('does not match java inside javascript', () => {
    expect(extractMentionedSkills('Strong JavaScript skills')).not.toContain('java');
  });

  it('returns each skill once', () => {
    const skills = extractMentionedSkills('Node.js, node.js, NodeJS');
    expect(skills.filter((s) => s === 'nodejs')).toHaveLength(1);
  });

  it('returns an empty list for empty text', () => {
    expect(extractMentionedSkills('')).toEqual([]);
  });
});

describe('normalizeCandidate', () => {
  function candidate(overrides: Partial<RawJobCandidate> = {}): RawJobCandidate {
    return {
      title: '  Backend   Engineer ',
      url: 'https://acme.com/careers/1?utm_source=x',
      companyNameHint: 'Acme',
      locationHint: ' Bangalore, India ',
      snippet: 'short snippet',
      markdown: '3+ years of experience with Node.js. Fully remote team.',
      source: 'ats_api',
      postedDateIso: '2026-10-01',
      externalId: '123',
      department: 'Engineering',
      ...overrides,
    };
  }

  it('produces the normalized fields', () => {
    const job = normalizeCandidate({ candidate: candidate(), companyId: 'c1', companyName: 'Acme' });

    expect(job.title).toBe('Backend Engineer');
    expect(job.location).toBe('Bangalore, India');
    expect(job.requiredYearsMin).toBe(3);
    expect(job.mentionedSkills).toContain('nodejs');
    expect(job.isRemote).toBe(true);
    expect(job.externalId).toBe('123');
    expect(job.department).toBe('Engineering');
    expect(job.companyId).toBe('c1');
    expect(job.urlHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('falls back to the snippet when there is no markdown', () => {
    const job = normalizeCandidate({ candidate: candidate({ markdown: null }), companyId: 'c1', companyName: 'Acme' });
    expect(job.description).toBe('short snippet');
  });

  it('turns an empty location into null and missing ATS fields into null', () => {
    const job = normalizeCandidate({
      candidate: candidate({ locationHint: '   ', externalId: undefined, department: undefined }),
      companyId: 'c1',
      companyName: 'Acme',
    });
    expect(job.location).toBeNull();
    expect(job.externalId).toBeNull();
    expect(job.department).toBeNull();
  });

  it('detects remote from the location string', () => {
    const job = normalizeCandidate({
      candidate: candidate({ locationHint: 'Remote', markdown: 'No location words here.' }),
      companyId: 'c1',
      companyName: 'Acme',
    });
    expect(job.isRemote).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest pipeline/normalize.spec.ts`
Expected: FAIL — `./normalize` module does not exist.

- [ ] **Step 3: Implement `normalize.ts`**

Create `apps/api/src/pipeline/normalize.ts`:

```ts
import { SEED_SKILLS } from '@jobportal/shared';
import { normalizeWhitespace } from '../common/text.util';
import { urlHash } from '../common/url.util';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

/** A scraped candidate plus the company it was scraped from. */
export interface ScopedCandidate {
  candidate: RawJobCandidate;
  companyId: string;
  companyName: string;
}

/** A candidate parsed once, so eligibility and scoring never re-parse text. */
export interface NormalizedJob {
  candidate: RawJobCandidate;
  companyId: string;
  companyName: string;
  title: string;
  description: string;
  location: string | null;
  isRemote: boolean;
  requiredYearsMin: number | null;
  mentionedSkills: string[];
  externalId: string | null;
  department: string | null;
  urlHash: string;
}

const YEARS_SCAN_LIMIT = 4000;
const MAX_PLAUSIBLE_YEARS = 20;
const REMOTE_SCAN_LIMIT = 1500;
const UNIT = '(?:years?|yrs?)';

// Order matters: ranges claim their whole span first so the upper bound of
// "2-4 years" is never re-read as a standalone "4 years".
const YEARS_PATTERNS: RegExp[] = [
  new RegExp(`\\b(\\d{1,2})\\s*(?:-|–|—|to)\\s*(\\d{1,2})\\s*\\+?\\s*${UNIT}\\b`, 'g'),
  new RegExp(`\\b(?:minimum(?:\\s+of)?|at\\s+least)\\s+(\\d{1,2})\\s*\\+?\\s*${UNIT}\\b`, 'g'),
  new RegExp(`\\b(\\d{1,2})\\s*\\+\\s*${UNIT}\\b`, 'g'),
  // A bare "N years" only counts when "experience"/"exp" follows shortly,
  // otherwise "founded 5 years ago" would read as a requirement.
  new RegExp(`\\b(\\d{1,2})\\s*${UNIT}\\b(?=[^.\\n]{0,40}?\\b(?:experience|exp)\\b)`, 'g'),
];

/**
 * Lower bound of the years of experience a posting asks for, or null. When
 * several are stated ("5+ years overall, 2+ with Kafka") the largest lower
 * bound is the role's overall requirement.
 */
export function parseRequiredYears(text: string): number | null {
  if (!text) return null;
  const scanned = text.slice(0, YEARS_SCAN_LIMIT).toLowerCase();
  const claimed: Array<[number, number]> = [];
  const bounds: number[] = [];

  for (const pattern of YEARS_PATTERNS) {
    for (const match of scanned.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      claimed.push([start, end]);
      const lower = Number(match[1]);
      if (Number.isFinite(lower) && lower <= MAX_PLAUSIBLE_YEARS) bounds.push(lower);
    }
  }

  return bounds.length > 0 ? Math.max(...bounds) : null;
}

/** Common English words that are also skill aliases — matching them alone
 * produces false positives ("go to market", "rest of the team"). Their
 * unambiguous forms (golang, restful, express.js, ...) still match. */
const AMBIGUOUS_TERMS = new Set([
  'go', 'rest', 'express', 'spring', 'nest', 'node', 'next', 'bull', 'ws',
  'ts', 'js', 'py', 'auth', 'eda', 'kube',
]);

interface SkillPattern {
  slug: string;
  pattern: RegExp;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Alphanumeric lookarounds instead of \b, so "c#", ".net" and "node.js"
 * match, and "java" does not match inside "javascript". */
function termPattern(term: string): RegExp {
  const body = escapeRegex(term).replace(/\s+/g, '[\\s-]+');
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i');
}

const SKILL_PATTERNS: SkillPattern[] = SEED_SKILLS.flatMap((skill) =>
  [skill.name.replace(/-/g, ' '), ...skill.aliases]
    .map((term) => term.toLowerCase().trim())
    .filter((term) => term.length > 0 && !AMBIGUOUS_TERMS.has(term))
    .map((term) => ({ slug: skill.name, pattern: termPattern(term) })),
);

/** Canonical skill slugs from the shared taxonomy mentioned in `text`. */
export function extractMentionedSkills(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const { slug, pattern } of SKILL_PATTERNS) {
    if (!found.has(slug) && pattern.test(text)) found.add(slug);
  }
  return [...found];
}

const REMOTE_PATTERN = /\b(remote|work from home|wfh|fully distributed)\b/i;

export function normalizeCandidate(scoped: ScopedCandidate): NormalizedJob {
  const { candidate, companyId, companyName } = scoped;
  const title = (candidate.title ?? '').replace(/\s+/g, ' ').trim();
  const description = normalizeWhitespace(candidate.markdown ?? candidate.snippet ?? '');
  const trimmedLocation = candidate.locationHint?.trim() ?? '';
  const location = trimmedLocation.length > 0 ? trimmedLocation : null;

  return {
    candidate,
    companyId,
    companyName,
    title,
    description,
    location,
    isRemote: REMOTE_PATTERN.test(`${location ?? ''} ${description.slice(0, REMOTE_SCAN_LIMIT)}`),
    requiredYearsMin: parseRequiredYears(description),
    mentionedSkills: extractMentionedSkills(`${title}\n${description}`),
    externalId: candidate.externalId ?? null,
    department: candidate.department ?? null,
    urlHash: urlHash(candidate.url),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest pipeline/normalize.spec.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pipeline/normalize.ts apps/api/src/pipeline/normalize.spec.ts
git commit -m "feat(pipeline): normalize candidates — years required, skills mentioned, remote, ATS id"
```

---

## Task 3: `eligibility.ts` — hard rejects with reason codes

**Files:**
- Create: `apps/api/src/pipeline/eligibility.ts`
- Test: Create `apps/api/src/pipeline/eligibility.spec.ts`

**Interfaces:**
- Consumes: `NormalizedJob` (Task 2); `containsWord` (Task 1); `isIndiaOrRemote(rawLocation, preferredLocations)` from `../common/location.util`; `CvProfile` from `@jobportal/shared`
- Produces:
  - `export type RejectionReason = 'excluded_department' | 'excluded_role' | 'leadership_or_intern' | 'non_engineering_title' | 'experience_too_high' | 'location_mismatch'`
  - `export type EligibilityResult = { eligible: true } | { eligible: false; reason: RejectionReason }`
  - `export const GENERIC_ENGINEERING_MARKERS: readonly string[]`
  - `export function matchesTargetRole(title: string, targetRoles: readonly string[]): boolean`
  - `export function isEngineeringTitle(title: string, targetRoles: readonly string[]): boolean`
  - `export function toNumberOrNull(value: unknown): number | null`
  - `export function yearsCeiling(profile: Pick<CvProfile, 'experience_years' | 'seniority_max_years'>): number | null`
  - `export function evaluateEligibility(job: NormalizedJob, profile: CvProfile): EligibilityResult`
  — consumed by Tasks 4, 5, 7

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/pipeline/eligibility.spec.ts`:

```ts
import type { CvProfile } from '@jobportal/shared';
import { evaluateEligibility, yearsCeiling } from './eligibility';
import type { NormalizedJob } from './normalize';

function profile(overrides: Partial<CvProfile> = {}): CvProfile {
  return {
    id: 'p1',
    user_id: 'u1',
    raw_cv_text: null,
    experience_years: 2.2,
    current_title: null,
    updated_at: '2026-10-05T00:00:00Z',
    target_roles: ['backend', 'full stack', 'software engineer', 'software developer', 'node.js', 'nestjs', 'sde'],
    excluded_roles: ['sales engineer', 'qa engineer', 'frontend engineer'],
    excluded_departments: ['sales', 'marketing'],
    preferred_locations: ['india', 'bangalore', 'bengaluru', 'remote'],
    excluded_companies: [],
    seniority_min_years: null,
    seniority_max_years: null,
    work_modes: [],
    employment_types: [],
    domain_preferences: [],
    domain_exclusions: [],
    ...overrides,
  };
}

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    candidate: {
      title: 'Backend Engineer',
      url: 'https://acme.com/jobs/1',
      companyNameHint: null,
      locationHint: 'Bangalore, India',
      snippet: '',
      markdown: null,
      source: 'ats_api',
      postedDateIso: null,
    },
    companyId: 'c1',
    companyName: 'Acme',
    title: 'Backend Engineer',
    description: '',
    location: 'Bangalore, India',
    isRemote: false,
    requiredYearsMin: null,
    mentionedSkills: [],
    externalId: null,
    department: null,
    urlHash: 'hash-1',
    ...overrides,
  };
}

function reasonFor(overrides: Partial<NormalizedJob>, p: CvProfile = profile()): string | null {
  const result = evaluateEligibility(job(overrides), p);
  return result.eligible ? null : result.reason;
}

describe('evaluateEligibility', () => {
  it('accepts a target-role job in a preferred location', () => {
    expect(reasonFor({})).toBeNull();
  });

  it('rejects an excluded department', () => {
    expect(reasonFor({ department: 'Sales, Partnerships' })).toBe('excluded_department');
  });

  it('rejects an excluded role', () => {
    expect(reasonFor({ title: 'QA Engineer' })).toBe('excluded_role');
  });

  it.each(['Staff Software Engineer', 'Engineering Manager', 'Principal Engineer', 'Head of Engineering', 'Backend Intern'])(
    'rejects leadership/intern title %p',
    (title) => {
      expect(reasonFor({ title })).toBe('leadership_or_intern');
    },
  );

  it('keeps "Member of Technical Staff" (staff is not a level there)', () => {
    expect(reasonFor({ title: 'Member of Technical Staff' })).toBeNull();
  });

  it('keeps "Internal Tools Engineer" (not an intern role)', () => {
    expect(reasonFor({ title: 'Internal Tools Engineer' })).toBeNull();
  });

  it.each(['Life at Acme', 'Account Executive', 'Business Development Executive'])(
    'rejects non-engineering title %p',
    (title) => {
      expect(reasonFor({ title })).toBe('non_engineering_title');
    },
  );

  it.each(['Platform Engineer', 'Engineer II', 'Founding Engineer', 'Product Engineer'])(
    'keeps borderline engineering title %p for scoring',
    (title) => {
      expect(reasonFor({ title })).toBeNull();
    },
  );

  it('rejects a role needing more than experience + 3 years', () => {
    expect(reasonFor({ requiredYearsMin: 7 })).toBe('experience_too_high');
  });

  it('keeps a stretch role within experience + 3 years', () => {
    expect(reasonFor({ requiredYearsMin: 5 })).toBeNull();
  });

  it('uses seniority_max_years instead of the +3 rule when set', () => {
    expect(reasonFor({ requiredYearsMin: 5 }, profile({ seniority_max_years: 4 }))).toBe('experience_too_high');
  });

  it('skips the years check when both experience fields are null', () => {
    expect(reasonFor({ requiredYearsMin: 15 }, profile({ experience_years: null, seniority_max_years: null }))).toBeNull();
  });

  it('coerces numeric profile fields that arrive as strings', () => {
    const stringly = profile({ experience_years: '2.2' as unknown as number });
    expect(reasonFor({ requiredYearsMin: 7 }, stringly)).toBe('experience_too_high');
    expect(reasonFor({ requiredYearsMin: 5 }, stringly)).toBeNull();
  });

  it('rejects a known non-preferred location', () => {
    expect(reasonFor({ location: 'San Francisco, CA' })).toBe('location_mismatch');
  });

  it('keeps a job with no stated location', () => {
    expect(reasonFor({ location: null })).toBeNull();
  });

  it('keeps a remote job', () => {
    expect(reasonFor({ location: 'Remote' })).toBeNull();
  });
});

describe('yearsCeiling', () => {
  it('is experience + 3 by default', () => {
    expect(yearsCeiling({ experience_years: 2.2, seniority_max_years: null })).toBeCloseTo(5.2);
  });

  it('is seniority_max_years when set', () => {
    expect(yearsCeiling({ experience_years: 2.2, seniority_max_years: 4 })).toBe(4);
  });

  it('is null when both are null', () => {
    expect(yearsCeiling({ experience_years: null, seniority_max_years: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest pipeline/eligibility.spec.ts`
Expected: FAIL — `./eligibility` module does not exist.

- [ ] **Step 3: Implement `eligibility.ts`**

Create `apps/api/src/pipeline/eligibility.ts`:

```ts
import type { CvProfile } from '@jobportal/shared';
import { containsWord } from '../common/text.util';
import { isIndiaOrRemote } from '../common/location.util';
import type { NormalizedJob } from './normalize';

export type RejectionReason =
  | 'excluded_department'
  | 'excluded_role'
  | 'leadership_or_intern'
  | 'non_engineering_title'
  | 'experience_too_high'
  | 'location_mismatch';

export type EligibilityResult = { eligible: true } | { eligible: false; reason: RejectionReason };

/** Titles that are engineering roles even when they match no target role.
 * Not "development" — it would admit "Business Development Executive". */
export const GENERIC_ENGINEERING_MARKERS: readonly string[] = [
  'engineer', 'engineering', 'developer', 'sde', 'swe', 'programmer', 'technical staff', 'mts',
];

const LEADERSHIP_OR_INTERN_MARKERS: readonly string[] = [
  'principal', 'director', 'head of', 'vp', 'vice president', 'manager', 'architect', 'intern', 'internship',
];

const YEARS_SLACK = 3;

export function matchesTargetRole(title: string, targetRoles: readonly string[]): boolean {
  return targetRoles.some((role) => containsWord(title, role));
}

export function isEngineeringTitle(title: string, targetRoles: readonly string[]): boolean {
  return (
    matchesTargetRole(title, targetRoles) ||
    GENERIC_ENGINEERING_MARKERS.some((marker) => containsWord(title, marker))
  );
}

/** PostgREST can return `numeric` columns as strings; compare numbers only. */
export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Most years a posting may ask for before it's out of reach. */
export function yearsCeiling(profile: Pick<CvProfile, 'experience_years' | 'seniority_max_years'>): number | null {
  const max = toNumberOrNull(profile.seniority_max_years);
  if (max !== null) return max;
  const experience = toNumberOrNull(profile.experience_years);
  return experience === null ? null : experience + YEARS_SLACK;
}

function hasLeadershipOrInternMarker(title: string): boolean {
  // "Member of Technical Staff" is an individual-contributor title.
  if (containsWord(title.replace(/technical\s+staff/gi, ''), 'staff')) return true;
  return LEADERSHIP_OR_INTERN_MARKERS.some((marker) => containsWord(title, marker));
}

function reject(reason: RejectionReason): EligibilityResult {
  return { eligible: false, reason };
}

/** Hard rejects only — anything borderline passes and is ranked by the
 * retrieval score instead. First failing check wins. */
export function evaluateEligibility(job: NormalizedJob, profile: CvProfile): EligibilityResult {
  const department = job.department;
  if (department && profile.excluded_departments.some((d) => containsWord(department, d))) {
    return reject('excluded_department');
  }
  if (profile.excluded_roles.some((role) => containsWord(job.title, role))) return reject('excluded_role');
  if (hasLeadershipOrInternMarker(job.title)) return reject('leadership_or_intern');
  if (!isEngineeringTitle(job.title, profile.target_roles)) return reject('non_engineering_title');

  const ceiling = yearsCeiling(profile);
  if (ceiling !== null && job.requiredYearsMin !== null && job.requiredYearsMin > ceiling) {
    return reject('experience_too_high');
  }

  if (job.location !== null && !isIndiaOrRemote(job.location, profile.preferred_locations)) {
    return reject('location_mismatch');
  }

  return { eligible: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest pipeline/eligibility.spec.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pipeline/eligibility.ts apps/api/src/pipeline/eligibility.spec.ts
git commit -m "feat(pipeline): eligibility with hard-reject reason codes"
```

---

## Task 4: `retrieval-score.ts` — cheap 0–100 score

**Files:**
- Create: `apps/api/src/pipeline/retrieval-score.ts`
- Test: Create `apps/api/src/pipeline/retrieval-score.spec.ts`

**Interfaces:**
- Consumes: `NormalizedJob` (Task 2); `matchesTargetRole`, `isEngineeringTitle`, `toNumberOrNull` (Task 3); `containsWord` (Task 1); `isIndiaOrRemote` from `../common/location.util`; `ageInDays(date, reference)` from `../common/date.util`
- Produces:
  - `export const RETRIEVAL_WEIGHTS`
  - `export interface ScoringContext { profile: CvProfile; cvSkillNames: string[]; now: Date }`
  - `export interface RetrievalSignals { role; skills; experience; location; freshness; source: number; requiredYearsMin: number | null; mentionedSkills: string[]; matchedSkills: string[] }`
  - `export interface RetrievalResult { score: number; signals: RetrievalSignals }`
  - `export function scoreRetrieval(job: NormalizedJob, ctx: ScoringContext): RetrievalResult`
  — consumed by Tasks 5, 7

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/pipeline/retrieval-score.spec.ts`:

```ts
import type { CvProfile } from '@jobportal/shared';
import { RETRIEVAL_WEIGHTS, scoreRetrieval, type ScoringContext } from './retrieval-score';
import type { NormalizedJob } from './normalize';

const NOW = new Date('2026-10-05T12:00:00Z');

function profile(overrides: Partial<CvProfile> = {}): CvProfile {
  return {
    id: 'p1',
    user_id: 'u1',
    raw_cv_text: null,
    experience_years: 2.2,
    current_title: null,
    updated_at: '2026-10-05T00:00:00Z',
    target_roles: ['backend', 'full stack', 'software engineer', 'software developer', 'node.js', 'nestjs', 'sde'],
    excluded_roles: [],
    excluded_departments: [],
    preferred_locations: ['india', 'bangalore', 'remote'],
    excluded_companies: [],
    seniority_min_years: null,
    seniority_max_years: null,
    work_modes: [],
    employment_types: [],
    domain_preferences: [],
    domain_exclusions: [],
    ...overrides,
  };
}

function ctx(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    profile: profile(),
    cvSkillNames: ['nodejs', 'nestjs', 'postgresql', 'redis', 'kafka', 'aws', 'docker', 'typescript'],
    now: NOW,
    ...overrides,
  };
}

function job(overrides: Partial<NormalizedJob> = {}, candidate: Partial<NormalizedJob['candidate']> = {}): NormalizedJob {
  return {
    candidate: {
      title: 'Backend Engineer',
      url: 'https://acme.com/jobs/1',
      companyNameHint: null,
      locationHint: 'Bangalore, India',
      snippet: '',
      markdown: null,
      source: 'ats_api',
      postedDateIso: null,
      ...candidate,
    },
    companyId: 'c1',
    companyName: 'Acme',
    title: 'Backend Engineer',
    description: '',
    location: 'Bangalore, India',
    isRemote: false,
    requiredYearsMin: null,
    mentionedSkills: [],
    externalId: null,
    department: null,
    urlHash: 'hash-1',
    ...overrides,
  };
}

describe('RETRIEVAL_WEIGHTS', () => {
  it('sums to 100', () => {
    const total = Object.values(RETRIEVAL_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });
});

describe('scoreRetrieval — role', () => {
  it('gives 25 to a target-role title', () => {
    expect(scoreRetrieval(job(), ctx()).signals.role).toBe(25);
  });

  it('gives 12 to a generic engineering title', () => {
    expect(scoreRetrieval(job({ title: 'Platform Engineer' }), ctx()).signals.role).toBe(12);
  });
});

describe('scoreRetrieval — skills', () => {
  it('is neutral (14) when the posting mentions no known skills', () => {
    expect(scoreRetrieval(job(), ctx()).signals.skills).toBe(14);
  });

  it('scores overlap against at least 4 mentioned skills', () => {
    const result = scoreRetrieval(job({ mentionedSkills: ['nodejs', 'postgresql'] }), ctx());
    expect(result.signals.skills).toBe(18); // round(35 * 2/4) = 17.5 -> 18
    expect(result.signals.matchedSkills).toEqual(['nodejs', 'postgresql']);
  });

  it('scores partial coverage of a longer list', () => {
    const mentioned = ['nodejs', 'postgresql', 'redis', 'kafka', 'aws', 'java'];
    expect(scoreRetrieval(job({ mentionedSkills: mentioned }), ctx()).signals.skills).toBe(29); // 35 * 5/6
  });

  it('gives 35 for full coverage', () => {
    const mentioned = ['nodejs', 'nestjs', 'postgresql', 'redis'];
    expect(scoreRetrieval(job({ mentionedSkills: mentioned }), ctx()).signals.skills).toBe(35);
  });

  it('gives 0 when no mentioned skill is on the CV', () => {
    expect(scoreRetrieval(job({ mentionedSkills: ['java', 'spring-boot'] }), ctx()).signals.skills).toBe(0);
  });
});

describe('scoreRetrieval — experience (experience_years 2.2)', () => {
  it.each([
    [2, 20],
    [3, 15],
    [4, 9],
    [5, 4],
    [6, 0],
  ])('requiredYearsMin %p -> %p points', (req, points) => {
    expect(scoreRetrieval(job({ requiredYearsMin: req }), ctx()).signals.experience).toBe(points);
  });

  it('is neutral (12) when no years are stated', () => {
    expect(scoreRetrieval(job(), ctx()).signals.experience).toBe(12);
  });

  it('is 8 for a senior title with no stated years', () => {
    expect(scoreRetrieval(job({ title: 'Senior Backend Engineer' }), ctx()).signals.experience).toBe(8);
  });

  it('is 10 for a junior/fresher title when the candidate has 2+ years', () => {
    expect(scoreRetrieval(job({ title: 'Junior Backend Developer', requiredYearsMin: 0 }), ctx()).signals.experience).toBe(10);
  });

  it('is neutral when the profile has no experience_years', () => {
    const noExp = ctx({ profile: profile({ experience_years: null }) });
    expect(scoreRetrieval(job({ requiredYearsMin: 3 }), noExp).signals.experience).toBe(12);
  });
});

describe('scoreRetrieval — location', () => {
  it('gives 10 to a preferred location', () => {
    expect(scoreRetrieval(job(), ctx()).signals.location).toBe(10);
  });

  it('gives 10 to a remote job', () => {
    expect(scoreRetrieval(job({ location: null, isRemote: true }), ctx()).signals.location).toBe(10);
  });

  it('gives 5 when the location is unknown', () => {
    expect(scoreRetrieval(job({ location: null }), ctx()).signals.location).toBe(5);
  });
});

describe('scoreRetrieval — freshness (now = 2026-10-05T12:00Z)', () => {
  it.each([
    ['2026-10-02', 5],
    ['2026-09-28', 4],
    ['2026-09-21', 2],
    ['2026-09-01', 0],
    [null, 3],
    ['not-a-date', 3],
  ])('postedDateIso %p -> %p points', (posted, points) => {
    expect(scoreRetrieval(job({}, { postedDateIso: posted }), ctx()).signals.freshness).toBe(points);
  });
});

describe('scoreRetrieval — source', () => {
  it.each([
    ['ats_api', 5],
    ['http_scrape', 4],
    ['firecrawl_scrape', 3],
  ] as const)('%p -> %p points', (source, points) => {
    expect(scoreRetrieval(job({}, { source }), ctx()).signals.source).toBe(points);
  });
});

describe('scoreRetrieval — totals', () => {
  it('scores a strong job at 100', () => {
    const strong = job(
      { mentionedSkills: ['nodejs', 'nestjs', 'postgresql', 'redis'], requiredYearsMin: 2 },
      { postedDateIso: '2026-10-04', source: 'ats_api' },
    );
    expect(scoreRetrieval(strong, ctx()).score).toBe(100);
  });

  it('gives neutral values, not an error, for an empty description', () => {
    const empty = job(
      { title: 'Engineer', description: '', location: null, mentionedSkills: [], requiredYearsMin: null },
      { source: 'firecrawl_scrape', postedDateIso: null },
    );
    // role 12 + skills 14 + experience 12 + location 5 + freshness 3 + source 3
    expect(scoreRetrieval(empty, ctx()).score).toBe(49);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx jest pipeline/retrieval-score.spec.ts`
Expected: FAIL — `./retrieval-score` module does not exist.

- [ ] **Step 3: Implement `retrieval-score.ts`**

Create `apps/api/src/pipeline/retrieval-score.ts`:

```ts
import type { CvProfile } from '@jobportal/shared';
import { containsWord } from '../common/text.util';
import { isIndiaOrRemote } from '../common/location.util';
import { ageInDays } from '../common/date.util';
import { isEngineeringTitle, matchesTargetRole, toNumberOrNull } from './eligibility';
import type { NormalizedJob } from './normalize';

export const RETRIEVAL_WEIGHTS = {
  role: 25,
  skills: 35,
  experience: 20,
  location: 10,
  freshness: 5,
  source: 5,
} as const;

const GENERIC_ROLE_POINTS = 12;
const SKILLS_NEUTRAL = 14;
const SKILLS_MIN_DENOMINATOR = 4;
const EXPERIENCE_NEUTRAL = 12;
const EXPERIENCE_NEUTRAL_SENIOR = 8;
const EXPERIENCE_OVERQUALIFIED = 10;
const LOCATION_UNKNOWN = 5;
const FRESHNESS_UNKNOWN = 3;
const SOURCE_POINTS: Record<string, number> = { ats_api: 5, http_scrape: 4, firecrawl_scrape: 3 };
const SOURCE_DEFAULT = 3;
const SENIOR_MARKERS = ['senior', 'sr'];
const FRESHER_MARKERS = ['fresher', 'graduate', 'entry level', 'junior'];

export interface ScoringContext {
  profile: CvProfile;
  /** Canonical skill slugs from the candidate's cv_skills. */
  cvSkillNames: string[];
  now: Date;
}

export interface RetrievalSignals {
  role: number;
  skills: number;
  experience: number;
  location: number;
  freshness: number;
  source: number;
  requiredYearsMin: number | null;
  mentionedSkills: string[];
  matchedSkills: string[];
}

export interface RetrievalResult {
  score: number;
  signals: RetrievalSignals;
}

function rolePoints(job: NormalizedJob, profile: CvProfile): number {
  if (matchesTargetRole(job.title, profile.target_roles)) return RETRIEVAL_WEIGHTS.role;
  return isEngineeringTitle(job.title, profile.target_roles) ? GENERIC_ROLE_POINTS : 0;
}

function skillPoints(job: NormalizedJob, cvSkillNames: string[]): { points: number; matched: string[] } {
  if (job.mentionedSkills.length === 0) return { points: SKILLS_NEUTRAL, matched: [] };
  const cv = new Set(cvSkillNames);
  const matched = job.mentionedSkills.filter((skill) => cv.has(skill));
  const coverage = matched.length / Math.max(job.mentionedSkills.length, SKILLS_MIN_DENOMINATOR);
  return { points: Math.round(RETRIEVAL_WEIGHTS.skills * Math.min(1, coverage)), matched };
}

function experiencePoints(job: NormalizedJob, profile: CvProfile): number {
  const experience = toNumberOrNull(profile.experience_years);
  const required = job.requiredYearsMin;

  if (FRESHER_MARKERS.some((m) => containsWord(job.title, m)) && experience !== null && experience >= 2) {
    return EXPERIENCE_OVERQUALIFIED;
  }
  if (experience === null || required === null) {
    return SENIOR_MARKERS.some((m) => containsWord(job.title, m)) ? EXPERIENCE_NEUTRAL_SENIOR : EXPERIENCE_NEUTRAL;
  }
  if (required <= experience) return RETRIEVAL_WEIGHTS.experience;
  if (required <= experience + 1) return 15;
  if (required <= experience + 2) return 9;
  if (required <= experience + 3) return 4;
  return 0;
}

function locationPoints(job: NormalizedJob, profile: CvProfile): number {
  if (job.isRemote) return RETRIEVAL_WEIGHTS.location;
  if (job.location === null) return LOCATION_UNKNOWN;
  return isIndiaOrRemote(job.location, profile.preferred_locations) ? RETRIEVAL_WEIGHTS.location : 0;
}

function freshnessPoints(postedDateIso: string | null, now: Date): number {
  if (!postedDateIso) return FRESHNESS_UNKNOWN;
  const posted = new Date(postedDateIso);
  if (Number.isNaN(posted.getTime())) return FRESHNESS_UNKNOWN;
  const age = ageInDays(posted, now);
  if (age <= 3) return RETRIEVAL_WEIGHTS.freshness;
  if (age <= 7) return 4;
  if (age <= 14) return 2;
  return 0;
}

function sourcePoints(source: string): number {
  return SOURCE_POINTS[source] ?? SOURCE_DEFAULT;
}

/** Cheap, deterministic 0-100 fit score used to pick which jobs are worth a
 * Groq call. Not the final ranking (that is sub-project 4). */
export function scoreRetrieval(job: NormalizedJob, ctx: ScoringContext): RetrievalResult {
  const skills = skillPoints(job, ctx.cvSkillNames);
  const signals: RetrievalSignals = {
    role: rolePoints(job, ctx.profile),
    skills: skills.points,
    experience: experiencePoints(job, ctx.profile),
    location: locationPoints(job, ctx.profile),
    freshness: freshnessPoints(job.candidate.postedDateIso, ctx.now),
    source: sourcePoints(job.candidate.source),
    requiredYearsMin: job.requiredYearsMin,
    mentionedSkills: job.mentionedSkills,
    matchedSkills: skills.matched,
  };
  const score =
    signals.role + signals.skills + signals.experience + signals.location + signals.freshness + signals.source;
  return { score, signals };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx jest pipeline/retrieval-score.spec.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pipeline/retrieval-score.ts apps/api/src/pipeline/retrieval-score.spec.ts
git commit -m "feat(pipeline): cheap retrieval score with per-part breakdown"
```

---

## Task 5: Selection + `evaluateCandidates` + end-to-end composition test

**Files:**
- Create: `apps/api/src/pipeline/select.ts`
- Create: `apps/api/src/pipeline/evaluate.ts`
- Test: Create `apps/api/src/pipeline/select.spec.ts`, `apps/api/src/pipeline/pipeline.spec.ts`

**Interfaces:**
- Consumes: `normalizeCandidate`, `ScopedCandidate`, `NormalizedJob` (Task 2); `evaluateEligibility`, `RejectionReason` (Task 3); `scoreRetrieval`, `ScoringContext`, `RetrievalSignals` (Task 4)
- Produces:
  - `export interface Rankable { score: number; postedDateIso: string | null; title: string }`
  - `export function applyFloor<T extends { score: number }>(items: readonly T[], floor: number): T[]`
  - `export function orderByScore<T>(items: readonly T[], key: (item: T) => Rankable): T[]`
  - `export function selectTopN<T>(items: readonly T[], n: number, key: (item: T) => Rankable): T[]`
  - `export interface ScoredJob { job: NormalizedJob; score: number; signals: RetrievalSignals }`
  - `export interface EvaluationResult { accepted: ScoredJob[]; eligibleCount: number; belowFloorCount: number; rejectionReasons: Record<string, number> }`
  - `export function scoredJobRank(item: ScoredJob): Rankable`
  - `export function evaluateCandidates(scoped: readonly ScopedCandidate[], ctx: ScoringContext, floor: number): EvaluationResult`
  — consumed by Task 7

- [ ] **Step 1: Write the failing selection tests**

Create `apps/api/src/pipeline/select.spec.ts`:

```ts
import { applyFloor, orderByScore, selectTopN, type Rankable } from './select';

const key = (r: Rankable): Rankable => r;

describe('applyFloor', () => {
  it('keeps items at or above the floor', () => {
    const items = [{ score: 39 }, { score: 40 }, { score: 90 }];
    expect(applyFloor(items, 40)).toEqual([{ score: 40 }, { score: 90 }]);
  });
});

describe('orderByScore', () => {
  it('orders by score descending', () => {
    const items: Rankable[] = [
      { score: 50, postedDateIso: null, title: 'B' },
      { score: 90, postedDateIso: null, title: 'A' },
    ];
    expect(orderByScore(items, key).map((i) => i.score)).toEqual([90, 50]);
  });

  it('breaks score ties by fresher date, with missing dates last', () => {
    const items: Rankable[] = [
      { score: 70, postedDateIso: null, title: 'No date' },
      { score: 70, postedDateIso: '2026-09-01', title: 'Older' },
      { score: 70, postedDateIso: '2026-10-01', title: 'Newer' },
    ];
    expect(orderByScore(items, key).map((i) => i.title)).toEqual(['Newer', 'Older', 'No date']);
  });

  it('breaks remaining ties by title', () => {
    const items: Rankable[] = [
      { score: 70, postedDateIso: null, title: 'Zeta' },
      { score: 70, postedDateIso: null, title: 'Alpha' },
    ];
    expect(orderByScore(items, key).map((i) => i.title)).toEqual(['Alpha', 'Zeta']);
  });

  it('does not mutate the input', () => {
    const items: Rankable[] = [
      { score: 10, postedDateIso: null, title: 'A' },
      { score: 20, postedDateIso: null, title: 'B' },
    ];
    orderByScore(items, key);
    expect(items[0].score).toBe(10);
  });
});

describe('selectTopN', () => {
  it('returns the best N', () => {
    const items: Rankable[] = [10, 80, 50, 90].map((score) => ({ score, postedDateIso: null, title: String(score) }));
    expect(selectTopN(items, 2, key).map((i) => i.score)).toEqual([90, 80]);
  });

  it('returns an empty list for N <= 0', () => {
    expect(selectTopN([{ score: 1, postedDateIso: null, title: 'x' }], 0, key)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest pipeline/select.spec.ts`
Expected: FAIL — `./select` module does not exist.

- [ ] **Step 3: Implement `select.ts`**

Create `apps/api/src/pipeline/select.ts`:

```ts
/** What ordering needs to know about any scored item. */
export interface Rankable {
  score: number;
  postedDateIso: string | null;
  title: string;
}

export function applyFloor<T extends { score: number }>(items: readonly T[], floor: number): T[] {
  return items.filter((item) => item.score >= floor);
}

/** Best score first; ties go to the fresher posting (missing dates last),
 * then alphabetical title, so ordering is stable across runs. */
export function orderByScore<T>(items: readonly T[], key: (item: T) => Rankable): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (kb.score !== ka.score) return kb.score - ka.score;
    const da = ka.postedDateIso ?? '';
    const db = kb.postedDateIso ?? '';
    if (da !== db) return db.localeCompare(da);
    return ka.title.localeCompare(kb.title);
  });
}

export function selectTopN<T>(items: readonly T[], n: number, key: (item: T) => Rankable): T[] {
  return orderByScore(items, key).slice(0, Math.max(0, n));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest pipeline/select.spec.ts`
Expected: PASS

- [ ] **Step 5: Write the failing composition test**

Create `apps/api/src/pipeline/pipeline.spec.ts`. It runs the **real** normalize → eligibility → score → floor → order with no mocked stage:

```ts
import type { CvProfile } from '@jobportal/shared';
import { evaluateCandidates } from './evaluate';
import type { ScopedCandidate } from './normalize';
import type { ScoringContext } from './retrieval-score';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

const PROFILE: CvProfile = {
  id: 'p1',
  user_id: 'u1',
  raw_cv_text: null,
  experience_years: 2.2,
  current_title: null,
  updated_at: '2026-10-05T00:00:00Z',
  target_roles: ['backend', 'full stack', 'software engineer', 'software developer', 'node.js', 'nestjs', 'sde'],
  excluded_roles: ['sales engineer', 'qa engineer', 'frontend engineer'],
  excluded_departments: ['sales', 'marketing'],
  preferred_locations: ['india', 'bangalore', 'bengaluru', 'remote'],
  excluded_companies: [],
  seniority_min_years: null,
  seniority_max_years: null,
  work_modes: [],
  employment_types: [],
  domain_preferences: [],
  domain_exclusions: [],
};

const CTX: ScoringContext = {
  profile: PROFILE,
  cvSkillNames: ['nodejs', 'nestjs', 'postgresql', 'redis', 'kafka', 'aws', 'docker', 'typescript'],
  now: new Date('2026-10-05T12:00:00Z'),
};

function scoped(
  companyId: string,
  title: string,
  overrides: Partial<RawJobCandidate> = {},
): ScopedCandidate {
  return {
    candidate: {
      title,
      url: `https://${companyId}.example/jobs/${encodeURIComponent(title)}-${overrides.locationHint ?? 'x'}`,
      companyNameHint: companyId,
      locationHint: 'Bangalore, India',
      snippet: '',
      markdown: null,
      source: 'ats_api',
      postedDateIso: null,
      ...overrides,
    },
    companyId,
    companyName: companyId,
  };
}

const CANDIDATES: ScopedCandidate[] = [
  scoped('acme', 'Backend Engineer', {
    markdown: 'We need 3+ years of experience building APIs with Node.js, NestJS, PostgreSQL, Redis and Kafka.',
    postedDateIso: '2026-10-04',
  }),
  scoped('acme', 'Member of Technical Staff', {
    locationHint: 'Remote',
    markdown: '2+ years experience with Node.js and PostgreSQL.',
    source: 'http_scrape',
  }),
  scoped('acme', 'Platform Engineer', {
    markdown: 'Own our Kubernetes and Terraform stack on AWS. 3+ years experience required.',
  }),
  scoped('acme', 'Staff Backend Engineer'),
  scoped('acme', 'Life at Acme', { locationHint: null, markdown: 'We love our people and our culture.', source: 'http_scrape' }),
  scoped('acme', 'Backend Engineer SF', { locationHint: 'San Francisco, CA' }),
  scoped('acme', 'Backend Engineer Senior Track', { markdown: '7+ years of experience with Node.js' }),
  scoped('beta', 'Backend Engineer', {
    locationHint: 'Pune, India',
    markdown: 'Node.js and PostgreSQL.',
    source: 'http_scrape',
    postedDateIso: '2026-09-30',
  }),
  scoped('beta', 'Backend Engineer', {
    locationHint: 'Bangalore, India',
    markdown: 'Node.js and PostgreSQL.',
    source: 'http_scrape',
    postedDateIso: '2026-09-30',
  }),
  scoped('gamma', 'Engineer, Payments', {
    locationHint: null,
    markdown: '5+ years experience with Java, Spring Boot and Oracle.',
    source: 'firecrawl_scrape',
    postedDateIso: '2026-08-01',
  }),
];

describe('evaluateCandidates (composition, no mocked stage)', () => {
  const result = evaluateCandidates(CANDIDATES, CTX, 40);

  it('rejects exactly the clearly-impossible candidates, with reasons', () => {
    expect(result.rejectionReasons).toEqual({
      leadership_or_intern: 1,
      non_engineering_title: 1,
      location_mismatch: 1,
      experience_too_high: 1,
    });
    expect(result.eligibleCount).toBe(6);
  });

  it('drops the weak eligible job below the floor', () => {
    expect(result.belowFloorCount).toBe(1);
    expect(result.accepted.map((s) => s.job.title)).not.toContain('Engineer, Payments');
  });

  it('keeps borderline roles (MTS, Platform Engineer) for scoring', () => {
    const titles = result.accepted.map((s) => s.job.title);
    expect(titles).toContain('Member of Technical Staff');
    expect(titles).toContain('Platform Engineer');
  });

  it('keeps the same title at the same company in two cities', () => {
    const beta = result.accepted.filter((s) => s.job.companyId === 'beta').map((s) => s.job.location);
    expect(beta).toEqual(['Pune, India', 'Bangalore, India']);
  });

  it('orders accepted jobs best-first with the expected scores', () => {
    expect(result.accepted.map((s) => [s.job.companyId, s.job.title, s.score])).toEqual([
      ['acme', 'Backend Engineer', 95],
      ['beta', 'Backend Engineer', 73],
      ['beta', 'Backend Engineer', 73],
      ['acme', 'Member of Technical Staff', 67],
      ['acme', 'Platform Engineer', 54],
    ]);
  });
});
```

Score derivations (for the implementer's and reviewer's reference — derive, don't trust): acme Backend Engineer = role 25 + skills 35 (5/5 mentioned on CV) + experience 15 (3 ≤ 3.2) + location 10 + freshness 5 (1 day) + source 5 = 95. beta Backend Engineer = 25 + 18 (2/4) + 12 (no years) + 10 + 4 (5 days) + 4 = 73. MTS = 12 + 18 + 20 (2 ≤ 2.2) + 10 (remote) + 3 + 4 = 67. Platform Engineer = 12 + 9 (aws 1/4) + 15 + 10 + 3 + 5 = 54. Engineer, Payments = 12 + 0 + 4 (5 ≤ 5.2) + 5 + 0 + 3 = 24.

- [ ] **Step 6: Run to verify it fails**

Run: `cd apps/api && npx jest pipeline/pipeline.spec.ts`
Expected: FAIL — `./evaluate` module does not exist.

- [ ] **Step 7: Implement `evaluate.ts`**

Create `apps/api/src/pipeline/evaluate.ts`:

```ts
import { evaluateEligibility } from './eligibility';
import { normalizeCandidate, type NormalizedJob, type ScopedCandidate } from './normalize';
import { scoreRetrieval, type RetrievalSignals, type ScoringContext } from './retrieval-score';
import { applyFloor, orderByScore, type Rankable } from './select';

export interface ScoredJob {
  job: NormalizedJob;
  score: number;
  signals: RetrievalSignals;
}

export interface EvaluationResult {
  /** Eligible, at or above the floor, best-first. */
  accepted: ScoredJob[];
  eligibleCount: number;
  belowFloorCount: number;
  /** Rejection reason code -> count, for the run summary. */
  rejectionReasons: Record<string, number>;
}

export function scoredJobRank(item: ScoredJob): Rankable {
  return { score: item.score, postedDateIso: item.job.candidate.postedDateIso, title: item.job.title };
}

/** normalize -> eligibility -> score -> floor -> order, over one run's candidates. */
export function evaluateCandidates(
  scoped: readonly ScopedCandidate[],
  ctx: ScoringContext,
  floor: number,
): EvaluationResult {
  const rejectionReasons: Record<string, number> = {};
  const scored: ScoredJob[] = [];

  for (const item of scoped) {
    const job = normalizeCandidate(item);
    const eligibility = evaluateEligibility(job, ctx.profile);
    if (!eligibility.eligible) {
      rejectionReasons[eligibility.reason] = (rejectionReasons[eligibility.reason] ?? 0) + 1;
      continue;
    }
    const { score, signals } = scoreRetrieval(job, ctx);
    scored.push({ job, score, signals });
  }

  const aboveFloor = applyFloor(scored, floor);
  return {
    accepted: orderByScore(aboveFloor, scoredJobRank),
    eligibleCount: scored.length,
    belowFloorCount: scored.length - aboveFloor.length,
    rejectionReasons,
  };
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `cd apps/api && npx jest pipeline/`
Expected: PASS — all pipeline suites (normalize, eligibility, retrieval-score, select, pipeline). If a composition score differs from the table, re-derive it by hand from the spec §9 rules before changing either the test or the code; record which was wrong in the report.

- [ ] **Step 9: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/pipeline/select.ts apps/api/src/pipeline/select.spec.ts apps/api/src/pipeline/evaluate.ts apps/api/src/pipeline/pipeline.spec.ts
git commit -m "feat(pipeline): floor/Top-N selection and evaluateCandidates, with an end-to-end composition test"
```

---

## Task 6: Migration 0008, config, and `DEFAULT_CV` trim

**Files:**
- Create: `db/migrations/0008_processing_pipeline.sql`
- Modify: `apps/api/src/config/configuration.ts`
- Modify: `apps/api/src/cv/default-cv.ts` (`DEFAULT_EXCLUDED_ROLES`)
- Test: Create `apps/api/src/cv/default-cv.spec.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: DB columns `job_postings.external_id`, `retrieval_score`, `retrieval_signals`, `location_normalized`; view columns `external_id`, `retrieval_score`, `retrieval_signals` on `job_postings_enriched`; config `ingest.retrievalFloor`, `ingest.analysisBacklogDays` — consumed by Task 7

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/cv/default-cv.spec.ts`:

```ts
import { DEFAULT_CV } from './default-cv';

const ADJACENT_ROLES = [
  'platform engineer',
  'devops engineer',
  'site reliability',
  'data engineer',
  'security engineer',
  'solutions engineer',
  'ml engineer',
  'machine learning engineer',
  'ai engineer',
];

describe('DEFAULT_CV.excludedRoles', () => {
  it('no longer hard-rejects adjacent engineering roles', () => {
    for (const role of ADJACENT_ROLES) {
      expect(DEFAULT_CV.excludedRoles).not.toContain(role);
    }
  });

  it('still hard-rejects clearly off-target roles', () => {
    expect(DEFAULT_CV.excludedRoles).toEqual(
      expect.arrayContaining(['sales engineer', 'qa engineer', 'frontend engineer', 'ios', 'android']),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx jest cv/default-cv.spec.ts`
Expected: FAIL — `DEFAULT_CV.excludedRoles` still contains `platform engineer` (and the other eight).

- [ ] **Step 3: Trim `DEFAULT_EXCLUDED_ROLES`**

In `apps/api/src/cv/default-cv.ts`, replace the whole `DEFAULT_EXCLUDED_ROLES` array literal with:

```ts
/** Seeded from the old OFF_TARGET_TITLE_MARKERS constant in text.util.ts,
 * minus the adjacent engineering roles (platform/devops/SRE/data/security/
 * solutions/ML/AI) — those now reach the retrieval score and rank lower
 * instead of being hard-rejected (processing-pipeline spec §3). */
const DEFAULT_EXCLUDED_ROLES = [
  'sales engineer', 'support engineer', 'field engineer',
  'hardware engineer', 'mechanical engineer', 'electrical engineer',
  'civil engineer', 'network engineer', 'qa engineer', 'test engineer',
  'ios engineer', 'android engineer', 'mobile engineer',
  'frontend engineer', 'front-end engineer', 'front end engineer',
  'embedded engineer',
  'ios', 'android', 'react native', 'flutter',
];
```

(Replace the existing doc comment above it too — keep exactly one doc comment.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx jest cv/default-cv.spec.ts`
Expected: PASS

- [ ] **Step 5: Add config values**

In `apps/api/src/config/configuration.ts`, add to the `ingest: { ... }` block of the `AppConfig` interface:

```ts
    /** Minimum retrieval score (0-100) for an eligible job to be saved. */
    retrievalFloor: number;
    /** How far back saved-but-unanalyzed jobs compete for Groq slots. */
    analysisBacklogDays: number;
```

and to the `ingest: { ... }` block of the exported default config object:

```ts
    retrievalFloor: int('INGEST_RETRIEVAL_FLOOR', 40),
    analysisBacklogDays: int('INGEST_ANALYSIS_BACKLOG_DAYS', 30),
```

- [ ] **Step 6: Write the migration**

Create `db/migrations/0008_processing_pipeline.sql`:

```sql
-- ===========================================================================
-- 0008_processing_pipeline.sql — retrieval score, ATS job IDs, location-aware
-- dedup, and the excluded_roles trim. See
-- docs/superpowers/specs/2026-10-05-processing-pipeline-design.md §12.
--
-- Idempotent. Apply in the Supabase SQL Editor BEFORE deploying the code that
-- writes retrieval_score/external_id (Render auto-deploys main).
-- ===========================================================================

alter table public.job_postings
  add column if not exists external_id text,
  add column if not exists retrieval_score integer check (retrieval_score between 0 and 100),
  add column if not exists retrieval_signals jsonb,
  add column if not exists location_normalized text generated always as (lower(btrim(location))) stored;

-- The old key merged "Backend Engineer — Bangalore" and "— Pune" into one
-- row. The replacement is strictly finer, so every existing row stays unique.
drop index if exists public.job_postings_user_company_title_key;
create unique index if not exists job_postings_user_company_title_location_key
  on public.job_postings (user_id, company_id, title_normalized, coalesce(location_normalized, ''))
  where company_id is not null;

create unique index if not exists job_postings_user_company_external_id_key
  on public.job_postings (user_id, company_id, external_id)
  where external_id is not null and company_id is not null;

create index if not exists job_postings_retrieval_score_idx
  on public.job_postings (user_id, retrieval_score desc);

-- Adjacent engineering roles now reach scoring instead of being hard-rejected.
update public.cv_profile
set excluded_roles = coalesce((
  select jsonb_agg(r)
  from jsonb_array_elements_text(excluded_roles) as r
  where r not in ('platform engineer', 'devops engineer', 'site reliability',
                  'data engineer', 'security engineer', 'solutions engineer',
                  'ml engineer', 'machine learning engineer', 'ai engineer')
), '[]'::jsonb);

-- Postgres only allows appending columns to a view, so the three new ones go last.
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
  j.retrieval_signals
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

Before saving, open `db/migrations/0001_schema.sql` and confirm the view's existing column list above (everything before `j.external_id`) matches it exactly, column for column and in order — `create or replace view` fails if an existing column is renamed, reordered or removed. If any later migration (`0002`–`0007`) redefined the view, match that latest definition instead.

- [ ] **Step 7: Typecheck and full suite**

Run: `cd apps/api && npm run typecheck && npm test`
Expected: typecheck clean; all suites pass.

- [ ] **Step 8: Commit**

```bash
git add db/migrations/0008_processing_pipeline.sql apps/api/src/config/configuration.ts apps/api/src/cv/default-cv.ts apps/api/src/cv/default-cv.spec.ts
git commit -m "feat(db): migration 0008 for retrieval score, ATS ids, location-aware dedup; trim adjacent excluded roles"
```

Do **not** apply the migration. Note in the report that it must be applied before deploy.

---

## Task 7: Wire the pipeline into `IngestService`

**Files:**
- Modify: `apps/api/src/ingest/ingest.service.ts`
- Modify: `packages/shared/src/types.ts` (`IngestRunSummary`)
- Modify: `apps/api/src/common/text.util.ts` (remove `looksLikeRelevantRole`)
- Test: Modify `apps/api/src/ingest/ingest.service.spec.ts`, `apps/api/src/common/text.util.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6; `AtsJobListing` from `../discovery/ats-clients`
- Produces: `run()` executes the full pipeline. New exports from `ingest.service.ts`: `InsertedJob` (now exported), `atsListingToCandidate`, `dedupWithinRun`, `BacklogRow`, `AnalysisCandidate`, `toAnalysisCandidates`.

- [ ] **Step 1: Extend `IngestRunSummary` and rebuild shared**

In `packages/shared/src/types.ts`, inside `export interface IngestRunSummary`, after `candidates_found: number;`, add:

```ts
  /** Candidates that passed eligibility (before the score floor). */
  candidates_eligible: number;
  /** Eligible candidates dropped for scoring below the floor. */
  candidates_below_floor: number;
  /** Eligibility rejection reason code -> count. */
  rejection_reasons: Record<string, number>;
  /** Saved-but-unanalyzed jobs considered for this run's Groq Top-N. */
  analysis_pool_size: number;
```

Run: `cd packages/shared && npm run build`
Expected: no errors. (`apps/api` will not typecheck until Step 6 — expected.)

- [ ] **Step 2: Write the failing tests**

In `apps/api/src/ingest/ingest.service.spec.ts`:

Replace the import block at the top with:

```ts
import {
  atsListingToCandidate,
  dedupWithinRun,
  describeEmptyProfileWarning,
  describeInsertError,
  filterOutExcludedCompanies,
  filterStalePostings,
  IngestService,
  isExcludedCompany,
  shouldFallBackToFirecrawl,
  toAnalysisCandidates,
  type BacklogRow,
} from './ingest.service';
import type { CvProfile } from '@jobportal/shared';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';
import { toDateOnlyIso } from '../common/date.util';
import { normalizeCandidate } from '../pipeline/normalize';
import type { ScoredJob } from '../pipeline/evaluate';
import type { ScoringContext } from '../pipeline/retrieval-score';
```

After the existing `candidate()` helper, add:

```ts
function scoredJob(overrides: Partial<RawJobCandidate> = {}, score = 80, companyId = 'company-1'): ScoredJob {
  return {
    job: normalizeCandidate({ candidate: candidate(overrides), companyId, companyName: 'Acme' }),
    score,
    signals: {
      role: 25,
      skills: 20,
      experience: 12,
      location: 10,
      freshness: 3,
      source: 4,
      requiredYearsMin: null,
      mentionedSkills: [],
      matchedSkills: [],
    },
  };
}

const SCORING_CTX: ScoringContext = {
  profile: {
    id: 'p1',
    user_id: 'u1',
    raw_cv_text: null,
    experience_years: 2.2,
    current_title: null,
    updated_at: '2026-10-05T00:00:00Z',
    target_roles: ['backend'],
    excluded_roles: [],
    excluded_departments: [],
    preferred_locations: ['india', 'remote'],
    excluded_companies: [],
    seniority_min_years: null,
    seniority_max_years: null,
    work_modes: [],
    employment_types: [],
    domain_preferences: [],
    domain_exclusions: [],
  } as CvProfile,
  cvSkillNames: ['nodejs'],
  now: new Date('2026-10-05T12:00:00Z'),
};
```

In the existing `describe('IngestService.insertOne DB-error visibility (I3/Fix 4)', ...)` block, replace both `const scoped = [ { candidate: ..., companyId: 'company-1', companyName: 'Acme' } ];` literals with:

```ts
    const scoped = [scoredJob({ title: 'Backend Engineer', url: 'https://acme.com/careers/1' })];
```

(The two `dedupAndInsert('user-1', scoped, 100, errors)` calls stay as they are.)

Append these new blocks at the end of the file:

```ts
describe('IngestService.dedupAndInsert ordering and payload', () => {
  function buildServiceRecordingUpserts() {
    const upserts: Array<Record<string, unknown>> = [];
    let counter = 0;
    const fromResult = {
      upsert: (payload: Record<string, unknown>) => {
        upserts.push(payload);
        counter += 1;
        const id = `job-${counter}`;
        const chain = {
          select: () => chain,
          maybeSingle: async () => ({ data: { id }, error: null }),
        };
        return chain;
      },
      select: () => fromResult,
      eq: () => fromResult,
      in: async () => ({ data: [], error: null }),
    };
    const supabase = {
      admin: { from: () => fromResult },
      unwrap: (result: { data: unknown; error: unknown }) => result.data ?? [],
    };
    const service = new IngestService(
      supabase as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { get: (_key: string, fallback?: unknown) => fallback } as any,
      {} as any,
    );
    return { service, upserts };
  }

  it('keeps the highest-scoring jobs when more pass than maxNewJobsPerRun', async () => {
    const { service, upserts } = buildServiceRecordingUpserts();
    const ordered = [
      scoredJob({ url: 'https://acme.com/careers/1' }, 90),
      scoredJob({ url: 'https://acme.com/careers/2' }, 80),
      scoredJob({ url: 'https://acme.com/careers/3' }, 70),
    ];

    const result = await (service as any).dedupAndInsert('user-1', ordered, 2, []);

    expect(result.inserted).toHaveLength(2);
    expect(upserts.map((p) => p.url)).toEqual(['https://acme.com/careers/1', 'https://acme.com/careers/2']);
    expect(upserts[0].retrieval_score).toBe(90);
  });

  it('writes external_id and retrieval_signals', async () => {
    const { service, upserts } = buildServiceRecordingUpserts();

    await (service as any).dedupAndInsert('user-1', [scoredJob({ externalId: 'gh-42' }, 77)], 100, []);

    expect(upserts[0].external_id).toBe('gh-42');
    expect(upserts[0].retrieval_signals).toEqual(expect.objectContaining({ role: 25 }));
  });
});

describe('dedupWithinRun', () => {
  it('keeps the first of two candidates with the same URL', () => {
    const kept = dedupWithinRun([
      scoredJob({ url: 'https://acme.com/careers/1' }, 90),
      scoredJob({ url: 'https://acme.com/careers/1?utm_source=x' }, 60),
    ]);
    expect(kept.map((s) => s.score)).toEqual([90]);
  });

  it('keeps the first of two candidates with the same company and ATS id', () => {
    const kept = dedupWithinRun([
      scoredJob({ url: 'https://acme.com/a', externalId: '7' }, 90),
      scoredJob({ url: 'https://acme.com/b', externalId: '7' }, 60),
    ]);
    expect(kept).toHaveLength(1);
  });

  it('keeps the same title in two cities', () => {
    const kept = dedupWithinRun([
      scoredJob({ url: 'https://acme.com/be-pune', locationHint: 'Pune, India' }, 80),
      scoredJob({ url: 'https://acme.com/be-blr', locationHint: 'Bangalore, India' }, 80),
    ]);
    expect(kept).toHaveLength(2);
  });
});

describe('toAnalysisCandidates', () => {
  function row(overrides: Partial<BacklogRow> = {}): BacklogRow {
    return {
      id: 'row-1',
      company_id: 'company-1',
      title: 'Backend Engineer',
      company_name: 'Acme',
      location: 'Bangalore, India',
      url: 'https://acme.com/careers/1',
      description_raw: 'Node.js services',
      posted_date: '2026-10-03',
      source: 'ats_api',
      retrieval_score: 77,
      ...overrides,
    };
  }

  it('uses a stored retrieval score without rescoring', () => {
    const { candidates, rescored } = toAnalysisCandidates([row()], SCORING_CTX);
    expect(candidates[0].score).toBe(77);
    expect(rescored).toEqual([]);
  });

  it('scores a pre-migration row with no stored score and no description', () => {
    const { candidates, rescored } = toAnalysisCandidates(
      [row({ id: 'old', retrieval_score: null, description_raw: null })],
      SCORING_CTX,
    );
    expect(rescored).toHaveLength(1);
    expect(rescored[0].id).toBe('old');
    expect(typeof candidates[0].score).toBe('number');
    expect(candidates[0].job.description).toBe('');
  });
});

describe('atsListingToCandidate', () => {
  it('carries the ATS id and department onto the candidate', () => {
    const c = atsListingToCandidate(
      {
        title: 'Backend Engineer',
        url: 'https://boards.greenhouse.io/acme/jobs/1',
        location: 'Bangalore',
        postedDateIso: '2026-10-01',
        department: 'Engineering',
        description: 'desc',
        externalId: '1',
      },
      'Acme',
    );
    expect(c.externalId).toBe('1');
    expect(c.department).toBe('Engineering');
    expect(c.source).toBe('ats_api');
    expect(c.companyNameHint).toBe('Acme');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/api && npx jest ingest/ingest.service.spec.ts`
Expected: FAIL — the new exports (`atsListingToCandidate`, `dedupWithinRun`, `toAnalysisCandidates`, `BacklogRow`) do not exist.

- [ ] **Step 4: Remove `looksLikeRelevantRole`**

In `apps/api/src/common/text.util.ts`, delete the `looksLikeRelevantRole` function and its doc comment entirely (keep `containsWord` and `escapeRegex`). In `apps/api/src/common/text.util.spec.ts`, change the import to `import { containsWord } from './text.util';` and delete the `TARGET_ROLES`, `EXCLUDED_ROLES`, `EXCLUDED_DEPARTMENTS` constants and the whole `describe('looksLikeRelevantRole', ...)` block. Keep the `describe('containsWord', ...)` block from Task 1.

- [ ] **Step 5: Rewire `ingest.service.ts`**

Read the current file first; the edits below assume the structure on `main` after sub-project 2 (verified when this plan was written). If anything differs, preserve the intent described here.

**5a. Imports.** Replace lines 15–21 (from the `url.util` import through the `scrapeCareerPage` import) with:

```ts
import { canonicalizeUrl, companyNameFromHost, hostnameOf, isNonCompanyHost } from '../common/url.util';
import { companyFromTitle, guessSeniority } from '../common/text.util';
import { ageInDays } from '../common/date.util';
import { mapWithConcurrency } from '../common/async.util';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';
import type { AtsJobListing } from '../discovery/ats-clients';
import { scrapeCareerPage } from '../scraping/career-page-scraper';
import { evaluateEligibility } from '../pipeline/eligibility';
import { normalizeCandidate, type ScopedCandidate } from '../pipeline/normalize';
import { scoreRetrieval, type RetrievalSignals, type ScoringContext } from '../pipeline/retrieval-score';
import { evaluateCandidates, type ScoredJob } from '../pipeline/evaluate';
import { selectTopN } from '../pipeline/select';
```

**5b. Types.** Replace the `interface InsertedJob` and `interface CompanyScopedCandidate` declarations with:

```ts
export interface InsertedJob {
  id: string;
  title: string;
  companyName: string | null;
  location: string | null;
  description: string;
}

const ANALYSIS_POOL_QUERY_LIMIT = 200;
/** Same bar analyzeAndPersist() already applies before calling Groq. */
const MIN_ANALYZABLE_DESCRIPTION = 40;
```

Then replace every remaining `CompanyScopedCandidate` in the file with `ScopedCandidate`. In `analyzeAndPersist()`, replace the literal `40` in `job.description.trim().length < 40` with `MIN_ANALYZABLE_DESCRIPTION` so the two checks can't drift.

**5c. `run()`.** Replace from `const { profile } = await this.cv.getSnapshot(userId);` through the end of the `if (this.analysis.isConfigured && toAnalyze.length > 0) { ... } else if (...) { ... }` block with:

```ts
      const { profile, skills } = await this.cv.getSnapshot(userId);
      const emptyProfileWarning = describeEmptyProfileWarning(profile);
      if (emptyProfileWarning) {
        this.logger.warn(`[${runId}] ${emptyProfileWarning}`);
        errors.push(emptyProfileWarning);
      }
      const scoringContext: ScoringContext = {
        profile,
        cvSkillNames: skills.map((skill) => skill.name),
        now: startedAt,
      };

      const discovery = await this.discoverCompanies(userId, errors, profile);
      this.logActivity(
        userId,
        `Discovery done — ${discovery.resolved} resolved, ${discovery.failed} failed`,
      );

      const { candidates, companiesScraped } = await this.scrapeResolvedCompanies(userId, errors, profile);

      const floor = this.config.get<number>('ingest.retrievalFloor', 40);
      const evaluation = evaluateCandidates(candidates, scoringContext, floor);
      this.logActivity(
        userId,
        `Evaluated ${candidates.length} candidate(s): ${evaluation.eligibleCount} eligible, ` +
          `${evaluation.belowFloorCount} below the score floor, ${evaluation.accepted.length} kept`,
      );

      const maxNew = this.config.get<number>('ingest.maxNewJobsPerRun', 100);
      const { inserted, duplicates } = await this.dedupAndInsert(userId, evaluation.accepted, maxNew, errors);
      this.logActivity(
        userId,
        `Inserted ${inserted.length} new job(s), skipped ${duplicates} duplicate(s)`,
      );

      // Inserted rows are already visible to GET /api/jobs at this point —
      // publish the count now so a polling dashboard can show them before
      // analysis (the slowest remaining phase) finishes.
      this.updateStatus(userId, { jobs_inserted_so_far: inserted.length });

      const maxAnalyses = this.config.get<number>('ingest.maxAnalysesPerRun', 40);
      const concurrency = this.config.get<number>('ingest.analysisConcurrency', 1);
      const { toAnalyze, poolSize } = await this.buildAnalysisPool(userId, scoringContext, maxAnalyses);

      let analyzed = 0;
      if (this.analysis.isConfigured && toAnalyze.length > 0) {
        this.logActivity(userId, `Scoring the top ${toAnalyze.length} of ${poolSize} unanalyzed job(s) against your CV…`);
        await mapWithConcurrency(toAnalyze, concurrency, async (job) => {
          try {
            const ok = await this.analyzeAndPersist(userId, job);
            if (ok) {
              analyzed++;
              this.logActivity(userId, `Scored "${job.title}"${job.companyName ? ` at ${job.companyName}` : ''}`);
            }
          } catch (error) {
            errors.push(`Analysis failed for "${job.title}": ${describeError(error)}`);
          }
        });
      } else if (!this.analysis.isConfigured) {
        errors.push('GROQ_API_KEY not set — skill-gap scoring skipped');
      }
```

In the `summary: IngestRunSummary = { ... }` literal, after `candidates_found: candidates.length,` add:

```ts
        candidates_eligible: evaluation.eligibleCount,
        candidates_below_floor: evaluation.belowFloorCount,
        rejection_reasons: evaluation.rejectionReasons,
        analysis_pool_size: poolSize,
```

**5d. `scrapeResolvedCompanies()`.** Change `? await this.scrapeAtsCompany(company, profile)` to `? await this.scrapeAtsCompany(company)`.

**5e. `scrapeAtsCompany()`.** Replace the whole method with:

```ts
  private async scrapeAtsCompany(company: Company): Promise<RawJobCandidate[]> {
    const listings = await fetchAtsJobs(company.ats_type!, company.ats_board_token!);

    // No freshness filter here, deliberately: an ATS board only ever lists
    // currently-open reqs (Greenhouse/Lever/Ashby drop filled/closed postings
    // from this endpoint), so every listing is "fresh" by construction. The
    // per-listing `postedDateIso` reflects when the listing was last edited,
    // not how long it's been open.
    //
    // No relevance/location filter either: eligibility is applied once,
    // uniformly, in run() via evaluateCandidates().
    return listings.map((listing) => atsListingToCandidate(listing, company.name));
  }
```

**5f. `scrapeCustomCareerPage()`.** Replace the whole method with:

```ts
  private async scrapeCustomCareerPage(company: Company, profile: CvProfile): Promise<RawJobCandidate[]> {
    if (!company.careers_url) return [];

    const local = await scrapeCareerPage(company.careers_url, {
      timeoutMs: this.config.get<number>('scraping.httpTimeoutMs', 30_000),
      maxLinks: this.config.get<number>('scraping.maxLinksPerCompany', 15),
      concurrency: this.config.get<number>('scraping.concurrency', 5),
    });

    // Freshness: discoverCompanyJobs (Firecrawl path, below) already rejects
    // postings older than maxPostingAgeDays. The local scraper doesn't get
    // that for free, so it's applied explicitly here.
    const fresh = filterStalePostings(local, this.config.get<number>('ingest.maxPostingAgeDays', 2));

    // Fall back to Firecrawl unless at least one local result is CREDIBLE —
    // passes the same eligibility check run() applies to everything. The
    // local extractors can turn a careers page's own nav ("Life at Acme")
    // into a non-empty candidate; eligibility's non_engineering_title check
    // rejects those, so they never block the fallback.
    const credible = fresh.filter(
      (candidate) =>
        evaluateEligibility(normalizeCandidate({ candidate, companyId: company.id, companyName: company.name }), profile)
          .eligible,
    );

    if (shouldFallBackToFirecrawl(credible)) {
      return this.firecrawl.discoverCompanyJobs(company.careers_url);
    }
    return fresh;
  }
```

**5g. `dedupAndInsert()` and `insertOne()`.** Replace both methods with:

```ts
  private async dedupAndInsert(
    userId: string,
    scored: ScoredJob[],
    maxNew: number,
    errors: string[],
  ): Promise<{ inserted: InsertedJob[]; duplicates: number }> {
    if (scored.length === 0) return { inserted: [], duplicates: 0 };

    // `scored` arrives best-first, so keeping the first occurrence keeps the
    // highest-scoring copy, and the maxNew cap keeps the highest-scoring jobs.
    const unique = dedupWithinRun(scored);

    const existingResult = await this.supabase.admin
      .from('job_postings')
      .select('url_hash')
      .eq('user_id', userId)
      .in(
        'url_hash',
        unique.map((item) => item.job.urlHash),
      );
    const existing = this.supabase.unwrap(existingResult, 'check existing postings') as Array<{
      url_hash: string;
    }>;
    const existingHashes = new Set(existing.map((row) => row.url_hash));

    const notInDb = unique.filter((item) => !existingHashes.has(item.job.urlHash));
    const toInsert = notInDb.slice(0, maxNew);

    const inserted: InsertedJob[] = [];
    for (const item of toInsert) {
      const row = await this.insertOne(userId, item, errors);
      if (row) inserted.push(row);
    }

    // Duplicates = repeats within this run + jobs already saved. Jobs past
    // the maxNew cap are not duplicates; they are reconsidered next run.
    return { inserted, duplicates: scored.length - notInDb.length };
  }

  private async insertOne(userId: string, item: ScoredJob, errors: string[]): Promise<InsertedJob | null> {
    const { job, score, signals } = item;

    const result = await this.supabase.admin
      .from('job_postings')
      .upsert(
        {
          user_id: userId,
          company_id: job.companyId,
          title: job.title,
          company_name: job.companyName,
          location: job.location,
          url: canonicalizeUrl(job.candidate.url),
          url_hash: job.urlHash,
          description_raw: job.description || null,
          seniority_guess: guessSeniority(job.title, job.description),
          posted_date: job.candidate.postedDateIso,
          source: job.candidate.source,
          status: 'new',
          external_id: job.externalId,
          retrieval_score: score,
          retrieval_signals: signals,
        },
        // onConflict covers the url_hash key only. A collision on the
        // (company, title, location) or (company, external_id) unique index
        // surfaces as a 23505, swallowed below as a benign duplicate.
        { onConflict: 'user_id,url_hash' },
      )
      .select('id')
      .maybeSingle();

    if (result.error) {
      if ((result.error as { code?: string }).code === '23505') return null;
      const message = describeInsertError(job.title, result.error);
      this.logger.warn(message);
      // Any OTHER DB error (e.g. a migration not yet applied to the live
      // database) would otherwise fail silently from the user's point of
      // view. Push it into the run's errors[] too.
      errors.push(message);
      return null;
    }
    if (!result.data) return null;

    return {
      id: result.data.id as string,
      title: job.title,
      companyName: job.companyName,
      location: job.location,
      description: job.description,
    };
  }

  /**
   * Groq's Top-N comes from every saved-but-unanalyzed job in the backlog
   * window — this run's inserts included — ranked by retrieval score. Rows
   * saved before migration 0008 have no score; they are scored from their
   * stored fields here and the score is written back.
   */
  private async buildAnalysisPool(
    userId: string,
    ctx: ScoringContext,
    limit: number,
  ): Promise<{ toAnalyze: InsertedJob[]; poolSize: number }> {
    const backlogDays = this.config.get<number>('ingest.analysisBacklogDays', 30);
    const since = new Date(ctx.now.getTime() - backlogDays * 24 * 60 * 60 * 1000).toISOString();

    const result = await this.supabase.admin
      .from('job_postings_enriched')
      .select('id, company_id, title, company_name, location, url, description_raw, posted_date, source, retrieval_score')
      .eq('user_id', userId)
      .is('match_score', null)
      .eq('status', 'new')
      .gte('scraped_at', since)
      .order('retrieval_score', { ascending: false, nullsFirst: false })
      .limit(ANALYSIS_POOL_QUERY_LIMIT);
    const rows = this.supabase.unwrap(result, 'load analysis backlog') as BacklogRow[];

    const { candidates, rescored } = toAnalysisCandidates(rows, ctx);
    for (const update of rescored) {
      const { error } = await this.supabase.admin
        .from('job_postings')
        .update({ retrieval_score: update.score, retrieval_signals: update.signals })
        .eq('id', update.id);
      if (error) this.logger.warn(`Could not store retrieval score for job ${update.id}: ${error.message}`);
    }

    // analyzeAndPersist() skips descriptions under 40 chars; leaving them in
    // the pool would let a high-scoring but unanalyzable job hold a Groq slot
    // every run without ever being analyzed.
    const analyzable = candidates.filter((c) => c.job.description.trim().length >= MIN_ANALYZABLE_DESCRIPTION);
    const top = selectTopN(analyzable, limit, (c) => ({
      score: c.score,
      postedDateIso: c.postedDateIso,
      title: c.job.title,
    }));
    return { toAnalyze: top.map((c) => c.job), poolSize: rows.length };
  }
```

**5h. New exported helpers.** Add these near the other exported helpers at the bottom of the file:

```ts
/** ATS listing -> scraped candidate. Eligibility is applied later, in run(). */
export function atsListingToCandidate(listing: AtsJobListing, companyName: string): RawJobCandidate {
  return {
    title: listing.title,
    url: listing.url,
    companyNameHint: companyName,
    locationHint: listing.location,
    snippet: (listing.description ?? '').slice(0, 2000),
    markdown: listing.description,
    source: 'ats_api',
    postedDateIso: listing.postedDateIso,
    externalId: listing.externalId,
    department: listing.department,
  };
}

/** Keeps the first occurrence by URL hash and by company + ATS id. Callers
 * pass best-first input, so the first occurrence is the best-scoring one. */
export function dedupWithinRun(scored: readonly ScoredJob[]): ScoredJob[] {
  const seenHashes = new Set<string>();
  const seenExternal = new Set<string>();
  const kept: ScoredJob[] = [];
  for (const item of scored) {
    const externalKey = item.job.externalId ? `${item.job.companyId}:${item.job.externalId}` : null;
    if (seenHashes.has(item.job.urlHash)) continue;
    if (externalKey && seenExternal.has(externalKey)) continue;
    seenHashes.add(item.job.urlHash);
    if (externalKey) seenExternal.add(externalKey);
    kept.push(item);
  }
  return kept;
}

/** A saved, not-yet-analyzed job as read from job_postings_enriched. */
export interface BacklogRow {
  id: string;
  company_id: string | null;
  title: string;
  company_name: string | null;
  location: string | null;
  url: string;
  description_raw: string | null;
  posted_date: string | null;
  source: string;
  retrieval_score: number | null;
}

export interface AnalysisCandidate {
  job: InsertedJob;
  score: number;
  postedDateIso: string | null;
}

/** Backlog rows -> analysis candidates, scoring rows that predate the
 * retrieval score from their stored fields. */
export function toAnalysisCandidates(
  rows: readonly BacklogRow[],
  ctx: ScoringContext,
): { candidates: AnalysisCandidate[]; rescored: Array<{ id: string; score: number; signals: RetrievalSignals }> } {
  const candidates: AnalysisCandidate[] = [];
  const rescored: Array<{ id: string; score: number; signals: RetrievalSignals }> = [];

  for (const row of rows) {
    let score = row.retrieval_score;
    if (score === null || score === undefined) {
      const normalized = normalizeCandidate({
        candidate: {
          title: row.title,
          url: row.url,
          companyNameHint: row.company_name,
          locationHint: row.location,
          snippet: '',
          markdown: row.description_raw,
          source: row.source as RawJobCandidate['source'],
          postedDateIso: row.posted_date,
        },
        companyId: row.company_id ?? '',
        companyName: row.company_name ?? '',
      });
      const result = scoreRetrieval(normalized, ctx);
      score = result.score;
      rescored.push({ id: row.id, score: result.score, signals: result.signals });
    }

    candidates.push({
      job: {
        id: row.id,
        title: row.title,
        companyName: row.company_name,
        location: row.location,
        description: row.description_raw ?? '',
      },
      score,
      postedDateIso: row.posted_date,
    });
  }

  return { candidates, rescored };
}
```

**5i. Update two existing helpers' text.** Replace the doc comment of `shouldFallBackToFirecrawl` with:

```ts
/**
 * Zero CREDIBLE local candidates — none passes evaluateEligibility() — is
 * the trigger to fall back to Firecrawl. Pulled out as its own function so
 * the decision is unit-testable without the IngestService dependency graph.
 */
```

Replace the body of `describeEmptyProfileWarning` (keep its signature) so the message matches the new behavior:

```ts
  const consequences: string[] = [];
  if (profile.target_roles.length === 0) {
    consequences.push('target_roles is empty, so only generic engineering titles (engineer/developer/SDE) pass eligibility');
  }
  if (profile.preferred_locations.length === 0) {
    consequences.push('preferred_locations is empty, so only jobs that state no location pass eligibility');
  }
  if (consequences.length === 0) return null;

  return `Profile warning: ${consequences.join('; ')}. PATCH /cv to set them (see db/migrations/0005_candidate_preferences.sql).`;
```

and update its doc comment's first sentence to: "An empty `target_roles` or `preferred_locations` list narrows eligibility sharply and silently."

- [ ] **Step 6: Run the ingest tests**

Run: `cd apps/api && npx jest ingest/ingest.service.spec.ts`
Expected: PASS — existing tests (with the updated `scoped` literals) plus the new dedup/ordering, `dedupWithinRun`, `toAnalysisCandidates` and `atsListingToCandidate` tests.

- [ ] **Step 7: Typecheck and full suite**

Run: `cd packages/shared && npm run build && cd ../../apps/api && npm run typecheck && npm test`
Expected: typecheck clean; every suite passes. Grep to confirm nothing still references the removed function: `cd apps/api && grep -rn "looksLikeRelevantRole" src` → no output.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/types.ts apps/api/src/ingest/ingest.service.ts apps/api/src/ingest/ingest.service.spec.ts apps/api/src/common/text.util.ts apps/api/src/common/text.util.spec.ts
git commit -m "feat(ingest): run the processing pipeline — eligibility, retrieval score, floor, Top-N backlog analysis"
```

- [ ] **Step 9: Flag the pending migration**

Report that `db/migrations/0008_processing_pipeline.sql` must be applied in the Supabase SQL Editor before this branch is pushed: until it is, every insert fails on the missing `retrieval_score`/`external_id` columns (surfaced in the run's errors) and the backlog query fails on the missing view column.

---

## Plan Self-Review Notes

**Spec coverage:** §6 types → Tasks 1, 2. §7 normalization → Task 2. §8 eligibility → Task 3. §9 score → Task 4. §10 selection → Task 5. §11 fallback rule → Task 7 (5f). §12 migration → Task 6. §13 config → Task 6. §14 wiring and summary → Task 7. §15 tests → every task; the composition test is Task 5. §3 decision on `DEFAULT_CV` → Task 6.

**Type consistency:** `ScopedCandidate`/`NormalizedJob` (Task 2) are used verbatim by Tasks 3–7. `RejectionReason` keys (Task 3) are the ones Task 5's composition test asserts. `RetrievalSignals`/`ScoringContext` (Task 4) are reused by Task 5's `ScoredJob` and Task 7's `toAnalysisCandidates`. `EvaluationResult.rejectionReasons` is `Record<string, number>` so it assigns directly to `IngestRunSummary.rejection_reasons` (Task 7 Step 1).

**Review Focus coverage:** string-typed numerics → Task 3 test "coerces numeric profile fields". Empty description → Task 4 "gives neutral values … empty description". maxNew keeps best → Task 7 "keeps the highest-scoring jobs". Same title two cities → Task 5 composition + Task 7 `dedupWithinRun`. Pre-migration backlog row → Task 7 "scores a pre-migration row".
