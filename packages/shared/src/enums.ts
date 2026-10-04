/**
 * Pipeline statuses. These double as the Kanban columns, in display order.
 * The DB enforces the same set via a CHECK constraint (see 0001_schema.sql).
 */
export const JOB_STATUSES = [
  'new',
  'reviewed',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'archived',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Columns shown on the Kanban board. `archived` is intentionally excluded. */
export const KANBAN_STATUSES: readonly JobStatus[] = [
  'new',
  'reviewed',
  'applied',
  'interviewing',
  'offer',
  'rejected',
];

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  new: 'New',
  reviewed: 'Reviewed',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected',
  archived: 'Archived',
};

export const SENIORITY_LEVELS = ['entry', 'mid', 'senior', 'unknown'] as const;
export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number];

export const SKILL_CATEGORIES = [
  'backend',
  'frontend',
  'db',
  'messaging',
  'realtime',
  'cloud',
  'devops',
  'testing',
  'language',
  'tooling',
  'other',
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export const PROFICIENCY_LEVELS = ['basic', 'intermediate', 'advanced'] as const;
export type ProficiencyLevel = (typeof PROFICIENCY_LEVELS)[number];

export const COMPANY_SOURCES = ['pinned', 'auto_discovered'] as const;
export type CompanySource = (typeof COMPANY_SOURCES)[number];

/**
 * Has this company's real careers page been found yet? `pending` covers a
 * discovered-but-not-yet-attempted company (reserved for future async/queued
 * resolution — the current pipeline resolves synchronously, so this value
 * isn't produced yet); `resolved` means `careers_url` is known and usable;
 * `failed` means resolution was attempted and found nothing usable — not
 * retried automatically.
 */
export const RESOLUTION_STATUSES = ['pending', 'resolved', 'failed'] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

/** Job-board platforms with a public, unauthenticated postings API — hit
 * directly instead of scraping HTML when a company's careers page runs on one. */
export const ATS_TYPES = ['greenhouse', 'lever', 'ashby'] as const;
export type AtsType = (typeof ATS_TYPES)[number];

export const JOB_SOURCES = [
  'firecrawl_search',
  'firecrawl_scrape',
  'ats_api',
  'http_scrape',
  'manual',
] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

/** Match-score bands used for the colour-coded badge. */
export type MatchBand = 'strong' | 'partial' | 'weak' | 'unscored';

export function matchBand(score: number | null | undefined): MatchBand {
  if (score === null || score === undefined) return 'unscored';
  if (score > 75) return 'strong';
  if (score >= 50) return 'partial';
  return 'weak';
}
