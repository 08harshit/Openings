import { Logger } from '@nestjs/common';
import type { AtsType } from '@jobportal/shared';
import { stripHtml } from '../common/html.util';

/**
 * Public, unauthenticated job-board JSON APIs for the three ATS platforms
 * most startups/scaleups use. Checking these is free (no Firecrawl credits)
 * and, when a slug hits, definitive — a 200 with a job array means we've
 * found the company's real careers feed, no scraping or guessing required.
 *
 * Endpoints verified directly against each platform's public docs:
 *  - Greenhouse: https://developers.greenhouse.io/job-board.html
 *  - Lever:      https://github.com/lever/postings-api
 *  - Ashby:      https://developers.ashbyhq.com (job-board posting API)
 */

const logger = new Logger('AtsClients');

export interface AtsJobListing {
  title: string;
  url: string;
  location: string | null;
  /** yyyy-mm-dd, when the platform provides a date field. */
  postedDateIso: string | null;
  department: string | null;
  /** Plain-text job description, when the platform includes one — this is
   * what the Groq skill-gap analysis is actually scored against. */
  description: string | null;
}

export interface AtsMatch {
  atsType: AtsType;
  boardToken: string;
  jobs: AtsJobListing[];
}

/**
 * Slug candidates for a company name, cheapest/most-likely first. ATS board
 * tokens are usually the company's lowercase name with punctuation and
 * spaces stripped, sometimes hyphenated instead.
 */
export function generateSlugCandidates(companyName: string): string[] {
  const base = companyName
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|pvt|private|limited|corp|corporation|technologies|technology|labs|the)\b/g, '')
    .trim();

  const noSpaces = base.replace(/[^a-z0-9]+/g, '');
  const hyphenated = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  return [...new Set([noSpaces, hyphenated])].filter((s) => s.length >= 2);
}

/**
 * Tries Greenhouse, then Lever, then Ashby, for each candidate slug — stops
 * at the first hit. Returns null if none of the slug guesses resolve to a
 * real board (caller should fall back to search+map resolution).
 */
export async function tryAtsProviders(companyName: string): Promise<AtsMatch | null> {
  const slugs = generateSlugCandidates(companyName);

  for (const slug of slugs) {
    const greenhouse = await tryGreenhouse(slug);
    if (greenhouse) return greenhouse;
  }
  for (const slug of slugs) {
    const lever = await tryLever(slug);
    if (lever) return lever;
  }
  for (const slug of slugs) {
    const ashby = await tryAshby(slug);
    if (ashby) return ashby;
  }
  return null;
}

/** Re-fetch a previously-resolved ATS board — used on every subsequent
 * refresh once a company's ats_type/ats_board_token is already known. */
export async function fetchAtsJobs(atsType: AtsType, boardToken: string): Promise<AtsJobListing[]> {
  switch (atsType) {
    case 'greenhouse':
      return (await tryGreenhouse(boardToken))?.jobs ?? [];
    case 'lever':
      return (await tryLever(boardToken))?.jobs ?? [];
    case 'ashby':
      return (await tryAshby(boardToken))?.jobs ?? [];
  }
}

async function tryGreenhouse(slug: string): Promise<AtsMatch | null> {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    if (!res.ok) return null;

    const body = (await res.json()) as {
      jobs?: Array<{
        title?: string;
        absolute_url?: string;
        updated_at?: string;
        location?: { name?: string };
        content?: string;
        departments?: Array<{ name?: string }>;
      }>;
    };
    if (!body.jobs || body.jobs.length === 0) return null;

    const jobs: AtsJobListing[] = body.jobs
      .filter((j) => j.title && j.absolute_url)
      .map((j) => ({
        title: j.title!,
        url: j.absolute_url!,
        location: j.location?.name ?? null,
        postedDateIso: toDateOnly(j.updated_at),
        // `content=true` (which we always request) includes a real
        // `departments` array — e.g. [{name: "Sales"}] — a far stronger
        // relevance signal than parsing the title text.
        department: j.departments?.map((d) => d.name).filter(Boolean).join(', ') || null,
        description: j.content ? stripHtml(j.content) : null,
      }));

    return { atsType: 'greenhouse', boardToken: slug, jobs };
  } catch (error) {
    logger.debug(`Greenhouse check failed for "${slug}": ${describeError(error)}`);
    return null;
  }
}

async function tryLever(slug: string): Promise<AtsMatch | null> {
  try {
    const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (!res.ok) return null;

    const body = (await res.json()) as Array<{
      text?: string;
      hostedUrl?: string;
      createdAt?: number;
      categories?: { location?: string; team?: string; department?: string };
      descriptionPlain?: string;
    }>;
    if (!Array.isArray(body) || body.length === 0) return null;

    const jobs: AtsJobListing[] = body
      .filter((j) => j.text && j.hostedUrl)
      .map((j) => ({
        title: j.text!,
        url: j.hostedUrl!,
        location: j.categories?.location ?? null,
        postedDateIso: j.createdAt ? toDateOnly(new Date(j.createdAt).toISOString()) : null,
        department: j.categories?.team ?? j.categories?.department ?? null,
        description: j.descriptionPlain ?? null,
      }));

    return { atsType: 'lever', boardToken: slug, jobs };
  } catch (error) {
    logger.debug(`Lever check failed for "${slug}": ${describeError(error)}`);
    return null;
  }
}

async function tryAshby(slug: string): Promise<AtsMatch | null> {
  try {
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    if (!res.ok) return null;

    const body = (await res.json()) as {
      jobs?: Array<{
        title?: string;
        jobUrl?: string;
        location?: string;
        isRemote?: boolean;
        publishedAt?: string;
        department?: string;
        descriptionPlain?: string;
      }>;
    };
    if (!body.jobs || body.jobs.length === 0) return null;

    const jobs: AtsJobListing[] = body.jobs
      .filter((j) => j.title && j.jobUrl)
      .map((j) => ({
        title: j.title!,
        url: j.jobUrl!,
        // Ashby's isRemote flag is a clean, unambiguous signal — surface it
        // as the location string when set so downstream filtering catches it
        // without needing to parse free text.
        location: j.isRemote ? 'Remote' : (j.location ?? null),
        postedDateIso: toDateOnly(j.publishedAt),
        department: j.department ?? null,
        description: j.descriptionPlain ?? null,
      }));

    return { atsType: 'ashby', boardToken: slug, jobs };
  } catch (error) {
    logger.debug(`Ashby check failed for "${slug}": ${describeError(error)}`);
    return null;
  }
}

function toDateOnly(isoLike: string | undefined): string | null {
  if (!isoLike) return null;
  const d = new Date(isoLike);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
