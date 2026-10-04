import { extractJob } from './job-extractor';
import * as fetcher from './http-page-fetcher';
import * as jsonLdExtractor from './json-ld-extractor';

describe('extractJob', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns null immediately if the page cannot be fetched', async () => {
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue(null);

    const result = await extractJob('https://acme.com/careers/x', 5000);

    expect(result).toBeNull();
  });

  it('prefers a JSON-LD JobPosting when present', async () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type": "JobPosting", "title": "Backend Engineer", "description": "A real job description long enough to pass."}
    </script></head><body><h1>Different title from generic extraction</h1>
      <main>${'padding content to pass the generic extractor length bar. '.repeat(5)}</main>
    </body></html>`;
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue({
      url: 'https://acme.com/careers/x',
      status: 200,
      contentType: 'text/html',
      html,
    });

    const result = await extractJob('https://acme.com/careers/x', 5000);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Backend Engineer'); // from JSON-LD, not the h1
  });

  it('falls back to generic extraction when there is no JSON-LD', async () => {
    const html = `<html><head><title>Fallback</title></head><body>
      <h1>Software Developer</h1>
      <main>${'A long enough description to pass the generic extractor minimum length bar. '.repeat(3)}</main>
    </body></html>`;
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue({
      url: 'https://acme.com/careers/y',
      status: 200,
      contentType: 'text/html',
      html,
    });

    const result = await extractJob('https://acme.com/careers/y', 5000);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Software Developer');
  });

  it('returns null when neither extraction strategy finds enough signal', async () => {
    const html = '<html><head><title>Life at Acme</title></head><body><p>Short.</p></body></html>';
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue({
      url: 'https://acme.com/life',
      status: 200,
      contentType: 'text/html',
      html,
    });

    const result = await extractJob('https://acme.com/life', 5000);

    expect(result).toBeNull();
  });

  it('returns null (defense-in-depth) rather than throwing if extractJsonLdJobPosting throws', async () => {
    // M1/Fix 5: extractJob must never let an extractor's throw propagate
    // past its own boundary — an unanticipated crash in either extraction
    // strategy should degrade to "drop this one link", not fail the whole
    // company's scrape (which would skip the Firecrawl fallback entirely).
    jest.spyOn(fetcher, 'fetchPage').mockResolvedValue({
      url: 'https://acme.com/careers/x',
      status: 200,
      contentType: 'text/html',
      html: '<html><body>irrelevant</body></html>',
    });
    jest.spyOn(jsonLdExtractor, 'extractJsonLdJobPosting').mockImplementation(() => {
      throw new Error('unexpected crash deep in JSON-LD parsing');
    });

    const result = await extractJob('https://acme.com/careers/x', 5000);

    expect(result).toBeNull();
  });
});
