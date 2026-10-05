-- ===========================================================================
-- 0009_final_ranking.sql — multi-dimensional LLM evaluation + deterministic
-- final score. See docs/superpowers/specs/2026-10-05-reranking-final-ranking-design.md §7.
--
-- Idempotent. Apply in the Supabase SQL Editor BEFORE deploying the code that
-- writes final_score/llm_score (Render auto-deploys main).
-- ===========================================================================

alter table public.skill_gap_analysis
  add column if not exists llm_score integer check (llm_score between 0 and 100),
  add column if not exists confidence integer check (confidence between 0 and 100),
  add column if not exists critical_mismatch boolean,
  add column if not exists critical_gaps jsonb,
  add column if not exists role_fit integer check (role_fit between 0 and 100),
  add column if not exists seniority_fit integer check (seniority_fit between 0 and 100),
  add column if not exists required_skill_fit integer check (required_skill_fit between 0 and 100),
  add column if not exists preferred_skill_fit integer check (preferred_skill_fit between 0 and 100),
  add column if not exists experience_fit integer check (experience_fit between 0 and 100),
  add column if not exists domain_fit integer check (domain_fit between 0 and 100);

alter table public.job_postings
  add column if not exists final_score integer check (final_score between 0 and 100),
  add column if not exists recommendation text,
  add column if not exists preference_score integer check (preference_score between 0 and 100);

create index if not exists job_postings_final_score_idx
  on public.job_postings (user_id, final_score desc);

-- Postgres only allows appending columns to a view, so the new ones go last.
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
  j.retrieval_signals,
  j.final_score,
  j.recommendation,
  j.preference_score,
  a.llm_score,
  a.confidence,
  a.critical_mismatch,
  coalesce(a.critical_gaps, '[]'::jsonb)          as critical_gaps,
  a.role_fit,
  a.seniority_fit,
  a.required_skill_fit,
  a.preferred_skill_fit,
  a.experience_fit,
  a.domain_fit
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
