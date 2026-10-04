import { fetchPage } from './http-page-fetcher';
import { extractJsonLdJobPosting } from './json-ld-extractor';
import { extractGenericJobPosting } from './cheerio-job-extractor';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

/**
 * Fetches one candidate job-posting URL and tries JSON-LD extraction first
 * (structured, higher confidence), falling back to the generic Cheerio
 * extractor if no JobPosting schema is present. Returns null if the page
 * can't be fetched or neither strategy finds enough signal — the caller
 * (CareerPageScraper) simply drops that URL, it does not retry with a
 * different strategy.
 */
export async function extractJob(url: string, timeoutMs: number): Promise<RawJobCandidate | null> {
  const page = await fetchPage(url, timeoutMs);
  if (!page) return null;

  return extractJsonLdJobPosting(page.html, url) ?? extractGenericJobPosting(page.html, url);
}
