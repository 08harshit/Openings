import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  displaySkillName,
  type ApplicationNote,
  type JobDetail,
  type JobListItem,
  type JobPosting,
  type JobQuery,
  type JobStatus,
  type Paginated,
  type StatusHistoryEntry,
} from '@jobportal/shared';
import { SupabaseService } from '../supabase/supabase.service';
import { canonicalizeUrl, urlHash } from '../common/url.util';
import { guessSeniority } from '../common/text.util';
import type { CreateJobDto } from './dto/job.dto';

const STALE_STATUS: JobStatus = 'applied';

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private readonly staleDays: number;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {
    this.staleDays = this.config.get<number>('staleApplicationDays', 7);
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async list(userId: string, query: JobQuery): Promise<Paginated<JobListItem>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 50;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let builder = this.supabase.admin
      .from('job_postings_enriched')
      .select('*', { count: 'exact' })
      .eq('user_id', userId);

    const statuses = Array.isArray(query.status)
      ? query.status
      : query.status
        ? [query.status]
        : undefined;
    if (statuses?.length) builder = builder.in('status', statuses);

    if (query.company_id) builder = builder.eq('company_id', query.company_id);
    if (query.seniority) builder = builder.eq('seniority_guess', query.seniority);
    if (query.min_score !== undefined) builder = builder.gte('final_score', query.min_score);
    if (query.max_score !== undefined) builder = builder.lte('final_score', query.max_score);
    if (query.unscored_only) builder = builder.is('final_score', null);
    if (query.missing_skill) {
      builder = builder.contains('missing_skills', JSON.stringify([query.missing_skill]));
    }
    if (query.search?.trim()) {
      const term = query.search.trim().replace(/[%_]/g, '');
      builder = builder.or(
        `title.ilike.%${term}%,company_name.ilike.%${term}%,location.ilike.%${term}%`,
      );
    }

    const sortColumn = query.sort ?? 'final_score';
    const ascending = (query.direction ?? 'desc') === 'asc';
    builder = builder
      .order(sortColumn, { ascending, nullsFirst: false })
      .order('scraped_at', { ascending: false })
      .range(from, to);

    const result = await builder;
    const rows = this.supabase.unwrap(result, 'list job postings') as EnrichedRow[];
    const total = result.count ?? rows.length;

    let items = rows.map((row) => this.toListItem(row));
    if (query.stale_only) items = items.filter((item) => item.is_stale);

    return { items, total, page, page_size: pageSize };
  }

  async findOne(userId: string, id: string): Promise<JobDetail> {
    const enriched = await this.supabase.admin
      .from('job_postings_enriched')
      .select('*')
      .eq('user_id', userId)
      .eq('id', id)
      .maybeSingle();

    const row = this.supabase.unwrapMaybe(enriched, 'load job posting') as EnrichedRow | null;
    if (!row) throw new NotFoundException(`Job posting ${id} not found`);

    const [descriptionResult, notesResult, historyResult, skillsResult] = await Promise.all([
      this.supabase.admin
        .from('job_postings')
        .select('description_raw, created_at, updated_at')
        .eq('id', id)
        .single(),
      this.supabase.admin
        .from('application_notes')
        .select('*')
        .eq('job_posting_id', id)
        .order('created_at', { ascending: false }),
      this.supabase.admin
        .from('status_history')
        .select('*')
        .eq('job_posting_id', id)
        .order('changed_at', { ascending: false }),
      this.supabase.admin
        .from('job_skills')
        .select('required, skills!inner(name, category)')
        .eq('job_posting_id', id),
    ]);

    const extra = this.supabase.unwrap(descriptionResult, 'load job description') as {
      description_raw: string | null;
      created_at: string;
      updated_at: string;
    };
    const notes = this.supabase.unwrap(notesResult, 'load job notes') as ApplicationNote[];
    const history = this.supabase.unwrap(historyResult, 'load job history') as StatusHistoryEntry[];
    const skillRows = this.supabase.unwrap(skillsResult, 'load job skills') as Array<{
      required: boolean;
      skills: { name: string; category: string } | Array<{ name: string; category: string }>;
    }>;

    const requiredSkills = skillRows
      .map((r) => {
        const skill = Array.isArray(r.skills) ? r.skills[0] : r.skills;
        return skill
          ? { name: skill.name, required: r.required, category: skill.category as any }
          : null;
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    const listItem = this.toListItem(row);
    return {
      ...listItem,
      description_raw: extra.description_raw,
      created_at: extra.created_at,
      updated_at: extra.updated_at,
      notes,
      history,
      required_skills: requiredSkills,
      llm_evaluation: this.toLlmEvaluation(row),
      preference_score: row.preference_score,
    };
  }

  private toListItem(row: EnrichedRow): JobListItem {
    const matchedSkills = asStringArray(row.matched_skills);
    const missingSkills = asStringArray(row.missing_skills);
    const isStale =
      row.status === STALE_STATUS && this.daysSince(row.last_status_change_at) >= this.staleDays;

    return {
      id: row.id,
      title: row.title,
      company_id: row.company_id,
      company_name: row.company_name,
      location: row.location,
      url: row.url,
      seniority_guess: row.seniority_guess,
      posted_date: row.posted_date,
      scraped_at: row.scraped_at,
      status: row.status,
      source: row.source,
      match_score: row.match_score,
      matched_skills: matchedSkills.map(displaySkillName),
      missing_skills: missingSkills.map(displaySkillName),
      summary_text: row.summary_text,
      analyzed_at: row.analyzed_at,
      note_count: row.note_count,
      last_status_change_at: row.last_status_change_at,
      is_stale: isStale,
      final_score: row.final_score,
      recommendation: row.recommendation as JobListItem['recommendation'],
    };
  }

  private toLlmEvaluation(row: EnrichedRow): JobDetail['llm_evaluation'] {
    if (row.llm_score === null || row.role_fit === null) return null;
    return {
      llm_score: row.llm_score,
      role_fit: row.role_fit,
      seniority_fit: row.seniority_fit ?? 0,
      required_skill_fit: row.required_skill_fit ?? 0,
      preferred_skill_fit: row.preferred_skill_fit ?? 0,
      experience_fit: row.experience_fit ?? 0,
      domain_fit: row.domain_fit ?? 0,
      critical_mismatch: row.critical_mismatch ?? false,
      critical_gaps: asStringArray(row.critical_gaps),
      confidence: row.confidence ?? 0,
    };
  }

  private daysSince(iso: string | null): number {
    if (!iso) return 0;
    const diffMs = Date.now() - new Date(iso).getTime();
    return diffMs / (1000 * 60 * 60 * 24);
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /** Manual "Add job" — bypasses the scraper entirely. */
  async create(userId: string, dto: CreateJobDto): Promise<JobPosting> {
    const canonical = canonicalizeUrl(dto.url);
    const hash = urlHash(dto.url);

    const result = await this.supabase.admin
      .from('job_postings')
      .upsert(
        {
          user_id: userId,
          company_id: dto.company_id ?? null,
          title: dto.title.trim(),
          company_name: dto.company_name?.trim() ?? null,
          location: dto.location?.trim() ?? null,
          url: canonical,
          url_hash: hash,
          description_raw: dto.description_raw ?? null,
          seniority_guess: dto.seniority_guess ?? guessSeniority(dto.title, dto.description_raw),
          posted_date: dto.posted_date ?? null,
          source: 'manual',
          status: 'new',
        },
        { onConflict: 'user_id,url_hash' },
      )
      .select('*')
      .single();

    return this.supabase.unwrap(result, 'create job posting') as JobPosting;
  }

  async updateStatus(userId: string, id: string, status: JobStatus): Promise<JobPosting> {
    const result = await this.supabase.admin
      .from('job_postings')
      .update({ status })
      .eq('user_id', userId)
      .eq('id', id)
      .select('*')
      .single();

    const updated = this.supabase.unwrapMaybe(result, 'update job status') as JobPosting | null;
    if (!updated) throw new NotFoundException(`Job posting ${id} not found`);
    return updated;
    // status_history is populated by the DB trigger — nothing else to do here.
  }

  async remove(userId: string, id: string): Promise<void> {
    const { error, count } = await this.supabase.admin
      .from('job_postings')
      .delete({ count: 'exact' })
      .eq('user_id', userId)
      .eq('id', id);
    if (error) throw new Error(`Could not delete job posting: ${error.message}`);
    if (!count) throw new NotFoundException(`Job posting ${id} not found`);
  }

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------

  async addNote(userId: string, jobId: string, noteText: string): Promise<ApplicationNote> {
    await this.assertOwnership(userId, jobId);

    const result = await this.supabase.admin
      .from('application_notes')
      .insert({ job_posting_id: jobId, note_text: noteText.trim() })
      .select('*')
      .single();

    return this.supabase.unwrap(result, 'add note') as ApplicationNote;
  }

  async removeNote(userId: string, jobId: string, noteId: string): Promise<void> {
    await this.assertOwnership(userId, jobId);
    const { error } = await this.supabase.admin
      .from('application_notes')
      .delete()
      .eq('id', noteId)
      .eq('job_posting_id', jobId);
    if (error) throw new Error(`Could not delete note: ${error.message}`);
  }

  private async assertOwnership(userId: string, jobId: string): Promise<void> {
    const result = await this.supabase.admin
      .from('job_postings')
      .select('id')
      .eq('user_id', userId)
      .eq('id', jobId)
      .maybeSingle();
    const found = this.supabase.unwrapMaybe(result, 'verify job ownership');
    if (!found) throw new NotFoundException(`Job posting ${jobId} not found`);
  }

  // -------------------------------------------------------------------------
  // Dashboard stats
  // -------------------------------------------------------------------------

  async stats(userId: string): Promise<{
    total: number;
    by_status: Record<JobStatus, number>;
    stale_count: number;
    unscored_count: number;
    average_match_score: number | null;
  }> {
    const result = await this.supabase.admin
      .from('job_postings_enriched')
      .select('status, match_score, last_status_change_at')
      .eq('user_id', userId);

    const rows = this.supabase.unwrap(result, 'load dashboard stats') as Array<{
      status: JobStatus;
      match_score: number | null;
      last_status_change_at: string | null;
    }>;

    const byStatus: Record<string, number> = {};
    let staleCount = 0;
    let unscoredCount = 0;
    let scoreSum = 0;
    let scoreCount = 0;

    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      if (row.match_score === null) unscoredCount++;
      else {
        scoreSum += row.match_score;
        scoreCount++;
      }
      if (row.status === STALE_STATUS && this.daysSince(row.last_status_change_at) >= this.staleDays) {
        staleCount++;
      }
    }

    return {
      total: rows.length,
      by_status: byStatus as Record<JobStatus, number>,
      stale_count: staleCount,
      unscored_count: unscoredCount,
      average_match_score: scoreCount > 0 ? Math.round(scoreSum / scoreCount) : null,
    };
  }
}

interface EnrichedRow {
  id: string;
  user_id: string;
  company_id: string | null;
  title: string;
  company_name: string | null;
  location: string | null;
  url: string;
  seniority_guess: JobPosting['seniority_guess'];
  posted_date: string | null;
  scraped_at: string;
  status: JobStatus;
  source: JobPosting['source'];
  match_score: number | null;
  matched_skills: unknown;
  missing_skills: unknown;
  summary_text: string | null;
  analyzed_at: string | null;
  note_count: number;
  last_status_change_at: string | null;
  final_score: number | null;
  recommendation: string | null;
  llm_score: number | null;
  confidence: number | null;
  critical_mismatch: boolean | null;
  critical_gaps: unknown;
  role_fit: number | null;
  seniority_fit: number | null;
  required_skill_fit: number | null;
  preferred_skill_fit: number | null;
  experience_fit: number | null;
  domain_fit: number | null;
  preference_score: number | null;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}
