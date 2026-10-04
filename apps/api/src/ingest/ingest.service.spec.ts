import {
  describeEmptyProfileWarning,
  describeInsertError,
  filterOutExcludedCompanies,
  filterStalePostings,
  IngestService,
  isExcludedCompany,
  shouldFallBackToFirecrawl,
} from './ingest.service';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';
import { toDateOnlyIso } from '../common/date.util';

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
  it('warns when target_roles is empty — an empty allow-list would silently reject every job', () => {
    const warning = describeEmptyProfileWarning({ target_roles: [], preferred_locations: ['india'] });
    expect(warning).toMatch(/target_roles/);
  });

  it('warns when preferred_locations is empty — an empty allow-list would silently reject every job', () => {
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

    const scoped = [
      {
        candidate: candidate({ title: 'Backend Engineer', url: 'https://acme.com/careers/1' }),
        companyId: 'company-1',
        companyName: 'Acme',
      },
    ];

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

    const scoped = [
      {
        candidate: candidate({ title: 'Backend Engineer', url: 'https://acme.com/careers/1' }),
        companyId: 'company-1',
        companyName: 'Acme',
      },
    ];

    await (service as any).dedupAndInsert('user-1', scoped, 100, errors);

    expect(errors).toEqual([]);
  });
});
