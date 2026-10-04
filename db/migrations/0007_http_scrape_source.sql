-- ===========================================================================
-- 0007_http_scrape_source.sql — allow 'http_scrape' as a job_postings.source
--
-- The new local HTTP/JSON-LD/Cheerio scraper (apps/api/src/scraping/) can
-- now produce job candidates directly, without Firecrawl. See
-- docs/superpowers/specs/2026-10-04-scraper-replacement-design.md.
--
-- Postgres won't let you ALTER a CHECK constraint in place — drop and
-- recreate it, same pattern as 0004_company_discovery.sql's addition of
-- 'ats_api'.
-- ===========================================================================

alter table public.job_postings drop constraint if exists job_postings_source_check;
alter table public.job_postings add constraint job_postings_source_check
  check (source in ('firecrawl_search', 'firecrawl_scrape', 'ats_api', 'http_scrape', 'manual'));
