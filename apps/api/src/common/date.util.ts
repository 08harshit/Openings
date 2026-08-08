/**
 * Extracts a posting date from free-text scraped from job boards — search
 * snippets, listing markdown, career-page content. Sources are messy and
 * inconsistent (LinkedIn's "3d ago", Indeed's "Posted 2 days ago", a plain
 * "August 3, 2026", ISO dates), so this covers the common shapes rather than
 * being exhaustive. Returns null when nothing recognisable is found — callers
 * treat "unknown" as "don't reject it", since a missing signal isn't evidence
 * of staleness.
 */

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

export function parsePostedDate(text: string, reference: Date = new Date()): Date | null {
  if (!text) return null;
  const t = text.toLowerCase();

  // "just posted" / "just now" / "posted today" / "today"
  if (/\b(just posted|just now|posted today|active today)\b/.test(t)) {
    return new Date(reference);
  }
  if (/\btoday\b/.test(t) && !/\btoday\s*[-–]\s*\d/.test(t)) {
    return new Date(reference);
  }
  if (/\byesterday\b/.test(t)) {
    return addDays(reference, -1);
  }

  // "3 hours ago", "45 minutes ago" — same calendar-relevance as "today".
  const hoursAgo = t.match(/\b(\d+)\s*(?:hours?|hrs?|h)\s*ago\b/);
  if (hoursAgo) return addHours(reference, -Number(hoursAgo[1]));

  const minutesAgo = t.match(/\b(\d+)\s*(?:minutes?|mins?)\s*ago\b/);
  if (minutesAgo) return new Date(reference);

  // "2 days ago", "5d ago", "posted 3 days ago", "active 2d ago"
  const daysAgo = t.match(/\b(\d+)\s*(?:days?|d)\s*ago\b/);
  if (daysAgo) return addDays(reference, -Number(daysAgo[1]));

  // Bare "3d" / "2 days" shorthand some boards use without "ago"
  const bareDays = t.match(/\bposted\s+(\d+)\s*(?:days?|d)\b(?!\s*ago)/);
  if (bareDays) return addDays(reference, -Number(bareDays[1]));

  const weeksAgo = t.match(/\b(\d+)\s*(?:weeks?|w)\s*ago\b/);
  if (weeksAgo) return addDays(reference, -Number(weeksAgo[1]) * 7);

  const monthsAgo = t.match(/\b(\d+)\s*(?:months?|mo)\s*ago\b/);
  if (monthsAgo) return addDays(reference, -Number(monthsAgo[1]) * 30);

  // ISO date: 2026-08-03
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (isValidDate(d)) return d;
  }

  // US slash date: 8/3/2026 or 08/03/2026
  const slash = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slash) {
    const d = new Date(Number(slash[3]), Number(slash[1]) - 1, Number(slash[2]));
    if (isValidDate(d)) return d;
  }

  // "August 3, 2026" / "Aug 3 2026" / "3 August 2026"
  const monthName = t.match(
    /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/,
  );
  if (monthName && MONTHS[monthName[1]] !== undefined) {
    const d = new Date(Number(monthName[3]), MONTHS[monthName[1]], Number(monthName[2]));
    if (isValidDate(d)) return d;
  }
  const dayFirstMonthName = t.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})\b/,
  );
  if (dayFirstMonthName && MONTHS[dayFirstMonthName[2]] !== undefined) {
    const d = new Date(
      Number(dayFirstMonthName[3]),
      MONTHS[dayFirstMonthName[2]],
      Number(dayFirstMonthName[1]),
    );
    if (isValidDate(d)) return d;
  }

  return null;
}

/** Age in whole days (>= 0). Dates in the future clamp to 0 rather than negative. */
export function ageInDays(date: Date, reference: Date = new Date()): number {
  const diffMs = reference.getTime() - date.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

/** yyyy-mm-dd for storage in job_postings.posted_date. */
export function toDateOnlyIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addHours(date: Date, hours: number): Date {
  const d = new Date(date);
  d.setHours(d.getHours() + hours);
  return d;
}

function isValidDate(d: Date): boolean {
  return !Number.isNaN(d.getTime());
}
