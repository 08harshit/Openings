import * as cheerio from 'cheerio';
import { looksLikeJobPosting } from '../common/text.util';
import { canonicalizeUrl } from '../common/url.util';

export interface DiscoveredLink {
  url: string;
  text: string;
}

/**
 * Pulls every <a href> off a career page, resolves relative URLs against the
 * page's own URL, and keeps only the ones that look like an individual job
 * posting — reusing the same `looksLikeJobPosting()` heuristic the rest of
 * the ingest pipeline already relies on (see ats-clients.ts/text.util.ts),
 * rather than inventing a second one.
 */
export function discoverJobLinks(html: string, baseUrl: string, maxLinks: number): DiscoveredLink[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const results: DiscoveredLink[] = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      return; // unparseable href (e.g. "javascript:void(0)") — skip
    }

    const url = resolved.toString();
    const text = $(el).text().trim();

    if (!looksLikeJobPosting(text, url)) return;

    const canonical = canonicalizeUrl(url);
    if (seen.has(canonical)) return;
    seen.add(canonical);

    results.push({ url, text });
  });

  return results.slice(0, maxLinks);
}
