/**
 * India-or-Remote location gate. Applied after location extraction, on every
 * candidate before it's ever inserted — a candidate with no recognisable
 * location signal is rejected outright (favours precision: only fetching
 * companies' own postings already cuts noise a lot, but "relevant" also
 * means "somewhere I can actually take," per the candidate's preferences).
 *
 * `preferredLocations` comes from the candidate's profile (CvProfile in
 * packages/shared) — a flat list mixing place names ("india", "bangalore")
 * and remote markers ("remote", "wfh"). This function no longer hardcodes
 * them, so an empty list means "nothing is acceptable," not "everything is."
 */

/**
 * Markers that indicate a *specific non-preferred* place, used to catch
 * cases like "Remote (US only)" or "Remote - EU" where "remote" alone would
 * be a false positive for a candidate targeting India/Remote. This is a
 * structural pattern (a qualifier that narrows "remote" to a place the
 * candidate didn't ask for), not a candidate preference, so it stays
 * hardcoded rather than moving onto the profile.
 */
const NON_INDIA_REMOTE_QUALIFIERS = [
  'us only', 'usa only', 'u.s. only', 'united states only',
  'eu only', 'europe only', 'emea only',
  'uk only', 'united kingdom only',
  'canada only',
  'latam only', 'latin america only',
  'apac only',
];

const REMOTE_MARKERS = [
  'remote',
  'work from home',
  'wfh',
  'anywhere',
  'distributed team',
  'fully distributed',
];

/** The hard gate the ingest pipeline applies: keep only a candidate's preferred locations. */
export function isIndiaOrRemote(
  rawLocation: string | null | undefined,
  preferredLocations: readonly string[],
): boolean {
  if (!rawLocation || !rawLocation.trim()) return false;
  const t = rawLocation.toLowerCase();

  const isRemoteMention = REMOTE_MARKERS.some((marker) => t.includes(marker));
  if (isRemoteMention && NON_INDIA_REMOTE_QUALIFIERS.some((qualifier) => t.includes(qualifier))) {
    return false;
  }

  return preferredLocations.some((marker) => t.includes(marker.toLowerCase()));
}
