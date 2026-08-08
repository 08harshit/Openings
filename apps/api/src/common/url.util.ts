import { createHash } from 'node:crypto';

/**
 * Tracking and session parameters that identify *how you arrived* at a posting
 * rather than *which posting it is*. Stripping these is what makes the same job,
 * linked from a newsletter and from a search result, collapse to one row.
 */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'msclkid',
  'ref',
  'referer',
  'referrer',
  'source',
  'src',
  'trk',
  'trkinfo',
  'origin',
  'originalsubdomain',
  'position',
  'pagenum',
  'refid',
  'sessionid',
  'session_id',
  '_ga',
  '_gl',
  'mc_cid',
  'mc_eid',
  'hl',
]);

/**
 * Reduce a URL to a stable identity:
 *  - force https, lowercase host, drop `www.`
 *  - drop the fragment and any tracking params
 *  - sort the surviving params so ordering can't create a false duplicate
 *  - drop a trailing slash
 *
 * Returns the input untouched if it isn't parseable — a weird URL is still a
 * usable dedup key as long as we're consistent about it.
 */
export function canonicalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  let url: URL;
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return trimmed.toLowerCase();
  }

  url.protocol = 'https:';
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');

  const kept: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) kept.push([key, value]);
  });
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);

  let out = url.toString();
  // Keep "https://host/" as-is; only strip a trailing slash from real paths.
  if (out.endsWith('/') && url.pathname !== '/') out = out.slice(0, -1);
  return out;
}

/** Stable dedup key stored in `job_postings.url_hash`. */
export function urlHash(input: string): string {
  return createHash('md5').update(canonicalizeUrl(input)).digest('hex');
}

/** `https://boards.greenhouse.io/acme/jobs/123` -> `boards.greenhouse.io` */
export function hostnameOf(input: string): string {
  try {
    return new URL(input.startsWith('http') ? input : `https://${input}`).hostname
      .toLowerCase()
      .replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Job boards and ATS platforms. A posting on one of these has no single owning
 * company, so we don't try to create a `companies` row from the domain — the
 * company name comes from the listing text instead.
 */
const AGGREGATOR_HOSTS = [
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'naukri.com',
  'monster.com',
  'ziprecruiter.com',
  'dice.com',
  'wellfound.com',
  'angel.co',
  'remoteok.com',
  'weworkremotely.com',
  'remotive.com',
  'builtin.com',
  'otta.com',
  'hired.com',
  'instahyre.com',
  'cutshort.io',
  'hirist.com',
  'foundit.in',
  'shine.com',
  'timesjobs.com',
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'workable.com',
  'smartrecruiters.com',
  'jobvite.com',
  'bamboohr.com',
  'recruitee.com',
  'teamtailor.com',
  'workday.com',
  'myworkdayjobs.com',
  'icims.com',
  'taleo.net',
  'successfactors.com',
  'jobs.google.com',
  'google.com',
  // Discovered live from a real ingestion run — startup lists, remote-jobs
  // boards, and forums that surface a specific listing's URL but represent
  // no single employer. Community/ecosystem job boards (e.g. jobs.nestjs.com)
  // are blocked by their apex domain since the ecosystem itself is never a
  // hiring company.
  'reddit.com',
  'nestjs.com',
  'ambitionbox.com',
  'himalayas.app',
  'ycombinator.com',
  'topstartups.io',
  'remoterocketship.com',
  'jobsinjs.com',
  'jobleads.com',
  'justjoin.it',
  'wearedevelopers.com',
  'codingjobboard.com',
  'seek.com',
  'workingnomads.com',
  'startup.jobs',
  'eurotechjobs.com',
  'clearancejobs.com',
  'jobio.co.il',
  'unjobnet.org',
  'remotefront.com',
  'jobxdubai.com',
  'jobgether.com',
  'bebee.com',
  'geekhunter.com',
  'simplify.jobs',
  // Generic app-hosting platforms — a real company's careers page is never a
  // raw subdomain on one of these; what shows up here is always a
  // hobby-hosted job-listing aggregator, not a company's own site.
  'up.railway.app',
  'herokuapp.com',
  'vercel.app',
  'netlify.app',
  'github.io',
];

export function isAggregatorHost(host: string): boolean {
  if (!host) return false;
  return AGGREGATOR_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

/**
 * Reference/social/media hosts that can rank highly for a "<Company> official
 * website" search without being the company's own site — a Wikipedia page or
 * a news article about a company is not a domain to resolve as their careers
 * page source.
 */
const INFORMATIONAL_HOSTS = [
  'wikipedia.org',
  'crunchbase.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'medium.com',
  'bloomberg.com',
  'techcrunch.com',
  'reuters.com',
  'forbes.com',
  'businessinsider.com',
  'yourstory.com',
  'inc42.com',
  'economictimes.indiatimes.com',
  'moneycontrol.com',
  'wellfound.com',
  'pitchbook.com',
  'owler.com',
  'zaubacorp.com',
  'tofler.in',
];

export function isNonCompanyHost(host: string): boolean {
  if (!host) return true;
  if (isAggregatorHost(host)) return true;
  return INFORMATIONAL_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

/**
 * Best-effort company name from a career-site hostname:
 * `careers.acme-corp.com` -> `Acme Corp`. Returns null for aggregators and for
 * hosts that produce a meaningless name.
 */
export function companyNameFromHost(host: string): string | null {
  if (!host || isAggregatorHost(host)) return null;

  const parts = host.split('.').filter(Boolean);
  // Drop common career-site subdomains and the TLD(s).
  const noise = new Set(['careers', 'jobs', 'job', 'apply', 'work', 'talent', 'hire', 'boards']);
  const meaningful = parts.filter((p, i) => !(i === 0 && noise.has(p)));
  if (meaningful.length < 2) return null;

  const base = meaningful[0];
  if (!base || base.length < 2) return null;

  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
