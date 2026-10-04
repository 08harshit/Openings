import { scrapeCareerPage } from './career-page-scraper';
import * as fetcher from './http-page-fetcher';
import * as extractor from './job-extractor';

const OPTIONS = { timeoutMs: 5000, maxLinks: 10, concurrency: 3 };

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
});
