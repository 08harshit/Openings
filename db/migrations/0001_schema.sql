-- ===========================================================================
-- 0001_schema.sql — Personal Job Portal core schema
--
-- Run in the Supabase SQL editor (Dashboard -> SQL Editor -> New query), or
-- via `supabase db push` if you wire up the CLI. Idempotent: safe to re-run.
-- ===========================================================================

create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- users — mirrors auth.users so the rest of the schema can FK to a table we own
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  created_at  timestamptz not null default now()
);

-- Auto-provision a public.users row whenever Supabase Auth creates an account,
-- so the app never has to special-case "signed up but no profile row yet".
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- cv_profile — one CV per user (enforced by the unique index below)
-- ---------------------------------------------------------------------------
create table if not exists public.cv_profile (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users (id) on delete cascade,
  raw_cv_text       text,
  experience_years  numeric(4, 1),
  current_title     text,
  updated_at        timestamptz not null default now()
);

create unique index if not exists cv_profile_user_id_key
  on public.cv_profile (user_id);

-- ---------------------------------------------------------------------------
-- skills — global canonical vocabulary (not user-scoped; names are normalised
-- slugs produced by packages/shared/src/skills.ts)
-- ---------------------------------------------------------------------------
create table if not exists public.skills (
  id        uuid primary key default gen_random_uuid(),
  name      text not null unique,
  category  text not null default 'other'
              check (category in ('backend','frontend','db','messaging','realtime',
                                  'cloud','devops','testing','language','tooling','other'))
);

create index if not exists skills_category_idx on public.skills (category);

-- ---------------------------------------------------------------------------
-- cv_skills — what you actually have
-- ---------------------------------------------------------------------------
create table if not exists public.cv_skills (
  cv_profile_id  uuid not null references public.cv_profile (id) on delete cascade,
  skill_id       uuid not null references public.skills (id) on delete cascade,
  proficiency    text check (proficiency in ('basic','intermediate','advanced')),
  primary key (cv_profile_id, skill_id)
);

create index if not exists cv_skills_skill_id_idx on public.cv_skills (skill_id);

-- ---------------------------------------------------------------------------
-- job_portal_companies
--
-- Named `job_portal_companies`, not `companies` — this Supabase project
-- already hosts a `public.companies` table belonging to a different app
-- (different shape: no user_id, camelCase columns). Renamed to avoid the
-- collision rather than touching that unrelated table.
-- ---------------------------------------------------------------------------
create table if not exists public.job_portal_companies (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users (id) on delete cascade,
  name             text not null,
  name_normalized  text generated always as (lower(btrim(name))) stored,
  careers_url      text,
  source           text not null default 'auto_discovered'
                     check (source in ('pinned','auto_discovered')),
  last_scraped_at  timestamptz,
  created_at       timestamptz not null default now()
);

-- One company row per user per normalised name — the scraper upserts on this.
create unique index if not exists job_portal_companies_user_name_key
  on public.job_portal_companies (user_id, name_normalized);
create index if not exists job_portal_companies_source_idx
  on public.job_portal_companies (user_id, source);

-- ---------------------------------------------------------------------------
-- job_postings
-- ---------------------------------------------------------------------------
create table if not exists public.job_postings (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.users (id) on delete cascade,
  company_id        uuid references public.job_portal_companies (id) on delete set null,
  title             text not null,
  -- Denormalised so aggregator listings (no company row) still show a name.
  company_name      text,
  title_normalized  text generated always as (lower(btrim(title))) stored,
  location          text,
  url               text not null,
  -- md5 of the canonicalised URL; computed by the API (see url.util.ts) so the
  -- same posting behind different tracking params collapses to one row.
  url_hash          text not null,
  description_raw   text,
  seniority_guess   text not null default 'unknown'
                      check (seniority_guess in ('entry','mid','senior','unknown')),
  posted_date       date,
  scraped_at        timestamptz not null default now(),
  status            text not null default 'new'
                      check (status in ('new','reviewed','applied','interviewing',
                                        'offer','rejected','archived')),
  source            text not null default 'firecrawl_search'
                      check (source in ('firecrawl_search','firecrawl_scrape','manual')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Primary dedup key: same user + same canonical URL = same posting.
create unique index if not exists job_postings_user_url_hash_key
  on public.job_postings (user_id, url_hash);

-- Secondary dedup: same company + same title, even if the URL differs
-- (job boards love to re-list). Partial so rows without a company are exempt.
create unique index if not exists job_postings_user_company_title_key
  on public.job_postings (user_id, company_id, title_normalized)
  where company_id is not null;

create index if not exists job_postings_user_status_idx
  on public.job_postings (user_id, status);
create index if not exists job_postings_scraped_at_idx
  on public.job_postings (user_id, scraped_at desc);
create index if not exists job_postings_company_idx
  on public.job_postings (company_id);

-- Full-text search over title + company + location, for the dashboard search box.
create index if not exists job_postings_search_idx
  on public.job_postings
  using gin (to_tsvector('english',
    coalesce(title,'') || ' ' || coalesce(company_name,'') || ' ' || coalesce(location,'')));

-- ---------------------------------------------------------------------------
-- job_skills — what the JD asks for, extracted by Claude
-- ---------------------------------------------------------------------------
create table if not exists public.job_skills (
  job_posting_id  uuid not null references public.job_postings (id) on delete cascade,
  skill_id        uuid not null references public.skills (id) on delete cascade,
  required        boolean not null default true,
  primary key (job_posting_id, skill_id)
);

create index if not exists job_skills_skill_id_idx on public.job_skills (skill_id);

-- ---------------------------------------------------------------------------
-- skill_gap_analysis — one row per posting (re-analysis overwrites)
-- ---------------------------------------------------------------------------
create table if not exists public.skill_gap_analysis (
  id              uuid primary key default gen_random_uuid(),
  job_posting_id  uuid not null unique references public.job_postings (id) on delete cascade,
  match_score     integer not null check (match_score between 0 and 100),
  matched_skills  jsonb not null default '[]'::jsonb,
  missing_skills  jsonb not null default '[]'::jsonb,
  summary_text    text,
  model           text,
  analyzed_at     timestamptz not null default now()
);

create index if not exists skill_gap_score_idx on public.skill_gap_analysis (match_score desc);
create index if not exists skill_gap_missing_idx
  on public.skill_gap_analysis using gin (missing_skills);

-- ---------------------------------------------------------------------------
-- application_notes
-- ---------------------------------------------------------------------------
create table if not exists public.application_notes (
  id              uuid primary key default gen_random_uuid(),
  job_posting_id  uuid not null references public.job_postings (id) on delete cascade,
  note_text       text not null,
  created_at      timestamptz not null default now()
);

create index if not exists application_notes_job_idx
  on public.application_notes (job_posting_id, created_at desc);

-- ---------------------------------------------------------------------------
-- status_history — drives the stale-application flag and the timeline
-- ---------------------------------------------------------------------------
create table if not exists public.status_history (
  id              uuid primary key default gen_random_uuid(),
  job_posting_id  uuid not null references public.job_postings (id) on delete cascade,
  old_status      text check (old_status in ('new','reviewed','applied','interviewing',
                                             'offer','rejected','archived')),
  new_status      text not null check (new_status in ('new','reviewed','applied','interviewing',
                                                      'offer','rejected','archived')),
  changed_at      timestamptz not null default now()
);

create index if not exists status_history_job_idx
  on public.status_history (job_posting_id, changed_at desc);

-- ---------------------------------------------------------------------------
-- Triggers: keep updated_at fresh and record every status transition.
-- Recording in the DB rather than the service means a status change made
-- directly in the Supabase table editor still shows up in the timeline.
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists job_postings_touch_updated_at on public.job_postings;
create trigger job_postings_touch_updated_at
  before update on public.job_postings
  for each row execute function public.touch_updated_at();

create or replace function public.record_status_change()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into public.status_history (job_posting_id, old_status, new_status)
    values (new.id, null, new.status);
  elsif new.status is distinct from old.status then
    insert into public.status_history (job_posting_id, old_status, new_status)
    values (new.id, old.status, new.status);
  end if;
  return new;
end;
$$;

drop trigger if exists job_postings_record_status_insert on public.job_postings;
create trigger job_postings_record_status_insert
  after insert on public.job_postings
  for each row execute function public.record_status_change();

drop trigger if exists job_postings_record_status_update on public.job_postings;
create trigger job_postings_record_status_update
  after update of status on public.job_postings
  for each row execute function public.record_status_change();

-- ---------------------------------------------------------------------------
-- job_postings_enriched — the single read model the dashboard hits.
-- Collapses the analysis join, note count and last-status-change into one row
-- so the list endpoint is one query instead of an N+1 fan-out.
--
-- `is_stale` is deliberately NOT computed here: the threshold lives in
-- STALE_APPLICATION_DAYS on the API so it stays tunable without a migration.
-- The view exposes last_status_change_at; the API derives the flag.
-- ---------------------------------------------------------------------------
create or replace view public.job_postings_enriched as
select
  j.id,
  j.user_id,
  j.company_id,
  j.title,
  coalesce(j.company_name, c.name)                as company_name,
  j.location,
  j.url,
  j.description_raw,
  j.seniority_guess,
  j.posted_date,
  j.scraped_at,
  j.status,
  j.source,
  j.created_at,
  j.updated_at,
  a.match_score,
  coalesce(a.matched_skills, '[]'::jsonb)         as matched_skills,
  coalesce(a.missing_skills, '[]'::jsonb)         as missing_skills,
  a.summary_text,
  a.analyzed_at,
  coalesce(n.note_count, 0)                       as note_count,
  coalesce(h.last_status_change_at, j.created_at) as last_status_change_at
from public.job_postings j
left join public.job_portal_companies c
  on c.id = j.company_id
left join public.skill_gap_analysis a
  on a.job_posting_id = j.id
left join lateral (
  select count(*)::int as note_count
  from public.application_notes an
  where an.job_posting_id = j.id
) n on true
left join lateral (
  select max(sh.changed_at) as last_status_change_at
  from public.status_history sh
  where sh.job_posting_id = j.id
) h on true;

-- Views run with the invoker's privileges so the RLS policies on the
-- underlying tables still apply to anyone querying this directly.
alter view public.job_postings_enriched set (security_invoker = true);
