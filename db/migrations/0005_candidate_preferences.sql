-- ===========================================================================
-- 0005_candidate_preferences.sql — structured candidate targeting preferences
--
-- Replaces the hardcoded RELEVANT_TITLE_MARKERS / OFF_TARGET_TITLE_MARKERS /
-- NON_ENGINEERING_DEPARTMENTS / INDIA_PLACE_MARKERS / REMOTE_MARKERS constants
-- in apps/api/src/common/{text,location}.util.ts with user-editable profile
-- fields. See docs/superpowers/specs/2026-10-04-candidate-profile-design.md.
--
-- target_roles / excluded_roles / excluded_departments / preferred_locations /
-- excluded_companies are consumed immediately by the ingest pipeline.
-- seniority_min_years / seniority_max_years / work_modes / employment_types /
-- domain_preferences / domain_exclusions are stored now (matching the parent
-- spec's full CandidateProfile model) but have no consumer yet — a later
-- sub-project wires them into eligibility/reranking.
--
-- Idempotent: safe to re-run. Existing rows get the column defaults ('[]' /
-- null), never backfilled with DEFAULT_CV's seed values — only a brand-new
-- profile (CvService.bootstrap()) gets those.
-- ===========================================================================

alter table public.cv_profile
  add column if not exists target_roles jsonb not null default '[]'::jsonb,
  add column if not exists excluded_roles jsonb not null default '[]'::jsonb,
  add column if not exists excluded_departments jsonb not null default '[]'::jsonb,
  add column if not exists preferred_locations jsonb not null default '[]'::jsonb,
  add column if not exists excluded_companies jsonb not null default '[]'::jsonb,
  add column if not exists seniority_min_years numeric(4, 1),
  add column if not exists seniority_max_years numeric(4, 1),
  add column if not exists work_modes jsonb not null default '[]'::jsonb,
  add column if not exists employment_types jsonb not null default '[]'::jsonb,
  add column if not exists domain_preferences jsonb not null default '[]'::jsonb,
  add column if not exists domain_exclusions jsonb not null default '[]'::jsonb;

comment on column public.cv_profile.target_roles is
  'Role-title keywords this candidate targets, e.g. ["backend", "full stack"]. Replaces the old RELEVANT_TITLE_MARKERS constant.';
comment on column public.cv_profile.excluded_roles is
  'Role-title keywords that disqualify a posting even if otherwise relevant. Replaces OFF_TARGET_TITLE_MARKERS.';
comment on column public.cv_profile.excluded_departments is
  'ATS department names that disqualify a posting. Replaces NON_ENGINEERING_DEPARTMENTS.';
comment on column public.cv_profile.preferred_locations is
  'Location keywords (place names and/or remote markers) this candidate accepts. Replaces INDIA_PLACE_MARKERS + REMOTE_MARKERS.';
comment on column public.cv_profile.excluded_companies is
  'Company names never to discover/scrape for this candidate.';
comment on column public.cv_profile.seniority_min_years is
  'Minimum years of experience the candidate wants a posting to require. Not yet consumed by ingest filtering.';
comment on column public.cv_profile.seniority_max_years is
  'Maximum years of experience the candidate wants a posting to require. Not yet consumed by ingest filtering.';
comment on column public.cv_profile.work_modes is
  'Accepted work arrangements, e.g. ["remote", "hybrid"]. Not yet consumed by ingest filtering.';
comment on column public.cv_profile.employment_types is
  'Accepted employment types, e.g. ["full-time", "contract"]. Not yet consumed by ingest filtering.';
comment on column public.cv_profile.domain_preferences is
  'Preferred industry/domain keywords. Not yet consumed by ingest filtering.';
comment on column public.cv_profile.domain_exclusions is
  'Disqualifying industry/domain keywords. Not yet consumed by ingest filtering.';
