import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Company, CompanySource } from '@jobportal/shared';
import { SupabaseService } from '../supabase/supabase.service';
import { canonicalizeUrl } from '../common/url.util';
import type { CreateCompanyDto, UpdateCompanyDto } from './dto/company.dto';
import type { ResolveResult } from '../discovery/company-resolver.service';

/**
 * Named `job_portal_companies`, not `companies` — this Supabase project already
 * hosts other apps with their own unrelated `public.companies` table.
 */
const TABLE = 'job_portal_companies';

@Injectable()
export class CompaniesService {
  private readonly logger = new Logger(CompaniesService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async list(userId: string, source?: CompanySource): Promise<Company[]> {
    let query = this.supabase.admin
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .order('source', { ascending: true })
      .order('name', { ascending: true });

    if (source) query = query.eq('source', source);

    return this.supabase.unwrap(await query, 'list companies') as Company[];
  }

  async findOne(userId: string, id: string): Promise<Company> {
    const result = await this.supabase.admin
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .eq('id', id)
      .maybeSingle();

    const company = this.supabase.unwrapMaybe(result, 'load company') as Company | null;
    if (!company) throw new NotFoundException(`Company ${id} not found`);
    return company;
  }

  async create(userId: string, dto: CreateCompanyDto): Promise<Company> {
    const result = await this.supabase.admin
      .from(TABLE)
      .upsert(
        {
          user_id: userId,
          name: dto.name.trim(),
          careers_url: dto.careers_url ? canonicalizeUrl(dto.careers_url) : null,
          source: dto.source ?? 'pinned',
          // A user who manually pins a company is giving us the URL (or will)
          // — treat it the same as a successful resolution, not "pending".
          resolution_status: 'resolved',
        },
        // A company auto-discovered earlier gets promoted to pinned rather than
        // colliding on the (user_id, name_normalized) unique index.
        { onConflict: 'user_id,name_normalized' },
      )
      .select('*')
      .single();

    return this.supabase.unwrap(result, 'create company') as Company;
  }

  async update(userId: string, id: string, dto: UpdateCompanyDto): Promise<Company> {
    await this.findOne(userId, id);

    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.careers_url !== undefined) {
      patch.careers_url = dto.careers_url ? canonicalizeUrl(dto.careers_url) : null;
    }
    if (dto.source !== undefined) patch.source = dto.source;

    const result = await this.supabase.admin
      .from(TABLE)
      .update(patch)
      .eq('user_id', userId)
      .eq('id', id)
      .select('*')
      .single();

    return this.supabase.unwrap(result, 'update company') as Company;
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.findOne(userId, id);
    // job_postings.company_id is ON DELETE SET NULL, so removing a pinned
    // company keeps its postings — they just lose the link.
    const { error } = await this.supabase.admin
      .from(TABLE)
      .delete()
      .eq('user_id', userId)
      .eq('id', id);
    if (error) throw new Error(`Could not delete company: ${error.message}`);
  }

  async markScraped(companyId: string): Promise<void> {
    const { error } = await this.supabase.admin
      .from(TABLE)
      .update({ last_scraped_at: new Date().toISOString() })
      .eq('id', companyId);
    if (error) this.logger.warn(`Could not update last_scraped_at: ${error.message}`);
  }

  // -------------------------------------------------------------------------
  // Auto-discovery
  // -------------------------------------------------------------------------

  /**
   * Normalised names already known for this user, any resolution status —
   * the discovery step skips any candidate name found in this set, so a
   * company (successfully resolved or not) is never re-attempted every run.
   */
  async getKnownNormalizedNames(userId: string): Promise<Set<string>> {
    const result = await this.supabase.admin
      .from(TABLE)
      .select('name_normalized')
      .eq('user_id', userId);

    const rows = this.supabase.unwrap(result, 'list known company names') as Array<{
      name_normalized: string;
    }>;
    return new Set(rows.map((r) => r.name_normalized));
  }

  /**
   * Persists a discovery attempt's outcome — resolved (with a verified
   * careers_url, and ats_type/token when applicable) or failed. Failed
   * attempts are still recorded so they aren't retried every run.
   */
  async recordDiscoveredCompany(
    userId: string,
    name: string,
    result: ResolveResult,
  ): Promise<Company | null> {
    const trimmed = name.trim();
    if (trimmed.length < 2) return null;

    const row: {
      user_id: string;
      name: string;
      careers_url: string | null;
      source: 'auto_discovered';
      resolution_status: 'resolved' | 'failed';
      ats_type: 'greenhouse' | 'lever' | 'ashby' | null;
      ats_board_token: string | null;
      resolution_attempted_at: string;
    } =
      result.status === 'resolved'
        ? {
            user_id: userId,
            name: trimmed,
            careers_url: canonicalizeUrl(result.careersUrl),
            source: 'auto_discovered',
            resolution_status: 'resolved',
            ats_type: result.atsType,
            ats_board_token: result.atsBoardToken,
            resolution_attempted_at: new Date().toISOString(),
          }
        : {
            user_id: userId,
            name: trimmed,
            careers_url: null,
            source: 'auto_discovered',
            resolution_status: 'failed',
            ats_type: null,
            ats_board_token: null,
            resolution_attempted_at: new Date().toISOString(),
          };

    const inserted = await this.supabase.admin
      .from(TABLE)
      .upsert(row, { onConflict: 'user_id,name_normalized' })
      .select('*')
      .maybeSingle();

    const company = this.supabase.unwrapMaybe(inserted, 'record discovered company') as Company | null;
    if (!company) this.logger.warn(`Could not record discovery result for "${trimmed}"`);
    return company;
  }

  /** Every company with a usable careers page — pinned or auto-discovered,
   * this is what the ingest pipeline actually scrapes each run. */
  async listScrapable(userId: string): Promise<Company[]> {
    const result = await this.supabase.admin
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .eq('resolution_status', 'resolved')
      .not('careers_url', 'is', null);

    return this.supabase.unwrap(result, 'list scrapable companies') as Company[];
  }
}
