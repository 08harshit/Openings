import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  SEED_SKILLS,
  categoryForSkill,
  normalizeSkillList,
  normalizeSkillName,
  type Skill,
} from '@jobportal/shared';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * Owns the global `skills` vocabulary.
 *
 * The table is deliberately not user-scoped: two postings asking for "nestjs"
 * should point at the same row so the missing-skill chips aggregate. Everything
 * that writes here goes through `ensure()`, which normalises first — that's the
 * invariant that keeps "Node.js" / "nodejs" / "node js" from becoming three rows.
 */
@Injectable()
export class SkillsService implements OnModuleInit {
  private readonly logger = new Logger(SkillsService.name);

  /** name -> id. Warmed on boot; skills are created rarely and never renamed. */
  private readonly idByName = new Map<string, string>();

  constructor(private readonly supabase: SupabaseService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seed();
      await this.warmCache();
      this.logger.log(`Skill vocabulary ready (${this.idByName.size} skills)`);
    } catch (error) {
      // A cold vocabulary is recoverable — ensure() will lazily fill it in.
      // Don't take the whole API down over it.
      this.logger.error(
        `Could not initialise skill vocabulary: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** Upsert the canonical taxonomy from packages/shared. Idempotent. */
  async seed(): Promise<void> {
    const rows = SEED_SKILLS.map((skill) => ({ name: skill.name, category: skill.category }));
    const { error } = await this.supabase.admin
      .from('skills')
      .upsert(rows, { onConflict: 'name', ignoreDuplicates: false });
    if (error) throw new Error(`skill seed failed: ${error.message}`);
  }

  private async warmCache(): Promise<void> {
    const { data, error } = await this.supabase.admin.from('skills').select('id, name');
    if (error) throw new Error(`skill cache warm failed: ${error.message}`);
    this.idByName.clear();
    for (const row of data ?? []) this.idByName.set(row.name, row.id);
  }

  async listAll(): Promise<Skill[]> {
    const result = await this.supabase.admin
      .from('skills')
      .select('id, name, category')
      .order('category')
      .order('name');
    return this.supabase.unwrap(result, 'list skills') as Skill[];
  }

  /**
   * Normalise the given names, create any that don't exist yet, and return a
   * canonicalName -> id map. This is the only sanctioned way to turn free text
   * from a JD into skill ids.
   */
  async ensure(rawNames: readonly string[]): Promise<Map<string, string>> {
    const names = normalizeSkillList(rawNames);
    const resolved = new Map<string, string>();
    const unknown: string[] = [];

    for (const name of names) {
      const cached = this.idByName.get(name);
      if (cached) resolved.set(name, cached);
      else unknown.push(name);
    }
    if (unknown.length === 0) return resolved;

    // Insert-then-read rather than upsert-with-select: `ignoreDuplicates` makes
    // the returning payload unreliable when some rows already exist, and a
    // concurrent ingest run can legitimately race us to the same skill.
    const { error: insertError } = await this.supabase.admin.from('skills').upsert(
      unknown.map((name) => ({ name, category: categoryForSkill(name) })),
      { onConflict: 'name', ignoreDuplicates: true },
    );
    if (insertError) {
      this.logger.warn(`Could not create skills [${unknown.join(', ')}]: ${insertError.message}`);
    }

    const { data, error } = await this.supabase.admin
      .from('skills')
      .select('id, name')
      .in('name', unknown);
    if (error) {
      this.logger.warn(`Could not resolve skill ids: ${error.message}`);
      return resolved;
    }

    for (const row of data ?? []) {
      this.idByName.set(row.name, row.id);
      resolved.set(row.name, row.id);
    }
    return resolved;
  }

  /** Resolve a single skill name to its id, creating it if necessary. */
  async ensureOne(rawName: string): Promise<{ id: string; name: string } | null> {
    const name = normalizeSkillName(rawName);
    if (!name) return null;
    const map = await this.ensure([name]);
    const id = map.get(name);
    return id ? { id, name } : null;
  }
}
