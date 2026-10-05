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
import type { CvProfile, LlmJobEvaluation } from '@jobportal/shared';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';
import { toDateOnlyIso } from '../common/date.util';
import { normalizeCandidate } from '../pipeline/normalize';
import type { ScoredJob } from '../pipeline/evaluate';
import type { ScoringContext } from '../pipeline/retrieval-score';
import type { InsertedJob } from './ingest.service';

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

function backlogRow(overrides: Partial<BacklogRow> = {}): BacklogRow {
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

  it('checks existing hashes in URL-sized chunks and still catches a duplicate in a later chunk', async () => {
    const inCalls: string[][] = [];
    const upserts: Array<Record<string, unknown>> = [];
    const jobs = Array.from({ length: 450 }, (_, i) => scoredJob({ url: `https://acme.com/careers/${i}` }, 90));
    const alreadySaved = jobs[420].job.urlHash;
    const fromResult = {
      upsert: (payload: Record<string, unknown>) => {
        upserts.push(payload);
        const chain = { select: () => chain, maybeSingle: async () => ({ data: { id: `job-${upserts.length}` }, error: null }) };
        return chain;
      },
      select: () => fromResult,
      eq: () => fromResult,
      in: async (_column: string, values: string[]) => {
        inCalls.push(values);
        return { data: values.filter((v) => v === alreadySaved).map((url_hash) => ({ url_hash })), error: null };
      },
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

    const result = await (service as any).dedupAndInsert('user-1', jobs, 1000, []);

    expect(inCalls.length).toBeGreaterThan(1);
    expect(Math.max(...inCalls.map((values) => values.length))).toBeLessThanOrEqual(100);
    expect(inCalls.flat()).toHaveLength(450);
    expect(result.duplicates).toBe(1);
    expect(upserts.map((p) => p.url_hash)).not.toContain(alreadySaved);
  });
});

describe('IngestService.buildAnalysisPool', () => {
  // A stateful stand-in for job_postings_enriched: filters on
  // retrieval_score IS NULL, orders by retrieval_score DESC NULLS LAST, and
  // applies score write-backs so a later query sees them.
  function buildServiceWithBacklog(rows: BacklogRow[]) {
    const table = rows.map((r) => ({ ...r }));
    const updates: Array<{ id: string; retrieval_score: number }> = [];
    const viewQuery = () => {
      let onlyUnscored = false;
      let ordered = false;
      const query: any = {
        select: () => query,
        eq: () => query,
        gte: () => query,
        is: (column: string, value: unknown) => {
          if (column === 'retrieval_score' && value === null) onlyUnscored = true;
          return query;
        },
        order: () => {
          ordered = true;
          return query;
        },
        limit: async (n: number) => {
          let result = table.filter((r) => !onlyUnscored || r.retrieval_score === null);
          if (ordered) result = [...result].sort((a, b) => (b.retrieval_score ?? -1) - (a.retrieval_score ?? -1));
          return { data: result.slice(0, n).map((r) => ({ ...r })), error: null };
        },
      };
      return query;
    };
    const tableQuery = {
      update: (patch: { retrieval_score: number }) => ({
        eq: async (_column: string, id: string) => {
          updates.push({ id, retrieval_score: patch.retrieval_score });
          const row = table.find((r) => r.id === id);
          if (row) row.retrieval_score = patch.retrieval_score;
          return { error: null };
        },
      }),
    };
    const supabase = {
      admin: { from: (name: string) => (name === 'job_postings_enriched' ? viewQuery() : tableQuery) },
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
    return { service, updates };
  }

  it('scores and ranks a pre-migration row even when 200+ scored rows fill the ranked window', async () => {
    const filler = Array.from({ length: 250 }, (_, i) =>
      backlogRow({
        id: `scored-${i}`,
        url: `https://acme.com/careers/s${i}`,
        retrieval_score: 20,
        description_raw: 'A long enough job description to be analyzable by Groq.',
      }),
    );
    const old = backlogRow({
      id: 'old-1',
      url: 'https://acme.com/careers/old',
      retrieval_score: null,
      description_raw: 'Backend Engineer building Node.js and PostgreSQL services for payments.',
    });
    const { service, updates } = buildServiceWithBacklog([...filler, old]);

    const { toAnalyze } = await (service as any).buildAnalysisPool('user-1', SCORING_CTX, 5);

    expect(updates.map((u) => u.id)).toContain('old-1');
    expect(toAnalyze.map((job: { id: string }) => job.id)).toContain('old-1');
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
  const row = backlogRow;

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
    const cv = {
      getSnapshot: async () => ({
        profile: {
          id: 'p1',
          user_id: 'user-1',
          raw_cv_text: null,
          experience_years: 2,
          current_title: null,
          updated_at: '2026-10-05T00:00:00Z',
          target_roles: [],
          excluded_roles: [],
          excluded_departments: [],
          preferred_locations: [],
          excluded_companies: [],
          seniority_min_years: null,
          seniority_max_years: null,
          work_modes: [],
          employment_types: [],
          domain_preferences: [],
          domain_exclusions: [],
        } as CvProfile,
        skills: [],
      }),
    };
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
      cv as any,
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
