import { Injectable, Logger } from '@nestjs/common';
import {
  categoryForSkill,
  displaySkillName,
  normalizeSkillName,
  type CvProfile,
  type CvSkillDetail,
} from '@jobportal/shared';
import { SupabaseService } from '../supabase/supabase.service';
import { SkillsService } from '../skills/skills.service';
import { DEFAULT_CV } from './default-cv';
import type { CvSkillDto, UpdateCvDto } from './dto/cv.dto';

export interface CvSnapshot {
  profile: CvProfile;
  skills: CvSkillDetail[];
}

@Injectable()
export class CvService {
  private readonly logger = new Logger(CvService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly skills: SkillsService,
  ) {}

  /**
   * Fetch the user's CV, creating it from DEFAULT_CV on first access.
   *
   * Bootstrapping lazily (rather than at signup) means the seed data is applied
   * even to accounts created directly in the Supabase dashboard.
   */
  async getSnapshot(userId: string): Promise<CvSnapshot> {
    let profile = await this.findProfile(userId);
    if (!profile) {
      profile = await this.bootstrap(userId);
    }

    const skills = await this.listSkills(profile.id);
    return { profile, skills };
  }

  private async findProfile(userId: string): Promise<CvProfile | null> {
    const result = await this.supabase.admin
      .from('cv_profile')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    return this.supabase.unwrapMaybe(result, 'load cv profile') as CvProfile | null;
  }

  private async bootstrap(userId: string): Promise<CvProfile> {
    this.logger.log(`Bootstrapping CV profile for user ${userId} from DEFAULT_CV`);

    const insert = await this.supabase.admin
      .from('cv_profile')
      .insert({
        user_id: userId,
        raw_cv_text: DEFAULT_CV.rawText,
        experience_years: DEFAULT_CV.experienceYears,
        current_title: DEFAULT_CV.currentTitle,
      })
      .select('*')
      .single();

    const profile = this.supabase.unwrap(insert, 'create cv profile') as CvProfile;

    const skillIds = await this.skills.ensure(DEFAULT_CV.skills.map(([name]) => name));
    const rows = DEFAULT_CV.skills
      .map(([name, proficiency]) => {
        const skillId = skillIds.get(normalizeSkillName(name));
        return skillId
          ? { cv_profile_id: profile.id, skill_id: skillId, proficiency }
          : null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (rows.length > 0) {
      const { error } = await this.supabase.admin
        .from('cv_skills')
        .upsert(rows, { onConflict: 'cv_profile_id,skill_id' });
      if (error) this.logger.warn(`Could not seed CV skills: ${error.message}`);
    }

    return profile;
  }

  async listSkills(cvProfileId: string): Promise<CvSkillDetail[]> {
    const result = await this.supabase.admin
      .from('cv_skills')
      .select('skill_id, proficiency, skills!inner(name, category)')
      .eq('cv_profile_id', cvProfileId);

    const rows = this.supabase.unwrap(result, 'list cv skills') as Array<{
      skill_id: string;
      proficiency: CvSkillDetail['proficiency'];
      skills: { name: string; category: string } | Array<{ name: string; category: string }>;
    }>;

    return rows
      .map((row) => {
        // PostgREST returns the embedded row as an object for a to-one relation,
        // but typings model it as an array — normalise both shapes.
        const skill = Array.isArray(row.skills) ? row.skills[0] : row.skills;
        if (!skill) return null;
        return {
          skill_id: row.skill_id,
          name: skill.name,
          category: skill.category as CvSkillDetail['category'],
          proficiency: row.proficiency,
        } satisfies CvSkillDetail;
      })
      .filter((row): row is CvSkillDetail => row !== null)
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  async updateProfile(userId: string, dto: UpdateCvDto): Promise<CvSnapshot> {
    const { profile } = await this.getSnapshot(userId);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (dto.raw_cv_text !== undefined) patch.raw_cv_text = dto.raw_cv_text;
    if (dto.experience_years !== undefined) patch.experience_years = dto.experience_years;
    if (dto.current_title !== undefined) patch.current_title = dto.current_title;

    const result = await this.supabase.admin
      .from('cv_profile')
      .update(patch)
      .eq('id', profile.id)
      .eq('user_id', userId)
      .select('*')
      .single();

    const updated = this.supabase.unwrap(result, 'update cv profile') as CvProfile;
    return { profile: updated, skills: await this.listSkills(updated.id) };
  }

  /**
   * Replace the whole skill set in one shot.
   *
   * The editor sends the full desired list rather than deltas, so a removed
   * skill actually disappears — that matters because future match scores are
   * computed against whatever is here.
   */
  async setSkills(userId: string, incoming: CvSkillDto[]): Promise<CvSkillDetail[]> {
    const { profile } = await this.getSnapshot(userId);

    // Normalise + de-duplicate, keeping the last proficiency stated for a skill.
    const wanted = new Map<string, CvSkillDto['proficiency']>();
    for (const item of incoming) {
      const name = normalizeSkillName(item.name);
      if (name) wanted.set(name, item.proficiency);
    }

    const skillIds = await this.skills.ensure([...wanted.keys()]);
    const rows = [...wanted.entries()]
      .map(([name, proficiency]) => {
        const skillId = skillIds.get(name);
        return skillId
          ? { cv_profile_id: profile.id, skill_id: skillId, proficiency: proficiency ?? null }
          : null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    const keptIds = rows.map((row) => row.skill_id);

    // Delete first, then upsert — a plain "delete not-in" with an empty list is
    // a footgun in PostgREST, so handle the cleared-everything case explicitly.
    const deleteQuery = this.supabase.admin
      .from('cv_skills')
      .delete()
      .eq('cv_profile_id', profile.id);
    const { error: deleteError } =
      keptIds.length > 0
        ? await deleteQuery.not('skill_id', 'in', `(${keptIds.join(',')})`)
        : await deleteQuery;
    if (deleteError) {
      this.logger.warn(`Could not prune CV skills: ${deleteError.message}`);
    }

    if (rows.length > 0) {
      const { error } = await this.supabase.admin
        .from('cv_skills')
        .upsert(rows, { onConflict: 'cv_profile_id,skill_id' });
      if (error) throw new Error(`Could not save CV skills: ${error.message}`);
    }

    return this.listSkills(profile.id);
  }

  async addSkill(userId: string, dto: CvSkillDto): Promise<CvSkillDetail[]> {
    const { profile } = await this.getSnapshot(userId);
    const skill = await this.skills.ensureOne(dto.name);
    if (!skill) return this.listSkills(profile.id);

    const { error } = await this.supabase.admin.from('cv_skills').upsert(
      {
        cv_profile_id: profile.id,
        skill_id: skill.id,
        proficiency: dto.proficiency ?? null,
      },
      { onConflict: 'cv_profile_id,skill_id' },
    );
    if (error) throw new Error(`Could not add skill: ${error.message}`);

    return this.listSkills(profile.id);
  }

  async removeSkill(userId: string, skillId: string): Promise<CvSkillDetail[]> {
    const { profile } = await this.getSnapshot(userId);
    const { error } = await this.supabase.admin
      .from('cv_skills')
      .delete()
      .eq('cv_profile_id', profile.id)
      .eq('skill_id', skillId);
    if (error) throw new Error(`Could not remove skill: ${error.message}`);
    return this.listSkills(profile.id);
  }

  /**
   * The compact CV representation handed to Claude.
   *
   * Kept small and stable on purpose: it sits at the front of every analysis
   * prompt, so churn here is churn in the cacheable prefix.
   */
  async buildAnalysisContext(userId: string): Promise<{
    currentTitle: string;
    experienceYears: number;
    skillLines: string;
    rawCvExcerpt: string;
    skillNames: string[];
  }> {
    const { profile, skills } = await this.getSnapshot(userId);

    const byCategory = new Map<string, string[]>();
    for (const skill of skills) {
      const label = skill.proficiency
        ? `${displaySkillName(skill.name)} (${skill.proficiency})`
        : displaySkillName(skill.name);
      const bucket = byCategory.get(skill.category) ?? [];
      bucket.push(label);
      byCategory.set(skill.category, bucket);
    }

    const skillLines = [...byCategory.entries()]
      .map(([category, items]) => `- ${category}: ${items.join(', ')}`)
      .join('\n');

    return {
      currentTitle: profile.current_title ?? 'Software Developer',
      experienceYears: profile.experience_years ?? 0,
      skillLines: skillLines || '- (no skills recorded yet)',
      rawCvExcerpt: (profile.raw_cv_text ?? '').slice(0, 6_000),
      skillNames: skills.map((skill) => skill.name),
    };
  }

  /** Category lookup used when rendering skills that aren't in the CV. */
  categoryFor(skillName: string) {
    return categoryForSkill(skillName);
  }
}
