/**
 * India-or-Remote location gate. Applied after location extraction, on every
 * candidate before it's ever inserted — a candidate with no recognisable
 * location signal is rejected outright (favours precision: only fetching
 * companies' own postings already cuts noise a lot, but "relevant" also
 * means "somewhere I can actually take," per the plan's explicit call).
 */

const INDIA_PLACE_MARKERS = [
  'india',
  // Metro areas / major tech hubs, including common alternate spellings.
  'bangalore', 'bengaluru',
  'mumbai', 'bombay',
  'delhi', 'new delhi', 'ncr',
  'gurgaon', 'gurugram',
  'noida',
  'pune',
  'hyderabad',
  'chennai', 'madras',
  'kolkata', 'calcutta',
  'ahmedabad',
  'kochi', 'cochin',
  'coimbatore',
  'jaipur',
  'chandigarh',
  'indore',
  'thane',
  'navi mumbai',
  // ISO/common country-code forms as they appear in structured ATS location fields.
  ' in)', '(in)', ', in',
];

const REMOTE_MARKERS = [
  'remote',
  'work from home',
  'wfh',
  'anywhere',
  'distributed team',
  'fully distributed',
];

/**
 * Markers that indicate a *specific non-India* place, used to catch cases
 * like "Remote (US only)" or "Remote - EU" where "remote" alone would be a
 * false positive for this app's purposes.
 */
const NON_INDIA_REMOTE_QUALIFIERS = [
  'us only', 'usa only', 'u.s. only', 'united states only',
  'eu only', 'europe only', 'emea only',
  'uk only', 'united kingdom only',
  'canada only',
  'latam only', 'latin america only',
  'apac only',
];

export type LocationClass = 'india' | 'remote' | 'other' | 'unknown';

export function classifyLocation(rawLocation: string | null | undefined): LocationClass {
  if (!rawLocation || !rawLocation.trim()) return 'unknown';
  const t = rawLocation.toLowerCase();

  if (INDIA_PLACE_MARKERS.some((marker) => t.includes(marker))) return 'india';

  if (REMOTE_MARKERS.some((marker) => t.includes(marker))) {
    if (NON_INDIA_REMOTE_QUALIFIERS.some((qualifier) => t.includes(qualifier))) return 'other';
    return 'remote';
  }

  return 'other';
}

/** The hard gate the ingest pipeline applies: keep only India or Remote. */
export function isIndiaOrRemote(rawLocation: string | null | undefined): boolean {
  const cls = classifyLocation(rawLocation);
  return cls === 'india' || cls === 'remote';
}
