import { extractMentionedSkills, normalizeCandidate, parseRequiredYears } from './normalize';
import type { RawJobCandidate } from '../firecrawl/firecrawl.types';

describe('parseRequiredYears', () => {
  it.each([
    ['3+ years of experience in Node.js', 3],
    ['We need 3 + yrs of backend work', 3],
    ['2-4 years of experience', 2],
    ['2 – 4 years', 2],
    ['2 to 4 years building APIs', 2],
    ['Minimum 3 years', 3],
    ['minimum of 3 years', 3],
    ['at least 3 years', 3],
    ['3 years of experience', 3],
    ['3 years experience with Postgres', 3],
    ['3 yrs exp', 3],
  ])('reads %p as %p', (text, expected) => {
    expect(parseRequiredYears(text)).toBe(expected);
  });

  it('returns the largest lower bound when several are stated', () => {
    expect(parseRequiredYears('5+ years experience overall, 2+ years with Kafka')).toBe(5);
  });

  it.each([
    ['1.5+ years of experience in Node.js', 1.5],
    ['2.5 years of experience in backend development', 2.5],
    ['1.5-3 years of experience', 1.5],
    ['Minimum of 1.5 years of experience', 1.5],
  ])('reads a decimal year count whole, not its fractional digit: %s', (text, expected) => {
    expect(parseRequiredYears(text)).toBe(expected);
  });

  it('does not double-count the upper end of a range', () => {
    expect(parseRequiredYears('2-4 years of experience')).toBe(2);
  });

  it('ignores implausible numbers like company age', () => {
    expect(parseRequiredYears('We have been in business for 25+ years')).toBeNull();
  });

  it('ignores a bare "N years" with no experience context', () => {
    expect(parseRequiredYears('Founded 5 years ago in Bangalore')).toBeNull();
  });

  it('returns null for empty text or text with no years', () => {
    expect(parseRequiredYears('')).toBeNull();
    expect(parseRequiredYears('Great culture, free lunch')).toBeNull();
  });
});

describe('extractMentionedSkills', () => {
  it('finds canonical skills via their aliases', () => {
    const skills = extractMentionedSkills('Build services in Node.js and PostgreSQL behind a REST API');
    expect(skills).toEqual(expect.arrayContaining(['nodejs', 'postgresql', 'rest-api']));
  });

  it('does not match ambiguous English words on their own', () => {
    const skills = extractMentionedSkills('Our go to market team will express interest; rest of the team is in spring mode');
    expect(skills).not.toContain('go');
    expect(skills).not.toContain('expressjs');
    expect(skills).not.toContain('rest-api');
    expect(skills).not.toContain('spring-boot');
  });

  it('still matches the unambiguous forms', () => {
    const skills = extractMentionedSkills('Golang, Express.js and Spring Boot');
    expect(skills).toEqual(expect.arrayContaining(['go', 'expressjs', 'spring-boot']));
  });

  it('does not match java inside javascript', () => {
    expect(extractMentionedSkills('Strong JavaScript skills')).not.toContain('java');
  });

  it('returns each skill once', () => {
    const skills = extractMentionedSkills('Node.js, node.js, NodeJS');
    expect(skills.filter((s) => s === 'nodejs')).toHaveLength(1);
  });

  it('returns an empty list for empty text', () => {
    expect(extractMentionedSkills('')).toEqual([]);
  });
});

describe('normalizeCandidate', () => {
  function candidate(overrides: Partial<RawJobCandidate> = {}): RawJobCandidate {
    return {
      title: '  Backend   Engineer ',
      url: 'https://acme.com/careers/1?utm_source=x',
      companyNameHint: 'Acme',
      locationHint: ' Bangalore, India ',
      snippet: 'short snippet',
      markdown: '3+ years of experience with Node.js. Fully remote team.',
      source: 'ats_api',
      postedDateIso: '2026-10-01',
      externalId: '123',
      department: 'Engineering',
      ...overrides,
    };
  }

  it('produces the normalized fields', () => {
    const job = normalizeCandidate({ candidate: candidate(), companyId: 'c1', companyName: 'Acme' });

    expect(job.title).toBe('Backend Engineer');
    expect(job.location).toBe('Bangalore, India');
    expect(job.requiredYearsMin).toBe(3);
    expect(job.mentionedSkills).toContain('nodejs');
    expect(job.isRemote).toBe(true);
    expect(job.externalId).toBe('123');
    expect(job.department).toBe('Engineering');
    expect(job.companyId).toBe('c1');
    expect(job.urlHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('falls back to the snippet when there is no markdown', () => {
    const job = normalizeCandidate({ candidate: candidate({ markdown: null }), companyId: 'c1', companyName: 'Acme' });
    expect(job.description).toBe('short snippet');
  });

  it('turns an empty location into null and missing ATS fields into null', () => {
    const job = normalizeCandidate({
      candidate: candidate({ locationHint: '   ', externalId: undefined, department: undefined }),
      companyId: 'c1',
      companyName: 'Acme',
    });
    expect(job.location).toBeNull();
    expect(job.externalId).toBeNull();
    expect(job.department).toBeNull();
  });

  it('detects remote from the location string', () => {
    const job = normalizeCandidate({
      candidate: candidate({ locationHint: 'Remote', markdown: 'No location words here.' }),
      companyId: 'c1',
      companyName: 'Acme',
    });
    expect(job.isRemote).toBe(true);
  });
});
