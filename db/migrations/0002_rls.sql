-- ===========================================================================
-- 0002_rls.sql — Row Level Security
--
-- The NestJS API talks to Supabase with the service_role key, which bypasses
-- RLS entirely; authorisation there is enforced by the JWT guard + explicit
-- user_id filters on every query. These policies are defence in depth: they
-- make it safe to point the Angular app (or the Supabase table editor, or a
-- future mobile client) straight at Postgres with an anon key.
--
-- Run after 0001_schema.sql. Idempotent.
-- ===========================================================================

alter table public.users               enable row level security;
alter table public.cv_profile          enable row level security;
alter table public.skills              enable row level security;
alter table public.cv_skills           enable row level security;
alter table public.job_portal_companies enable row level security;
alter table public.job_postings        enable row level security;
alter table public.job_skills          enable row level security;
alter table public.skill_gap_analysis  enable row level security;
alter table public.application_notes   enable row level security;
alter table public.status_history      enable row level security;

-- --- users -----------------------------------------------------------------
drop policy if exists users_self_select on public.users;
create policy users_self_select on public.users
  for select using (auth.uid() = id);

drop policy if exists users_self_update on public.users;
create policy users_self_update on public.users
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- --- cv_profile ------------------------------------------------------------
drop policy if exists cv_profile_owner_all on public.cv_profile;
create policy cv_profile_owner_all on public.cv_profile
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- --- skills (global read, no client writes — the API seeds/extends it) ------
drop policy if exists skills_read_all on public.skills;
create policy skills_read_all on public.skills
  for select using (auth.role() = 'authenticated');

-- --- cv_skills -------------------------------------------------------------
drop policy if exists cv_skills_owner_all on public.cv_skills;
create policy cv_skills_owner_all on public.cv_skills
  for all using (
    exists (
      select 1 from public.cv_profile p
      where p.id = cv_skills.cv_profile_id and p.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.cv_profile p
      where p.id = cv_skills.cv_profile_id and p.user_id = auth.uid()
    )
  );

-- --- job_portal_companies ---------------------------------------------------
drop policy if exists job_portal_companies_owner_all on public.job_portal_companies;
create policy job_portal_companies_owner_all on public.job_portal_companies
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- --- job_postings ----------------------------------------------------------
drop policy if exists job_postings_owner_all on public.job_postings;
create policy job_postings_owner_all on public.job_postings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- --- child tables of job_postings ------------------------------------------
-- Each reuses the parent's ownership check rather than carrying its own
-- user_id, so a posting can never be orphaned into another user's account.

drop policy if exists job_skills_owner_all on public.job_skills;
create policy job_skills_owner_all on public.job_skills
  for all using (
    exists (
      select 1 from public.job_postings j
      where j.id = job_skills.job_posting_id and j.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.job_postings j
      where j.id = job_skills.job_posting_id and j.user_id = auth.uid()
    )
  );

drop policy if exists skill_gap_owner_all on public.skill_gap_analysis;
create policy skill_gap_owner_all on public.skill_gap_analysis
  for all using (
    exists (
      select 1 from public.job_postings j
      where j.id = skill_gap_analysis.job_posting_id and j.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.job_postings j
      where j.id = skill_gap_analysis.job_posting_id and j.user_id = auth.uid()
    )
  );

drop policy if exists application_notes_owner_all on public.application_notes;
create policy application_notes_owner_all on public.application_notes
  for all using (
    exists (
      select 1 from public.job_postings j
      where j.id = application_notes.job_posting_id and j.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.job_postings j
      where j.id = application_notes.job_posting_id and j.user_id = auth.uid()
    )
  );

drop policy if exists status_history_owner_select on public.status_history;
create policy status_history_owner_select on public.status_history
  for select using (
    exists (
      select 1 from public.job_postings j
      where j.id = status_history.job_posting_id and j.user_id = auth.uid()
    )
  );
-- No client INSERT policy: history is written by the DB trigger only, which
-- runs as the table owner and is not subject to RLS.
