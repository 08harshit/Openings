import { fetchPage } from './http-page-fetcher';
import { discoverJobLinks } from './job-link-discoverer';
import { extractJob } from './job-extractor';
import { mapWithConcurrency } from '../common/async.util';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

export interface CareerPageScraperOptions {
  timeoutMs: number;
  maxLinks: number;
  concurrency: number;
}

/**
 * Local, non-Firecrawl path for a custom (non-ATS) career page: fetch the
 * page, find links that look like individual job postings, extract each one
 * (bounded concurrency). Returns [] — never throws — if the page can't be
 * fetched or no job-shaped links are found; that [] is exactly the signal
 * IngestService.scrapeCustomCareerPage() uses to fall back to Firecrawl.
 */
export async function scrapeCareerPage(
  careersUrl: string,
  options: CareerPageScraperOptions,
): Promise<RawJobCandidate[]> {
  const page = await fetchPage(careersUrl, options.timeoutMs);
  if (!page) return [];

  const links = discoverJobLinks(page.html, careersUrl, options.maxLinks);
  if (links.length === 0) return [];

  const results = await mapWithConcurrency(links, options.concurrency, (link) =>
    extractJob(link.url, options.timeoutMs),
  );

  return results.filter((r): r is RawJobCandidate => r !== null);
}
