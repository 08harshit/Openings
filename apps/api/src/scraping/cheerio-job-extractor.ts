import * as cheerio from 'cheerio';
import { extractLocation } from '../common/text.util';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

const MIN_TITLE_LENGTH = 3;
const MIN_DESCRIPTION_LENGTH = 100;

/**
 * Minimal, deliberately generic fallback for pages with no JSON-LD: title
 * from the first non-empty h1 (falling back to <title>), description from
 * the first non-empty main/article/[role="main"]. No site-specific
 * selectors — a page that doesn't fit this shape returns null (too little
 * signal), not a low-quality guess, and the caller falls through to the
 * Firecrawl fallback instead.
 */
export function extractGenericJobPosting(html: string, sourceUrl: string): RawJobCandidate | null {
  const $ = cheerio.load(html);

  const h1Text = $('h1').first().text().trim();
  const titleTagText = $('title').first().text().trim();
  const title = h1Text || titleTagText;

  if (!title || title.length < MIN_TITLE_LENGTH) return null;

  const contentSelectors = ['main', 'article', '[role="main"]'];
  let description = '';
  for (const selector of contentSelectors) {
    const text = $(selector).first().text().replace(/\s+/g, ' ').trim();
    if (text.length > description.length) description = text;
  }

  if (description.length < MIN_DESCRIPTION_LENGTH) return null;

  return {
    title,
    url: sourceUrl,
    companyNameHint: null,
    locationHint: extractLocation(description),
    snippet: description.slice(0, 2000),
    markdown: description,
    source: 'http_scrape',
    postedDateIso: null,
  };
}
