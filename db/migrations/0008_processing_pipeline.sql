-- ===========================================================================
-- 0008_processing_pipeline.sql — retrieval score, ATS job IDs, location-aware
-- dedup, and the excluded_roles trim. See
-- docs/superpowers/specs/2026-10-05-processing-pipeline-design.md §12.
--
-- Idempotent. Apply in the Supabase SQL Editor BEFORE deploying the code that
-- writes retrieval_score/external_id (Render auto-deploys main).
-- ===========================================================================

alter table public.job_postings
  add column if not exists external_id text,
  add column if not exists retrieval_score integer check (retrieval_score between 0 and 100),
  add column if not exists retrieval_signals jsonb,
  add column if not exists location_normalized text generated always as (lower(btrim(location))) stored;

-- The old key merged "Backend Engineer — Bangalore" and "— Pune" into one
-- row. The replacement is strictly finer, so every existing row stays unique.
drop index if exists public.job_postings_user_company_title_key;
create unique index if not exists job_postings_user_company_title_location_key
  on public.job_postings (user_id, company_id, title_normalized, coalesce(location_normalized, ''))
  where company_id is not null;

create unique index if not exists job_postings_user_company_external_id_key
  on public.job_postings (user_id, company_id, external_id)
  where external_id is not null and company_id is not null;

create index if not exists job_postings_retrieval_score_idx
  on public.job_postings (user_id, retrieval_score desc);

-- Adjacent engineering roles now reach scoring instead of being hard-rejected.
update public.cv_profile
set excluded_roles = coalesce((
  select jsonb_agg(r)
  from jsonb_array_elements_text(excluded_roles) as r
  where r not in ('platform engineer', 'devops engineer', 'site reliability',
                  'data engineer', 'security engineer', 'solutions engineer',
                  'ml engineer', 'machine learning engineer', 'ai engineer')
), '[]'::jsonb);

-- Postgres only allows appending columns to a view, so the three new ones go last.
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
  coalesce(h.last_status_change_at, j.created_at) as last_status_change_at,
  j.external_id,
  j.retrieval_score,
  j.retrieval_signals
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

alter view public.job_postings_enriched set (security_invoker = true);
