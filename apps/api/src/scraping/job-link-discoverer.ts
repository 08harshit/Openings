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
  const canonicalBase = canonicalizeUrl(baseUrl);

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
    // The careers page's own self-link (including fragment-only variants
    // like "/careers#open-roles", since canonicalizeUrl strips the hash)
    // is not a "discovered job link" — it's the page we're already on.
    // Without this, a careers index page that links to itself (a common
    // "back to top" or anchor-nav pattern) would produce a fake candidate.
    if (canonical === canonicalBase) return;
    if (seen.has(canonical)) return;
    seen.add(canonical);

    results.push({ url, text });
  });

  return results.slice(0, maxLinks);
}
