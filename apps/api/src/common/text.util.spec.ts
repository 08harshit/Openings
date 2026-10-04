import { looksLikeRelevantRole } from './text.util';

const TARGET_ROLES = [
  'backend', 'back end', 'back-end',
  'full stack', 'fullstack', 'full-stack',
  'software engineer', 'software developer',
  'sde', 'swe',
  'node.js', 'nodejs', 'node',
  'nestjs', 'nest.js',
  'api engineer',
  'server-side', 'server side',
];

const EXCLUDED_ROLES = [
  'sales engineer', 'support engineer', 'solutions engineer',
  'field engineer', 'hardware engineer', 'mechanical engineer',
  'electrical engineer', 'civil engineer', 'network engineer',
  'security engineer', 'data engineer', 'ml engineer',
  'machine learning engineer', 'ai engineer', 'qa engineer',
  'test engineer', 'ios engineer', 'android engineer',
  'mobile engineer', 'frontend engineer', 'front-end engineer',
  'front end engineer', 'site reliability', 'devops engineer',
  'platform engineer', 'embedded engineer',
  'ios', 'android', 'react native', 'flutter',
];

const EXCLUDED_DEPARTMENTS = [
  'sales', 'marketing', 'people', 'hr', 'human resources', 'finance',
  'legal', 'design', 'customer success', 'customer support', 'support',
  'operations', 'recruiting', 'talent', 'business development', 'bd',
  'account management', 'partnerships', 'content', 'communications',
  'product management',
];

describe('looksLikeRelevantRole', () => {
  it('accepts a title matching a target role', () => {
    expect(
      looksLikeRelevantRole('Backend Engineer', null, TARGET_ROLES, EXCLUDED_ROLES, EXCLUDED_DEPARTMENTS),
    ).toBe(true);
  });

  it('rejects a title matching an excluded role even if it also contains "engineer"', () => {
    expect(
      looksLikeRelevantRole('Platform Engineer', null, TARGET_ROLES, EXCLUDED_ROLES, EXCLUDED_DEPARTMENTS),
    ).toBe(false);
  });

  it('rejects a posting whose department is excluded, regardless of title', () => {
    expect(
      looksLikeRelevantRole('Backend Engineer', 'Sales', TARGET_ROLES, EXCLUDED_ROLES, EXCLUDED_DEPARTMENTS),
    ).toBe(false);
  });

  it('rejects a title matching no target role', () => {
    expect(
      looksLikeRelevantRole('Graphic Designer', null, TARGET_ROLES, EXCLUDED_ROLES, EXCLUDED_DEPARTMENTS),
    ).toBe(false);
  });

  it('does not false-positive on substrings ("swe" inside "Swedish")', () => {
    expect(
      looksLikeRelevantRole(
        'Account Development Representative (Swedish Speaking)',
        null,
        TARGET_ROLES,
        EXCLUDED_ROLES,
        EXCLUDED_DEPARTMENTS,
      ),
    ).toBe(false);
  });

  it('rejects every title when targetRoles is empty (no silent wildcard accept)', () => {
    expect(looksLikeRelevantRole('Backend Engineer', null, [], EXCLUDED_ROLES, EXCLUDED_DEPARTMENTS)).toBe(false);
    expect(looksLikeRelevantRole('Software Developer', null, [], [], [])).toBe(false);
  });

  it('does not treat a blank/whitespace-only marker as a wildcard match', () => {
    // A blank entry in targetRoles must not accept every title — containsWord('', '')
    // trimmed would otherwise build /\b\b/i, which matches any word character.
    expect(looksLikeRelevantRole('Graphic Designer', null, [''], [], [])).toBe(false);
    expect(looksLikeRelevantRole('Graphic Designer', null, ['   '], [], [])).toBe(false);
    // A blank entry in excludedRoles must not reject every title either.
    expect(looksLikeRelevantRole('Backend Engineer', null, TARGET_ROLES, [''], [])).toBe(true);
  });
});
