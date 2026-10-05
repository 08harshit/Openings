import { SEED_SKILLS } from '@jobportal/shared';
import { normalizeWhitespace } from '../common/text.util';
import { urlHash } from '../common/url.util';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

/** A scraped candidate plus the company it was scraped from. */
export interface ScopedCandidate {
  candidate: RawJobCandidate;
  companyId: string;
  companyName: string;
}

/** A candidate parsed once, so eligibility and scoring never re-parse text. */
export interface NormalizedJob {
  candidate: RawJobCandidate;
  companyId: string;
  companyName: string;
  title: string;
  description: string;
  location: string | null;
  isRemote: boolean;
  requiredYearsMin: number | null;
  mentionedSkills: string[];
  externalId: string | null;
  department: string | null;
  urlHash: string;
}

const YEARS_SCAN_LIMIT = 4000;
const MAX_PLAUSIBLE_YEARS = 20;
const REMOTE_SCAN_LIMIT = 1500;
const UNIT = '(?:years?|yrs?)';

// Order matters: ranges claim their whole span first so the upper bound of
// "2-4 years" is never re-read as a standalone "4 years".
const YEARS_PATTERNS: RegExp[] = [
  new RegExp(`\\b(\\d{1,2})\\s*(?:-|–|—|to)\\s*(\\d{1,2})\\s*\\+?\\s*${UNIT}\\b`, 'g'),
  new RegExp(`\\b(?:minimum(?:\\s+of)?|at\\s+least)\\s+(\\d{1,2})\\s*\\+?\\s*${UNIT}\\b`, 'g'),
  new RegExp(`\\b(\\d{1,2})\\s*\\+\\s*${UNIT}\\b`, 'g'),
  // A bare "N years" only counts when "experience"/"exp" follows shortly,
  // otherwise "founded 5 years ago" would read as a requirement.
  new RegExp(`\\b(\\d{1,2})\\s*${UNIT}\\b(?=[^.\\n]{0,40}?\\b(?:experience|exp)\\b)`, 'g'),
];

/**
 * Lower bound of the years of experience a posting asks for, or null. When
 * several are stated ("5+ years overall, 2+ with Kafka") the largest lower
 * bound is the role's overall requirement.
 */
export function parseRequiredYears(text: string): number | null {
  if (!text) return null;
  const scanned = text.slice(0, YEARS_SCAN_LIMIT).toLowerCase();
  const claimed: Array<[number, number]> = [];
  const bounds: number[] = [];

  for (const pattern of YEARS_PATTERNS) {
    for (const match of scanned.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      claimed.push([start, end]);
      const lower = Number(match[1]);
      if (Number.isFinite(lower) && lower <= MAX_PLAUSIBLE_YEARS) bounds.push(lower);
    }
  }

  return bounds.length > 0 ? Math.max(...bounds) : null;
}

/** Common English words that are also skill aliases — matching them alone
 * produces false positives ("go to market", "rest of the team"). Their
 * unambiguous forms (golang, restful, express.js, ...) still match. */
const AMBIGUOUS_TERMS = new Set([
  'go', 'rest', 'express', 'spring', 'nest', 'node', 'next', 'bull', 'ws',
  'ts', 'js', 'py', 'auth', 'eda', 'kube',
]);

interface SkillPattern {
  slug: string;
  pattern: RegExp;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Alphanumeric lookarounds instead of \b, so "c#", ".net" and "node.js"
 * match, and "java" does not match inside "javascript". */
function termPattern(term: string): RegExp {
  const body = escapeRegex(term).replace(/\s+/g, '[\\s-]+');
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i');
}

const SKILL_PATTERNS: SkillPattern[] = SEED_SKILLS.flatMap((skill) =>
  [skill.name.replace(/-/g, ' '), ...skill.aliases]
    .map((term) => term.toLowerCase().trim())
    .filter((term) => term.length > 0 && !AMBIGUOUS_TERMS.has(term))
    .map((term) => ({ slug: skill.name, pattern: termPattern(term) })),
);

/** Canonical skill slugs from the shared taxonomy mentioned in `text`. */
export function extractMentionedSkills(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const { slug, pattern } of SKILL_PATTERNS) {
    if (!found.has(slug) && pattern.test(text)) found.add(slug);
  }
  return [...found];
}

const REMOTE_PATTERN = /\b(remote|work from home|wfh|fully distributed)\b/i;

export function normalizeCandidate(scoped: ScopedCandidate): NormalizedJob {
  const { candidate, companyId, companyName } = scoped;
  const title = (candidate.title ?? '').replace(/\s+/g, ' ').trim();
  const description = normalizeWhitespace(candidate.markdown ?? candidate.snippet ?? '');
  const trimmedLocation = candidate.locationHint?.trim() ?? '';
  const location = trimmedLocation.length > 0 ? trimmedLocation : null;

  return {
    candidate,
    companyId,
    companyName,
    title,
    description,
    location,
    isRemote: REMOTE_PATTERN.test(`${location ?? ''} ${description.slice(0, REMOTE_SCAN_LIMIT)}`),
    requiredYearsMin: parseRequiredYears(description),
    mentionedSkills: extractMentionedSkills(`${title}\n${description}`),
    externalId: candidate.externalId ?? null,
    department: candidate.department ?? null,
    urlHash: urlHash(candidate.url),
  };
}
