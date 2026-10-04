import { Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { stripHtml } from '../common/html.util';
import { parsePostedDate, toDateOnlyIso } from '../common/date.util';
import { extractLocation } from '../common/text.util';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

const logger = new Logger('JsonLdJobExtractor');

interface JsonLdAddress {
  addressLocality?: string;
  addressRegion?: string;
  addressCountry?: string;
}

interface JsonLdPlace {
  address?: JsonLdAddress;
}

interface JsonLdJobPosting {
  '@type'?: string | string[];
  title?: string;
  name?: string;
  description?: string;
  datePosted?: string;
  hiringOrganization?: { name?: string } | string;
  jobLocation?: JsonLdPlace | JsonLdPlace[] | string;
  jobLocationType?: string;
}

function isJobPostingType(type: string | string[] | undefined): boolean {
  if (!type) return false;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting');
}

/** One jobLocation entry's best available locality signal: addressLocality,
 * falling back to addressRegion, then addressCountry — real-world emitters
 * commonly omit the city and only give a state/country. */
function localityFromPlace(place: JsonLdPlace | string): string | null {
  if (typeof place === 'string') return place;
  const address = place?.address;
  if (!address) return null;
  return address.addressLocality ?? address.addressRegion ?? address.addressCountry ?? null;
}

/**
 * Extracts a location hint from a JSON-LD JobPosting block, handling the
 * real-world shapes beyond a single string or a plain addressLocality:
 *  - `jobLocation` as an array (multi-city roles) — joins each entry's
 *    locality/region/country signal.
 *  - `address` with only `addressRegion`/`addressCountry` (no
 *    `addressLocality`).
 *  - `jobLocationType: "TELECOMMUTE"` (case-insensitive) mapped to 'Remote'
 *    when no other location signal is present — common for fully-remote
 *    roles that carry no `jobLocation` at all.
 * Returns null (not a final fallback) when none of the above yields a
 * signal — the caller falls back to `extractLocation()` against the
 * description text, same as the generic extractor already does.
 */
function locationFromJsonLd(
  jobLocation: JsonLdJobPosting['jobLocation'],
  jobLocationType: JsonLdJobPosting['jobLocationType'],
): string | null {
  if (jobLocation) {
    if (Array.isArray(jobLocation)) {
      const localities = jobLocation.map(localityFromPlace).filter((l): l is string => Boolean(l));
      if (localities.length > 0) return [...new Set(localities)].join(', ');
    } else {
      const locality = localityFromPlace(jobLocation);
      if (locality) return locality;
    }
  }

  if (typeof jobLocationType === 'string' && jobLocationType.toLowerCase().includes('telecommute')) {
    return 'Remote';
  }

  return null;
}

function organizationNameFromJsonLd(org: JsonLdJobPosting['hiringOrganization']): string | null {
  if (!org) return null;
  if (typeof org === 'string') return org;
  return org.name ?? null;
}

/**
 * Looks for a <script type="application/ld+json"> block whose @type is
 * JobPosting (https://schema.org/JobPosting) and maps it onto the app's
 * normalised RawJobCandidate shape. A career page commonly carries several
 * JSON-LD blocks (Organization, BreadcrumbList, JobPosting) — every script
 * tag is tried, in document order, and the first JobPosting match wins.
 * A malformed block (invalid JSON) is skipped, not fatal to the rest.
 */
export function extractJsonLdJobPosting(html: string, sourceUrl: string): RawJobCandidate | null {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]');

  for (let i = 0; i < scripts.length; i++) {
    const raw = $(scripts[i]).text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.debug(`Skipping malformed JSON-LD block on ${sourceUrl}`);
      continue;
    }

    const candidates: JsonLdJobPosting[] = Array.isArray((parsed as { '@graph'?: unknown })?.['@graph'])
      ? ((parsed as { '@graph': JsonLdJobPosting[] })['@graph'])
      : [parsed as JsonLdJobPosting];

    for (const block of candidates) {
      if (!block || typeof block !== 'object' || !isJobPostingType(block['@type'])) continue;

      // A non-string title/name is treated the same as "absent" — skip this
      // block rather than throwing or passing an unvalidated value through.
      const rawTitle = block.title ?? block.name;
      if (typeof rawTitle !== 'string' || !rawTitle) continue;
      const title = rawTitle;

      const descriptionHtml = typeof block.description === 'string' ? block.description : '';
      const description = stripHtml(descriptionHtml);
      const postedDate =
        typeof block.datePosted === 'string' ? parsePostedDate(block.datePosted) : null;

      // Final fallback: if the JSON-LD block itself carries no location
      // signal at all (no jobLocation, no recognised jobLocationType), try
      // the same free-text location extraction the generic Cheerio
      // extractor already applies, against the stripped description.
      const locationHint =
        locationFromJsonLd(block.jobLocation, block.jobLocationType) ?? extractLocation(description);

      return {
        title,
        url: sourceUrl,
        companyNameHint: organizationNameFromJsonLd(block.hiringOrganization),
        locationHint,
        snippet: description.slice(0, 2000),
        markdown: description || null,
        source: 'http_scrape',
        postedDateIso: postedDate ? toDateOnlyIso(postedDate) : null,
      };
    }
  }

  return null;
}
