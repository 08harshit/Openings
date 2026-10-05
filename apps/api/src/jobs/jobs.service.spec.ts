import { JobsService } from './jobs.service';

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
    retrieval_score: 67,
    retrieval_signals: {
      role: 25,
      skills: 20,
      experience: 12,
      location: 10,
      freshness: 3,
      source: 4,
      requiredYearsMin: 3,
      mentionedSkills: ['nodejs'],
      matchedSkills: ['nodejs'],
    },
    ...overrides,
  };
}

function buildListService(row: Record<string, unknown>) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const fromResult: any = {
    select: () => fromResult,
    eq: (...args: unknown[]) => {
      calls.push({ method: 'eq', args });
      return fromResult;
    },
    in: () => fromResult,
    gte: (...args: unknown[]) => {
      calls.push({ method: 'gte', args });
      return fromResult;
    },
    lte: (...args: unknown[]) => {
      calls.push({ method: 'lte', args });
      return fromResult;
    },
    is: (...args: unknown[]) => {
      calls.push({ method: 'is', args });
      return fromResult;
    },
    contains: () => fromResult,
    or: () => fromResult,
    order: () => fromResult,
    range: async () => ({ data: [row], error: null, count: 1 }),
  };
  const supabase = {
    admin: { from: () => fromResult },
    unwrap: (result: { data: unknown; error: unknown }) => result.data ?? [],
    unwrapMaybe: (result: { data: unknown; error: unknown }) => result.data ?? null,
  };
  const service = new JobsService(supabase as any, { get: (_k: string, fallback?: unknown) => fallback } as any);
  return { service, calls };
}

function buildFindOneService(row: Record<string, unknown>) {
  const enrichedQuery: any = {
    select: () => enrichedQuery,
    eq: () => enrichedQuery,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  const descriptionQuery: any = {
    select: () => descriptionQuery,
    eq: () => descriptionQuery,
    single: async () => ({
      data: { description_raw: 'Full description', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' },
      error: null,
    }),
  };
  const listQuery: any = {
    select: () => listQuery,
    eq: () => listQuery,
    order: async () => ({ data: [], error: null }),
  };
  const skillsQuery: any = {
    select: () => skillsQuery,
    eq: async () => ({ data: [], error: null }),
  };
  const tables: Record<string, any> = {
    job_postings_enriched: enrichedQuery,
    job_postings: descriptionQuery,
    application_notes: listQuery,
    status_history: listQuery,
    job_skills: skillsQuery,
  };
  const supabase = {
    admin: { from: (table: string) => tables[table] },
    unwrap: (result: { data: unknown; error: unknown }) => result.data ?? [],
    unwrapMaybe: (result: { data: unknown; error: unknown }) => result.data ?? null,
  };
  return new JobsService(supabase as any, { get: (_k: string, fallback?: unknown) => fallback } as any);
}

describe('JobsService.list — final_score surfacing', () => {
  it('includes final_score and recommendation on each list item', async () => {
    const { service } = buildListService(enrichedRow());
    const result = await service.list('user-1', {});
    expect(result.items[0].final_score).toBe(82);
    expect(result.items[0].recommendation).toBe('STRONG_MATCH');
  });

  it('returns null final_score/recommendation for an unanalyzed job without crashing', async () => {
    const { service } = buildListService(enrichedRow({ final_score: null, recommendation: null }));
    const result = await service.list('user-1', {});
    expect(result.items[0].final_score).toBeNull();
    expect(result.items[0].recommendation).toBeNull();
  });

  it('filters min_score/max_score on final_score', async () => {
    const { service, calls } = buildListService(enrichedRow());
    await service.list('user-1', { min_score: 50, max_score: 90 });
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'gte', args: ['final_score', 50] },
        { method: 'lte', args: ['final_score', 90] },
      ]),
    );
  });

  it('filters unscored_only on match_score — a job analyzed before migration 0009 still has match_score set and must not be called "unscored"', async () => {
    const { service, calls } = buildListService(enrichedRow());
    await service.list('user-1', { unscored_only: true });
    expect(calls).toEqual(expect.arrayContaining([{ method: 'is', args: ['match_score', null] }]));
    expect(calls).not.toEqual(expect.arrayContaining([{ method: 'is', args: ['final_score', null] }]));
  });
});

describe('JobsService.findOne — llm_evaluation breakdown', () => {
  it('builds the full breakdown when the job has been analyzed', async () => {
    const service = buildFindOneService(enrichedRow());
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
    expect(detail.retrieval_score).toBe(67);
    expect(detail.retrieval_signals).toEqual(
      expect.objectContaining({ role: 25, mentionedSkills: ['nodejs'] }),
    );
  });

  it('returns a null llm_evaluation for an unanalyzed job', async () => {
    const service = buildFindOneService(enrichedRow({ llm_score: null, role_fit: null }));
    const detail = await service.findOne('user-1', 'job-1');
    expect(detail.llm_evaluation).toBeNull();
  });
});
