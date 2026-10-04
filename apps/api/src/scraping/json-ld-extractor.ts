import { Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { stripHtml } from '../common/html.util';
import { parsePostedDate, toDateOnlyIso } from '../common/date.util';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

const logger = new Logger('JsonLdJobExtractor');

interface JsonLdJobPosting {
  '@type'?: string | string[];
  title?: string;
  name?: string;
  description?: string;
  datePosted?: string;
  hiringOrganization?: { name?: string } | string;
  jobLocation?: { address?: { addressLocality?: string } } | string;
}

function isJobPostingType(type: string | string[] | undefined): boolean {
  if (!type) return false;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => t.toLowerCase() === 'jobposting');
}

function locationFromJsonLd(jobLocation: JsonLdJobPosting['jobLocation']): string | null {
  if (!jobLocation) return null;
  if (typeof jobLocation === 'string') return jobLocation;
  return jobLocation.address?.addressLocality ?? null;
}

function organizationNameFromJsonLd(org: JsonLdJobPosting['hiringOrganization']): string | null {
  if (!org) return null;
  if (typeof org === 'string') return org;
  return org.name ?? null;
}

/**
 * `parsePostedDate` builds its Date from local calendar fields (new Date(y, m, d)),
 * and `toDateOnlyIso` reads it back via `toISOString()`, which is UTC. In any
 * timezone ahead of UTC that round-trip shifts the date back by one day (e.g.
 * "2026-09-15" parsed in IST becomes "2026-09-14"). JSON-LD `datePosted` is a
 * plain calendar date with no time-of-day semantics, so re-anchor to UTC noon
 * before formatting — safe for any timezone from UTC-12 to UTC+12, and avoids
 * touching the shared date.util.ts (used elsewhere with its existing behavior).
 */
function toDateOnlyIsoStable(date: Date): string {
  const noonUtc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12));
  return toDateOnlyIso(noonUtc);
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

      const title = block.title ?? block.name;
      if (!title) continue;

      const descriptionHtml = block.description ?? '';
      const description = stripHtml(descriptionHtml);
      const postedDate = block.datePosted ? parsePostedDate(block.datePosted) : null;

      return {
        title,
        url: sourceUrl,
        companyNameHint: organizationNameFromJsonLd(block.hiringOrganization),
        locationHint: locationFromJsonLd(block.jobLocation),
        snippet: description.slice(0, 2000),
        markdown: description || null,
        source: 'http_scrape',
        postedDateIso: postedDate ? toDateOnlyIsoStable(postedDate) : null,
      };
    }
  }

  return null;
}
