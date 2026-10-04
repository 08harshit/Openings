import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractJsonLdJobPosting } from './json-ld-extractor';

function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', name), 'utf-8');
}

describe('extractJsonLdJobPosting', () => {
  it('extracts title, description, location, and posted date from a valid JobPosting block', () => {
    const result = extractJsonLdJobPosting(fixture('job-posting-jsonld.html'), 'https://acme.com/careers/backend');

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Backend Engineer');
    expect(result!.companyNameHint).toBe('Acme Corp');
    expect(result!.locationHint).toBe('Bangalore');
    expect(result!.postedDateIso).toBe('2026-09-15');
    expect(result!.markdown).toContain('Backend Engineer with 2+ years');
    expect(result!.markdown).not.toContain('<p>'); // HTML-stripped
    expect(result!.source).toBe('http_scrape');
    expect(result!.url).toBe('https://acme.com/careers/backend');
  });

  it('skips a malformed JSON-LD block and still finds a valid one later on the page', () => {
    const result = extractJsonLdJobPosting(
      fixture('job-posting-malformed-jsonld.html'),
      'https://acme.com/careers/swe',
    );

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Software Developer');
  });

  it('ignores a non-JobPosting schema block (e.g. Organization) and returns null if nothing else matches', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@context": "https://schema.org/", "@type": "Organization", "name": "Acme Corp"}
    </script></head><body></body></html>`;

    const result = extractJsonLdJobPosting(html, 'https://acme.com/about');

    expect(result).toBeNull();
  });

  it('returns null for a page with no JSON-LD at all', () => {
    const result = extractJsonLdJobPosting(fixture('page-with-no-job-signal.html'), 'https://acme.com/life');

    expect(result).toBeNull();
  });
});
