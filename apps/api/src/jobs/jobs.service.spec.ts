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
    ...overrides,
  };
}

function buildListService(row: Record<string, unknown>) {
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
  };
  const supabase = {
    admin: { from: () => fromResult },
    unwrap: (result: { data: unknown; error: unknown }) => result.data ?? [],
    unwrapMaybe: (result: { data: unknown; error: unknown }) => result.data ?? null,
  };
  return new JobsService(supabase as any, { get: (_k: string, fallback?: unknown) => fallback } as any);
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
    const service = buildListService(enrichedRow());
    const result = await service.list('user-1', {});
    expect(result.items[0].final_score).toBe(82);
    expect(result.items[0].recommendation).toBe('STRONG_MATCH');
  });

  it('returns null final_score/recommendation for an unanalyzed job without crashing', async () => {
    const service = buildListService(enrichedRow({ final_score: null, recommendation: null }));
    const result = await service.list('user-1', {});
    expect(result.items[0].final_score).toBeNull();
    expect(result.items[0].recommendation).toBeNull();
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
  });

  it('returns a null llm_evaluation for an unanalyzed job', async () => {
    const service = buildFindOneService(enrichedRow({ llm_score: null, role_fit: null }));
    const detail = await service.findOne('user-1', 'job-1');
    expect(detail.llm_evaluation).toBeNull();
  });
});
