import { Logger } from '@nestjs/common';
import { fetchPage } from './http-page-fetcher';
import { extractJsonLdJobPosting } from './json-ld-extractor';
import { extractGenericJobPosting } from './cheerio-job-extractor';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

const logger = new Logger('JobExtractor');

/**
 * Fetches one candidate job-posting URL and tries JSON-LD extraction first
 * (structured, higher confidence), falling back to the generic Cheerio
 * extractor if no JobPosting schema is present. Returns null if the page
 * can't be fetched or neither strategy finds enough signal — the caller
 * (CareerPageScraper) simply drops that URL, it does not retry with a
 * different strategy.
 *
 * The extraction call is wrapped in try/catch as defense-in-depth: both
 * extractors already guard against the malformed-JSON-LD shapes they know
 * about, but an unanticipated future throw in either one must still degrade
 * to "drop this one link" rather than rejecting the whole `scrapeCareerPage`
 * call for the company — which would skip the Firecrawl fallback entirely
 * (see M1 in the final branch review).
 */
export async function extractJob(url: string, timeoutMs: number): Promise<RawJobCandidate | null> {
  const page = await fetchPage(url, timeoutMs);
  if (!page) return null;

  try {
    return extractJsonLdJobPosting(page.html, url) ?? extractGenericJobPosting(page.html, url);
  } catch (error) {
    logger.warn(
      `Extraction threw for ${url}, dropping this link: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }
}
