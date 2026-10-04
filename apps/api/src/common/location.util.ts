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

/** A blank/whitespace-only marker never matches — `"".includes("")` is always
 * `true` in JS, which would otherwise turn one stray empty string in a
 * profile's preferred_locations into "accept every location." */
function includesMarker(haystack: string, marker: string): boolean {
  const trimmed = marker.toLowerCase();
  if (!trimmed.trim()) return false;
  return haystack.includes(trimmed);
}

/**
 * The hard gate the ingest pipeline applies: keep only a candidate's
 * preferred locations.
 *
 * A specific preferred place (e.g. "India", "Bangalore") is checked first and
 * wins outright — a listing naming both a preferred place AND a disqualified
 * remote qualifier (e.g. "Bengaluru, India; Remote - US only") is accepted on
 * the strength of the place match, since the candidate's real preference
 * ("somewhere in India") is satisfied regardless of what else the string
 * says about remote eligibility elsewhere. Only once no preferred place is
 * found does a disqualified remote mention (e.g. "Remote (US only)") get to
 * reject the listing — otherwise a bare "remote" claim would be a false
 * positive for a candidate who didn't ask for that specific remote carve-out.
 */
export function isIndiaOrRemote(
  rawLocation: string | null | undefined,
  preferredLocations: readonly string[],
): boolean {
  if (!rawLocation || !rawLocation.trim()) return false;
  const t = rawLocation.toLowerCase();

  // Specific preferred places (not the generic remote markers, which get
  // their own disqualifying-qualifier check below) win outright — a listing
  // naming both a preferred place and an unrelated remote qualifier is still
  // a real match on the place alone.
  const placeMarkers = preferredLocations.filter(
    (marker) => !REMOTE_MARKERS.includes(marker.trim().toLowerCase()),
  );
  if (placeMarkers.some((marker) => includesMarker(t, marker))) return true;

  const isRemoteMention = REMOTE_MARKERS.some((marker) => t.includes(marker));
  if (isRemoteMention && NON_INDIA_REMOTE_QUALIFIERS.some((qualifier) => t.includes(qualifier))) {
    return false;
  }

  return preferredLocations.some((marker) => includesMarker(t, marker));
}
