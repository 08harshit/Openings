import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverJobLinks } from './job-link-discoverer';

const FIXTURE_HTML = readFileSync(
  join(__dirname, '__fixtures__', 'careers-page-with-mixed-links.html'),
  'utf-8',
);

describe('discoverJobLinks', () => {
  it('keeps only links that look like job postings, dropping nav/footer noise', () => {
    const links = discoverJobLinks(FIXTURE_HTML, 'https://acme.com/careers', 10);
    const urls = links.map((l) => l.url);

    expect(urls).not.toContain('https://acme.com/about');
    expect(urls).not.toContain('https://acme.com/privacy');
    expect(urls).not.toContain('https://acme.com/blog');
    expect(urls).not.toContain('https://acme.com/terms');
    expect(urls).not.toContain('https://acme.com/login');
  });

  it('resolves relative URLs against the base URL', () => {
    const links = discoverJobLinks(FIXTURE_HTML, 'https://acme.com/careers', 10);
    const urls = links.map((l) => l.url);

    expect(urls).toContain('https://acme.com/careers/backend-engineer-123');
  });

  it('keeps absolute URLs on the same domain as-is', () => {
    const links = discoverJobLinks(FIXTURE_HTML, 'https://acme.com/careers', 10);
    const urls = links.map((l) => l.url);

    expect(urls).toContain('https://acme.com/careers/full-stack-engineer-789');
  });

  it('de-duplicates links that differ only by tracking params', () => {
    const links = discoverJobLinks(FIXTURE_HTML, 'https://acme.com/careers', 10);
    const backendLinks = links.filter((l) => l.url.includes('backend-engineer-123'));

    expect(backendLinks).toHaveLength(1);
  });

  it('caps the result at maxLinks', () => {
    const links = discoverJobLinks(FIXTURE_HTML, 'https://acme.com/careers', 1);

    expect(links.length).toBeLessThanOrEqual(1);
  });

  it('returns an empty array for a page with no job-shaped links', () => {
    const html = '<html><body><a href="/about">About</a><a href="/blog">Blog</a></body></html>';
    const links = discoverJobLinks(html, 'https://acme.com', 10);

    expect(links).toEqual([]);
  });
});
