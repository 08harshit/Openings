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

function candidate(overrides: Partial<RawJobCandidate> = {}): RawJobCandidate {
  return {
    title: 'Backend Engineer',
    url: 'https://acme.com/careers/1',
    companyNameHint: null,
    locationHint: null,
    snippet: '',
    markdown: null,
    source: 'http_scrape',
    postedDateIso: null,
    ...overrides,
  };
}

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

describe('filterOutExcludedCompanies', () => {
  it('drops an already-known company matching an excluded name, not just newly discovered ones', () => {
    const companies = [{ name: 'Razorpay' }, { name: 'Zerodha' }];
    const kept = filterOutExcludedCompanies(companies, ['razorpay']);
    expect(kept.map((c) => c.name)).toEqual(['Zerodha']);
  });

  it('keeps every company when the exclusion list is empty', () => {
    const companies = [{ name: 'Razorpay' }, { name: 'Zerodha' }];
    expect(filterOutExcludedCompanies(companies, []).map((c) => c.name)).toEqual(['Razorpay', 'Zerodha']);
  });
});

describe('describeEmptyProfileWarning', () => {
  it('warns when target_roles is empty — only generic engineering titles would pass eligibility', () => {
    const warning = describeEmptyProfileWarning({ target_roles: [], preferred_locations: ['india'] });
    expect(warning).toMatch(/target_roles/);
  });

  it('warns when preferred_locations is empty — only jobs stating no location would pass eligibility', () => {
    const warning = describeEmptyProfileWarning({ target_roles: ['backend'], preferred_locations: [] });
    expect(warning).toMatch(/preferred_locations/);
  });

  it('returns null when both lists are populated', () => {
    expect(describeEmptyProfileWarning({ target_roles: ['backend'], preferred_locations: ['india'] })).toBeNull();
  });
});

describe('shouldFallBackToFirecrawl', () => {
  it('falls back when the local scraper found zero raw candidates', () => {
    expect(shouldFallBackToFirecrawl([])).toBe(true);
  });

  it('falls back when the caller already filtered out all non-credible candidates, leaving none', () => {
    // Simulates the caller (scrapeCustomCareerPage) having run the
    // relevance/location filter against raw candidates from a careers-shell
    // page (self-link, "life at our company" sub-page) and getting nothing
    // back — this function only ever sees the post-filter list.
    expect(shouldFallBackToFirecrawl([])).toBe(true);
  });

  it('does not fall back when at least one candidate survives the relevance/location filter', () => {
    expect(shouldFallBackToFirecrawl([candidate()])).toBe(false);
  });
});

describe('filterStalePostings', () => {
  const MAX_AGE_DAYS = 2;

  it('drops a candidate whose postedDateIso is older than the configured max age', () => {
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    const stale = candidate({ postedDateIso: toDateOnlyIso(tenDaysAgo) });

    expect(filterStalePostings([stale], MAX_AGE_DAYS)).toEqual([]);
  });

  it('keeps a candidate whose postedDateIso is recent (within the max age)', () => {
    const today = new Date();
    const fresh = candidate({ postedDateIso: toDateOnlyIso(today) });

    expect(filterStalePostings([fresh], MAX_AGE_DAYS)).toEqual([fresh]);
  });

  it('keeps a candidate with a null postedDateIso — unknown date is not evidence of staleness', () => {
    const unknown = candidate({ postedDateIso: null });

    expect(filterStalePostings([unknown], MAX_AGE_DAYS)).toEqual([unknown]);
  });

  it('keeps a candidate with an unparseable postedDateIso rather than rejecting it', () => {
    const malformed = candidate({ postedDateIso: 'not-a-date' });

    expect(filterStalePostings([malformed], MAX_AGE_DAYS)).toEqual([malformed]);
  });
});

describe('describeInsertError', () => {
  it('formats a human-readable message for a non-23505 database error', () => {
    const message = describeInsertError('Backend Engineer', { code: '23502', message: 'null value in column "x"' });
    expect(message).toMatch(/Backend Engineer/);
    expect(message).toMatch(/null value in column "x"/);
  });
});

describe('IngestService.insertOne DB-error visibility (I3/Fix 4)', () => {
  // Minimal hand-rolled mocks rather than a full Nest TestingModule — this
  // test suite otherwise only exercises pure functions; IngestService's
  // constructor just takes plain injected services, so a light fluent mock
  // of the Supabase query builder is enough to drive insertOne()/
  // dedupAndInsert() without standing up a real database.
  function buildServiceWithSupabaseError(error: { code?: string; message: string }) {
    const upsertChain = {
      select: () => upsertChain,
      maybeSingle: async () => ({ data: null, error }),
    };
    const fromResult = {
      upsert: () => upsertChain,
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
      {} as any, // firecrawl
      {} as any, // analysis
      {} as any, // companies
      {} as any, // skills
      {} as any, // resolver
      { get: (_key: string, fallback?: unknown) => fallback } as any, // config
      {} as any, // cv
    );
    return service;
  }

  it('pushes a human-readable message into errors[] when insertOne hits a non-23505 DB error', async () => {
    const service = buildServiceWithSupabaseError({ code: '23502', message: 'null value in column "title"' });
    const errors: string[] = [];

    const scoped = [scoredJob({ title: 'Backend Engineer', url: 'https://acme.com/careers/1' })];

    // dedupAndInsert is private — accessed via bracket notation, the same
    // pragmatic escape hatch used to unit-test a private method without a
    // broader refactor to make it public just for testing.
    const result = await (service as any).dedupAndInsert('user-1', scoped, 100, errors);

    expect(result.inserted).toEqual([]);
    expect(errors.some((e) => e.includes('Backend Engineer') && e.includes('null value in column "title"'))).toBe(
      true,
    );
  });

  it('does NOT push a message into errors[] for a 23505 (expected dedup) error', async () => {
    const service = buildServiceWithSupabaseError({ code: '23505', message: 'duplicate key value' });
    const errors: string[] = [];

    const scoped = [scoredJob({ title: 'Backend Engineer', url: 'https://acme.com/careers/1' })];

    await (service as any).dedupAndInsert('user-1', scoped, 100, errors);

    expect(errors).toEqual([]);
  });
});

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
