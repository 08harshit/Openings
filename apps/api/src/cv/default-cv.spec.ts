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
