import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractGenericJobPosting } from './cheerio-job-extractor';

function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', name), 'utf-8');
}

describe('extractGenericJobPosting', () => {
  it('extracts a title from h1 and description from main content', () => {
    const result = extractGenericJobPosting(
      fixture('job-posting-generic-html.html'),
      'https://acme.com/careers/full-stack',
    );

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Full Stack Engineer');
    expect(result!.markdown).toContain('Node.js backend and React frontend');
    // extractLocation's "City, Country" pattern matches the first such pair in the
    // text ("Bangalore, India"), not the later unpunctuated "based in Bangalore".
    expect(result!.locationHint).toBe('Bangalore, India');
    expect(result!.source).toBe('http_scrape');
  });

  it('returns null when there is too little content to be a real job posting', () => {
    const result = extractGenericJobPosting(fixture('page-with-no-job-signal.html'), 'https://acme.com/life');

    expect(result).toBeNull();
  });

  it('falls back to the <title> tag when there is no h1', () => {
    const html = `<html><head><title>Backend Role</title></head>
      <body><article>${'We need a backend engineer with solid experience. '.repeat(10)}</article></body></html>`;

    const result = extractGenericJobPosting(html, 'https://acme.com/careers/backend-2');

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Backend Role');
  });
});
