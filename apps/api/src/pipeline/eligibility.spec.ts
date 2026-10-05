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
