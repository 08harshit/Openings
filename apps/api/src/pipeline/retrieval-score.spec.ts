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
