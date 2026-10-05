import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrapeCareerPage } from './career-page-scraper';
import * as fetcher from './http-page-fetcher';
import * as extractor from './job-extractor';
import type { CvProfile } from '@jobportal/shared';
import { evaluateEligibility } from '../pipeline/eligibility';
import { normalizeCandidate } from '../pipeline/normalize';

const OPTIONS = { timeoutMs: 5000, maxLinks: 10, concurrency: 3 };

function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', name), 'utf-8');
}

describe('scrapeCareerPage', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns an empty array if the careers page itself cannot be fetched', async () => {
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue(null);

    const result = await scrapeCareerPage('https://acme.com/careers', OPTIONS);

    expect(result).toEqual([]);
  });

  it('returns an empty array if the careers page has no job-shaped links', async () => {
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue({
      url: 'https://acme.com/careers',
      status: 200,
      contentType: 'text/html',
      html: '<html><body><a href="/about">About</a></body></html>',
    });

    const result = await scrapeCareerPage('https://acme.com/careers', OPTIONS);

    expect(result).toEqual([]);
  });

  it('extracts a candidate for each discovered job link', async () => {
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue({
      url: 'https://acme.com/careers',
      status: 200,
      contentType: 'text/html',
      html: `<html><body>
        <a href="/careers/backend-engineer-1">Backend Engineer</a>
        <a href="/careers/software-developer-2">Software Developer</a>
      </body></html>`,
    });
    jest.spyOn(extractor, 'extractJob').mockImplementation(async (url) => ({
      title: url.includes('backend') ? 'Backend Engineer' : 'Software Developer',
      url,
      companyNameHint: null,
      locationHint: null,
      snippet: 'x'.repeat(50),
      markdown: 'x'.repeat(50),
      source: 'http_scrape',
      postedDateIso: null,
    }));

    const result = await scrapeCareerPage('https://acme.com/careers', OPTIONS);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.title).sort()).toEqual(['Backend Engineer', 'Software Developer']);
  });

  it('drops links whose extraction returns null, without failing the whole scrape', async () => {
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue({
      url: 'https://acme.com/careers',
      status: 200,
      contentType: 'text/html',
      html: `<html><body>
        <a href="/careers/backend-engineer-1">Backend Engineer</a>
        <a href="/careers/broken-link-2">Broken Software Developer Link</a>
      </body></html>`,
    });
    jest.spyOn(extractor, 'extractJob').mockImplementation(async (url) => {
      if (url.includes('broken')) return null;
      return {
        title: 'Backend Engineer',
        url,
        companyNameHint: null,
        locationHint: null,
        snippet: 'x'.repeat(50),
        markdown: 'x'.repeat(50),
        source: 'http_scrape',
        postedDateIso: null,
      };
    });

    const result = await scrapeCareerPage('https://acme.com/careers', OPTIONS);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Backend Engineer');
  });

  it('a careers-shell page with only nav/sub-page links produces no credible job candidate end to end', async () => {
    // Real (not mocked) discoverJobLinks + extractors — only fetchPage is
    // mocked, routed per-URL so the careers page itself and each discovered
    // sub-page serve distinct fixture-shaped HTML. This reproduces the C1
    // bug scenario: a careers page whose own self-link and "life at our
    // company"/"benefits" sub-pages are the only things discoverJobLinks
    // finds — none of them a real job posting.
    const shellHtml = fixture('careers-shell-no-real-jobs.html');
    const lifeAtAcmeHtml = `<html><head><title>Life at Acme</title></head><body>
      <h1>Life at Acme</h1>
      <main>${'We love collaborating and building great products together as one team. '.repeat(5)}</main>
    </body></html>`;
    const benefitsHtml = `<html><head><title>Benefits</title></head><body>
      <h1>Benefits</h1>
      <main>${'Health insurance, flexible leave, and a generous learning budget for everyone. '.repeat(5)}</main>
    </body></html>`;

    jest.spyOn(fetcher, 'fetchPage').mockImplementation(async (url: string) => {
      if (url === 'https://acme.com/careers') {
        return { url, status: 200, contentType: 'text/html', html: shellHtml };
      }
      if (url.includes('life-at-acme')) {
        return { url, status: 200, contentType: 'text/html', html: lifeAtAcmeHtml };
      }
      if (url.includes('benefits')) {
        return { url, status: 200, contentType: 'text/html', html: benefitsHtml };
      }
      return null;
    });

    const result = await scrapeCareerPage('https://acme.com/careers', OPTIONS);

    // Proves the bug's premise first: the generic extractor's permissive
    // <h1>+100-char-<main> bar means these sub-pages DO produce non-null,
    // non-empty RawJobCandidates. If this were 0, the old (pre-fix)
    // `shouldFallBackToFirecrawl(raw)` — raw-count-based — would have
    // correctly triggered Firecrawl already and there'd be no bug to fix.
    expect(result.length).toBeGreaterThan(0);

    // But none of them should survive the real relevance filter a
    // backend-focused profile would apply — which is what actually matters
    // for the fallback decision (see ingest.service.ts's
    // shouldFallBackToFirecrawl and scrapeCustomCareerPage). Under the OLD
    // logic (shouldFallBackToFirecrawl(raw), raw count > 0) Firecrawl would
    // never have been tried here, even though zero real jobs exist.
    const profile: CvProfile = {
      id: 'p1',
      user_id: 'u1',
      raw_cv_text: null,
      experience_years: 2,
      current_title: null,
      updated_at: '2026-10-05T00:00:00Z',
      target_roles: ['backend', 'software engineer', 'full stack'],
      excluded_roles: [],
      excluded_departments: [],
      preferred_locations: ['india', 'remote'],
      excluded_companies: [],
      seniority_min_years: null,
      seniority_max_years: null,
      work_modes: [],
      employment_types: [],
      domain_preferences: [],
      domain_exclusions: [],
    };
    const credible = result.filter(
      (candidate) =>
        evaluateEligibility(normalizeCandidate({ candidate, companyId: 'c1', companyName: 'Acme' }), profile).eligible,
    );

    expect(credible).toHaveLength(0);
  });
});
