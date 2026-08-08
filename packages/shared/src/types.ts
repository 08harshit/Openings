import type {
  AtsType,
  CompanySource,
  JobSource,
  JobStatus,
  ProficiencyLevel,
  ResolutionStatus,
  SeniorityLevel,
  SkillCategory,
} from './enums';

// ---------------------------------------------------------------------------
// Row shapes — these mirror the tables in db/migrations/0001_schema.sql.
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  email: string;
  created_at: string;
}

export interface CvProfile {
  id: string;
  user_id: string;
  raw_cv_text: string | null;
  experience_years: number | null;
  current_title: string | null;
  updated_at: string;
}

export interface Skill {
  id: string;
  name: string;
  category: SkillCategory;
}

export interface CvSkill {
  cv_profile_id: string;
  skill_id: string;
  proficiency: ProficiencyLevel | null;
}

/** A CV skill joined with its skill row — what the editor actually renders. */
export interface CvSkillDetail {
  skill_id: string;
  name: string;
  category: SkillCategory;
  proficiency: ProficiencyLevel | null;
}

export interface Company {
  id: string;
  user_id: string;
  name: string;
  careers_url: string | null;
  source: CompanySource;
  last_scraped_at: string | null;
  created_at: string;
  /** Has a real careers page been found? Pinned companies default to
   * 'resolved' (you gave us the URL); auto-discovered ones start 'pending'
   * until CompanyResolverService runs. */
  resolution_status: ResolutionStatus;
  /** Set when the careers page is a known ATS — jobs come from that
   * platform's JSON API instead of scraping HTML. */
  ats_type: AtsType | null;
  ats_board_token: string | null;
  resolution_attempted_at: string | null;
}

export interface JobPosting {
  id: string;
  user_id: string;
  company_id: string | null;
  title: string;
  company_name: string | null;
  location: string | null;
  url: string;
  url_hash: string;
  description_raw: string | null;
  seniority_guess: SeniorityLevel;
  posted_date: string | null;
  scraped_at: string;
  status: JobStatus;
  source: JobSource;
  created_at: string;
  updated_at: string;
}

export interface JobSkill {
  job_posting_id: string;
  skill_id: string;
  required: boolean;
}

export interface SkillGapAnalysis {
  id: string;
  job_posting_id: string;
  match_score: number;
  matched_skills: string[];
  missing_skills: string[];
  summary_text: string | null;
  model: string | null;
  analyzed_at: string;
}

export interface ApplicationNote {
  id: string;
  job_posting_id: string;
  note_text: string;
  created_at: string;
}

export interface StatusHistoryEntry {
  id: string;
  job_posting_id: string;
  old_status: JobStatus | null;
  new_status: JobStatus;
  changed_at: string;
}

// ---------------------------------------------------------------------------
// API view models
// ---------------------------------------------------------------------------

/**
 * The denormalised row the dashboard renders in both table and Kanban mode.
 * Produced by `job_postings_enriched` (a DB view) so the list endpoint stays a
 * single query rather than an N+1 join fan-out.
 */
export interface JobListItem {
  id: string;
  title: string;
  company_id: string | null;
  company_name: string | null;
  location: string | null;
  url: string;
  seniority_guess: SeniorityLevel;
  posted_date: string | null;
  scraped_at: string;
  status: JobStatus;
  source: JobSource;
  match_score: number | null;
  matched_skills: string[];
  missing_skills: string[];
  summary_text: string | null;
  analyzed_at: string | null;
  note_count: number;
  /** Timestamp of the most recent status change; null if never moved. */
  last_status_change_at: string | null;
  /** True when status = 'applied' and nothing changed for STALE_APPLICATION_DAYS. */
  is_stale: boolean;
}

export interface JobDetail extends JobListItem {
  description_raw: string | null;
  created_at: string;
  updated_at: string;
  notes: ApplicationNote[];
  history: StatusHistoryEntry[];
  required_skills: Array<{ name: string; required: boolean; category: SkillCategory }>;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface JobQuery {
  status?: JobStatus | JobStatus[];
  search?: string;
  company_id?: string;
  seniority?: SeniorityLevel;
  min_score?: number;
  max_score?: number;
  /** Only jobs missing this canonical skill — powers the missing-skill chips. */
  missing_skill?: string;
  stale_only?: boolean;
  unscored_only?: boolean;
  sort?: 'match_score' | 'scraped_at' | 'posted_date' | 'title';
  direction?: 'asc' | 'desc';
  page?: number;
  page_size?: number;
}

// ---------------------------------------------------------------------------
// Skill-gap engine contract (what Claude returns, post-validation)
// ---------------------------------------------------------------------------

export interface SkillGapResult {
  match_score: number;
  seniority_guess: SeniorityLevel;
  matched_skills: string[];
  missing_skills: string[];
  required_skills: Array<{ name: string; required: boolean }>;
  summary_text: string;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export interface IngestRunSummary {
  run_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  queries_run: number;
  /** New company names discovered this run and attempted (resolved + failed). */
  companies_discovered: number;
  /** Of those, how many got a verified careers_url (ATS or custom page). */
  companies_resolved: number;
  /** Of those, how many found nothing usable — recorded so they aren't retried every run. */
  companies_failed: number;
  companies_scraped: number;
  candidates_found: number;
  duplicates_skipped: number;
  jobs_inserted: number;
  jobs_analyzed: number;
  errors: string[];
}

export interface DashboardStats {
  total: number;
  by_status: Record<JobStatus, number>;
  stale_count: number;
  unscored_count: number;
  average_match_score: number | null;
  /** Canonical skill -> how many open postings ask for it but the CV lacks it. */
  top_missing_skills: Array<{ name: string; count: number }>;
}
