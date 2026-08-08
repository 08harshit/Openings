# Database setup (Supabase)

## One-time setup

1. Create a free project at [supabase.com](https://supabase.com). Note the region —
   pick the one closest to where you'll run the API (Render's free tier is Oregon/Frankfurt).
2. Open **SQL Editor → New query** and run these files **in order**:

   | Order | File | What it does |
   |---|---|---|
   | 1 | `migrations/0001_schema.sql` | Tables, indexes, triggers, the `job_postings_enriched` read model |
   | 2 | `migrations/0002_rls.sql` | Row Level Security policies |
   | 3 | `migrations/0003_seed_skills.sql` | Canonical skill vocabulary (optional — the API seeds this too) |
   | 4 | `migrations/0004_company_discovery.sql` | Adds `resolution_status`/`ats_type`/`ats_board_token` for auto-discovery |

   All four are idempotent, so re-running them after a schema tweak is safe.

3. **Authentication → Providers**: leave Email enabled. For a personal tool, turn
   **off** "Confirm email" under Authentication → Sign In / Providers → Email so you
   can sign in immediately without an SMTP setup.
4. **Authentication → URL Configuration**: add your Angular origin
   (`http://localhost:4200` for dev, plus your deployed URL) to *Redirect URLs*.
5. Grab the four values the API needs from **Project Settings → API**:
   - Project URL → `SUPABASE_URL`
   - `anon` `public` key → `SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (**server only**)
   - **JWT Settings → JWT Secret** → `SUPABASE_JWT_SECRET`

## Free-tier pause

Supabase pauses free projects after 7 days of inactivity. The API's `/health/db`
endpoint runs a trivial query, and the ingestion cron on Render hits the database
on every run — between them the project stays awake. If you disable the cron,
expect to un-pause manually from the dashboard.

## Schema notes

- **Dedup** happens on two unique indexes: `(user_id, url_hash)` — where `url_hash`
  is md5 of the *canonicalised* URL, tracking params stripped — and
  `(user_id, company_id, title_normalized)` for the same role re-listed under a
  different URL.
- **`status_history` is written by a trigger**, not by the service. A status change
  made directly in the Supabase table editor still lands in the timeline.
- **`is_stale` is not a column.** The view exposes `last_status_change_at`; the API
  applies the `STALE_APPLICATION_DAYS` threshold so you can tune it without a migration.
- **`skills` is global, not user-scoped.** Names are normalised slugs produced by
  `normalizeSkillName()` in `packages/shared`. Always normalise before inserting.
- **The companies table is `job_portal_companies`, not `companies`.** If your
  Supabase project is shared with other apps, `public.companies` may already
  exist with an unrelated shape — this app's table is named to avoid that
  collision. All app code goes through this name already; nothing to configure.

## Resetting

```sql
-- Nuclear option: drops every table this app owns. Auth users survive.
-- Table names here are namespaced (job_portal_companies, not companies) so
-- this is safe to run even in a Supabase project shared with other apps.
drop view if exists public.job_postings_enriched;
drop table if exists public.status_history, public.application_notes,
  public.skill_gap_analysis, public.job_skills, public.job_postings,
  public.job_portal_companies, public.cv_skills, public.skills, public.cv_profile,
  public.users cascade;
```
