import type { CvProfile } from '@jobportal/shared';
import { containsWord } from '../common/text.util';
import { isIndiaOrRemote } from '../common/location.util';
import type { NormalizedJob } from './normalize';

export type RejectionReason =
  | 'excluded_department'
  | 'excluded_role'
  | 'leadership_or_intern'
  | 'non_engineering_title'
  | 'experience_too_high'
  | 'location_mismatch';

export type EligibilityResult = { eligible: true } | { eligible: false; reason: RejectionReason };

/** Titles that are engineering roles even when they match no target role.
 * Not "development" — it would admit "Business Development Executive". */
export const GENERIC_ENGINEERING_MARKERS: readonly string[] = [
  'engineer', 'engineering', 'developer', 'sde', 'swe', 'programmer', 'technical staff', 'mts',
];

const LEADERSHIP_OR_INTERN_MARKERS: readonly string[] = [
  'principal', 'director', 'head of', 'vp', 'vice president', 'manager', 'architect', 'intern', 'internship',
];

const YEARS_SLACK = 3;

export function matchesTargetRole(title: string, targetRoles: readonly string[]): boolean {
  return targetRoles.some((role) => containsWord(title, role));
}

export function isEngineeringTitle(title: string, targetRoles: readonly string[]): boolean {
  return (
    matchesTargetRole(title, targetRoles) ||
    GENERIC_ENGINEERING_MARKERS.some((marker) => containsWord(title, marker))
  );
}

/** PostgREST can return `numeric` columns as strings; compare numbers only. */
export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Most years a posting may ask for before it's out of reach. */
export function yearsCeiling(profile: Pick<CvProfile, 'experience_years' | 'seniority_max_years'>): number | null {
  const max = toNumberOrNull(profile.seniority_max_years);
  if (max !== null) return max;
  const experience = toNumberOrNull(profile.experience_years);
  return experience === null ? null : experience + YEARS_SLACK;
}

function hasLeadershipOrInternMarker(title: string): boolean {
  // "Member of Technical Staff" is an individual-contributor title.
  if (containsWord(title.replace(/technical\s+staff/gi, ''), 'staff')) return true;
  return LEADERSHIP_OR_INTERN_MARKERS.some((marker) => containsWord(title, marker));
}

function reject(reason: RejectionReason): EligibilityResult {
  return { eligible: false, reason };
}

/** Hard rejects only — anything borderline passes and is ranked by the
 * retrieval score instead. First failing check wins. */
export function evaluateEligibility(job: NormalizedJob, profile: CvProfile): EligibilityResult {
  const department = job.department;
  if (department && profile.excluded_departments.some((d) => containsWord(department, d))) {
    return reject('excluded_department');
  }
  if (profile.excluded_roles.some((role) => containsWord(job.title, role))) return reject('excluded_role');
  if (hasLeadershipOrInternMarker(job.title)) return reject('leadership_or_intern');
  if (!isEngineeringTitle(job.title, profile.target_roles)) return reject('non_engineering_title');

  const ceiling = yearsCeiling(profile);
  if (ceiling !== null && job.requiredYearsMin !== null && job.requiredYearsMin > ceiling) {
    return reject('experience_too_high');
  }

  if (job.location !== null && !isIndiaOrRemote(job.location, profile.preferred_locations)) {
    return reject('location_mismatch');
  }

  return { eligible: true };
}
