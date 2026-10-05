import type { CvProfile } from '@jobportal/shared';
import { containsWord } from '../common/text.util';
import { isIndiaOrRemote } from '../common/location.util';
import { ageInDays } from '../common/date.util';
import { isEngineeringTitle, matchesTargetRole, toNumberOrNull } from './eligibility';
import type { NormalizedJob } from './normalize';

export const RETRIEVAL_WEIGHTS = {
  role: 25,
  skills: 35,
  experience: 20,
  location: 10,
  freshness: 5,
  source: 5,
} as const;

const GENERIC_ROLE_POINTS = 12;
const SKILLS_NEUTRAL = 14;
const SKILLS_MIN_DENOMINATOR = 4;
const EXPERIENCE_NEUTRAL = 12;
const EXPERIENCE_NEUTRAL_SENIOR = 8;
const EXPERIENCE_OVERQUALIFIED = 10;
const LOCATION_UNKNOWN = 5;
const FRESHNESS_UNKNOWN = 3;
const SOURCE_POINTS: Record<string, number> = { ats_api: 5, http_scrape: 4, firecrawl_scrape: 3 };
const SOURCE_DEFAULT = 3;
const SENIOR_MARKERS = ['senior', 'sr'];
const FRESHER_MARKERS = ['fresher', 'graduate', 'entry level', 'junior'];

export interface ScoringContext {
  profile: CvProfile;
  /** Canonical skill slugs from the candidate's cv_skills. */
  cvSkillNames: string[];
  now: Date;
}

export interface RetrievalSignals {
  role: number;
  skills: number;
  experience: number;
  location: number;
  freshness: number;
  source: number;
  requiredYearsMin: number | null;
  mentionedSkills: string[];
  matchedSkills: string[];
}

export interface RetrievalResult {
  score: number;
  signals: RetrievalSignals;
}

function rolePoints(job: NormalizedJob, profile: CvProfile): number {
  if (matchesTargetRole(job.title, profile.target_roles)) return RETRIEVAL_WEIGHTS.role;
  return isEngineeringTitle(job.title, profile.target_roles) ? GENERIC_ROLE_POINTS : 0;
}

function skillPoints(job: NormalizedJob, cvSkillNames: string[]): { points: number; matched: string[] } {
  if (job.mentionedSkills.length === 0) return { points: SKILLS_NEUTRAL, matched: [] };
  const cv = new Set(cvSkillNames);
  const matched = job.mentionedSkills.filter((skill) => cv.has(skill));
  const coverage = matched.length / Math.max(job.mentionedSkills.length, SKILLS_MIN_DENOMINATOR);
  return { points: Math.round(RETRIEVAL_WEIGHTS.skills * Math.min(1, coverage)), matched };
}

function experiencePoints(job: NormalizedJob, profile: CvProfile): number {
  const experience = toNumberOrNull(profile.experience_years);
  const required = job.requiredYearsMin;

  if (FRESHER_MARKERS.some((m) => containsWord(job.title, m)) && experience !== null && experience >= 2) {
    return EXPERIENCE_OVERQUALIFIED;
  }
  if (experience === null || required === null) {
    return SENIOR_MARKERS.some((m) => containsWord(job.title, m)) ? EXPERIENCE_NEUTRAL_SENIOR : EXPERIENCE_NEUTRAL;
  }
  if (required <= experience) return RETRIEVAL_WEIGHTS.experience;
  if (required <= experience + 1) return 15;
  if (required <= experience + 2) return 9;
  if (required <= experience + 3) return 4;
  return 0;
}

function locationPoints(job: NormalizedJob, profile: CvProfile): number {
  if (job.isRemote) return RETRIEVAL_WEIGHTS.location;
  if (job.location === null) return LOCATION_UNKNOWN;
  return isIndiaOrRemote(job.location, profile.preferred_locations) ? RETRIEVAL_WEIGHTS.location : 0;
}

function freshnessPoints(postedDateIso: string | null, now: Date): number {
  if (!postedDateIso) return FRESHNESS_UNKNOWN;
  const posted = new Date(postedDateIso);
  if (Number.isNaN(posted.getTime())) return FRESHNESS_UNKNOWN;
  const age = ageInDays(posted, now);
  if (age <= 3) return RETRIEVAL_WEIGHTS.freshness;
  if (age <= 7) return 4;
  if (age <= 14) return 2;
  return 0;
}

function sourcePoints(source: string): number {
  return SOURCE_POINTS[source] ?? SOURCE_DEFAULT;
}

/** Cheap, deterministic 0-100 fit score used to pick which jobs are worth a
 * Groq call. Not the final ranking (that is sub-project 4). */
export function scoreRetrieval(job: NormalizedJob, ctx: ScoringContext): RetrievalResult {
  const skills = skillPoints(job, ctx.cvSkillNames);
  const signals: RetrievalSignals = {
    role: rolePoints(job, ctx.profile),
    skills: skills.points,
    experience: experiencePoints(job, ctx.profile),
    location: locationPoints(job, ctx.profile),
    freshness: freshnessPoints(job.candidate.postedDateIso, ctx.now),
    source: sourcePoints(job.candidate.source),
    requiredYearsMin: job.requiredYearsMin,
    mentionedSkills: job.mentionedSkills,
    matchedSkills: skills.matched,
  };
  const score =
    signals.role + signals.skills + signals.experience + signals.location + signals.freshness + signals.source;
  return { score, signals };
}
