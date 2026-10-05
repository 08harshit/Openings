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
