-- ===========================================================================
-- 0004_company_discovery.sql — auto-discovery + career-page resolution
--
-- Adds the columns IngestService needs to track company resolution:
--   - resolution_status: has this company's real careers page been found yet?
--   - ats_type / ats_board_token: when the careers page is Greenhouse/Lever/
--     Ashby, hit their public JSON API directly instead of scraping HTML.
--
-- Run in the Supabase SQL editor after 0001-0003. Idempotent.
-- ===========================================================================

alter table public.job_portal_companies
  add column if not exists resolution_status text not null default 'resolved'
    check (resolution_status in ('pending', 'resolved', 'failed')),
  add column if not exists ats_type text
    check (ats_type in ('greenhouse', 'lever', 'ashby')),
  add column if not exists ats_board_token text,
  add column if not exists resolution_attempted_at timestamptz;

-- Pinned companies (added by the user, careers_url already known) default to
-- 'resolved' via the column default above. Only auto-discovered companies
-- without a careers_url yet should start 'pending' — backfill any that exist.
update public.job_portal_companies
set resolution_status = 'pending'
where source = 'auto_discovered' and careers_url is null;

create index if not exists job_portal_companies_resolution_idx
  on public.job_portal_companies (user_id, resolution_status);

-- job_postings can now come from a company's ATS JSON feed (Greenhouse/
-- Lever/Ashby), not just a Firecrawl scrape or a manual add. Postgres won't
-- let you ALTER a CHECK constraint in place — drop and recreate it.
alter table public.job_postings drop constraint if exists job_postings_source_check;
alter table public.job_postings add constraint job_postings_source_check
  check (source in ('firecrawl_search', 'firecrawl_scrape', 'ats_api', 'manual'));

-- Discovered company names are deduped against this — the whole point of
-- "resolve once" is a fast, cheap lookup by normalised name.
comment on column public.job_portal_companies.resolution_status is
  'pending = discovered, not yet resolved. resolved = careers_url known and '
  'usable. failed = resolution was attempted and found nothing usable; not '
  'retried automatically.';
