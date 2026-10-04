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

  describe('locationFromJsonLd real-world shapes', () => {
    it('handles jobLocation as an array (multi-city role), joining each entry\'s locality', () => {
      const html = `<html><head><script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Backend Engineer",
          "description": "A role spanning two cities, long enough to pass.",
          "jobLocation": [
            {"address": {"addressLocality": "Bangalore"}},
            {"address": {"addressLocality": "Hyderabad"}}
          ]
        }
      </script></head><body></body></html>`;

      const result = extractJsonLdJobPosting(html, 'https://acme.com/careers/multi-city');

      expect(result).not.toBeNull();
      expect(result!.locationHint).toContain('Bangalore');
      expect(result!.locationHint).toContain('Hyderabad');
    });

    it('falls back to addressRegion when addressLocality is absent', () => {
      const html = `<html><head><script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Backend Engineer",
          "description": "A region-only address, long enough text to pass the bar.",
          "jobLocation": {"address": {"addressRegion": "Karnataka"}}
        }
      </script></head><body></body></html>`;

      const result = extractJsonLdJobPosting(html, 'https://acme.com/careers/region-only');

      expect(result).not.toBeNull();
      expect(result!.locationHint).toBe('Karnataka');
    });

    it('falls back to addressCountry when neither addressLocality nor addressRegion is present', () => {
      const html = `<html><head><script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Backend Engineer",
          "description": "A country-only address, long enough text to pass the bar.",
          "jobLocation": {"address": {"addressCountry": "India"}}
        }
      </script></head><body></body></html>`;

      const result = extractJsonLdJobPosting(html, 'https://acme.com/careers/country-only');

      expect(result).not.toBeNull();
      expect(result!.locationHint).toBe('India');
    });

    it('maps jobLocationType TELECOMMUTE to Remote when no jobLocation is present', () => {
      const html = `<html><head><script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Backend Engineer",
          "description": "A fully remote role, long enough description text to pass the bar.",
          "jobLocationType": "TELECOMMUTE"
        }
      </script></head><body></body></html>`;

      const result = extractJsonLdJobPosting(html, 'https://acme.com/careers/remote');

      expect(result).not.toBeNull();
      expect(result!.locationHint).toBe('Remote');
    });

    it('is case-insensitive when matching jobLocationType TELECOMMUTE', () => {
      const html = `<html><head><script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Backend Engineer",
          "description": "A fully remote role, long enough description text to pass the bar.",
          "jobLocationType": "telecommute"
        }
      </script></head><body></body></html>`;

      const result = extractJsonLdJobPosting(html, 'https://acme.com/careers/remote-lower');

      expect(result).not.toBeNull();
      expect(result!.locationHint).toBe('Remote');
    });

    // --- M1 / Fix 5: malformed-but-valid-JSON shapes must not throw -------

    it('does not throw when @type is an array containing a non-string element', () => {
      // The non-string element comes FIRST so Array.prototype.some() must
      // actually evaluate it (a type guard that only protects a later
      // element but still calls .toLowerCase() on an earlier non-string one
      // would still throw before ever reaching "JobPosting").
      const html = `<html><head><script type="application/ld+json">
        {
          "@type": [42, null, "JobPosting"],
          "title": "Backend Engineer",
          "description": "A long enough description to pass the extractor's bar for content."
        }
      </script></head><body></body></html>`;

      expect(() => extractJsonLdJobPosting(html, 'https://acme.com/careers/weird-type')).not.toThrow();
      const result = extractJsonLdJobPosting(html, 'https://acme.com/careers/weird-type');
      expect(result).not.toBeNull();
      expect(result!.title).toBe('Backend Engineer');
    });

    it('does not throw when description is an object instead of a string, and treats it as absent', () => {
      const html = `<html><head><script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Backend Engineer",
          "description": {"nested": "object, not a string"}
        }
      </script></head><body></body></html>`;

      expect(() => extractJsonLdJobPosting(html, 'https://acme.com/careers/weird-desc')).not.toThrow();
      const result = extractJsonLdJobPosting(html, 'https://acme.com/careers/weird-desc');
      expect(result).not.toBeNull();
      expect(result!.markdown).toBeNull();
    });

    it('does not throw when datePosted is the wrong type, and treats it as absent', () => {
      const html = `<html><head><script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Backend Engineer",
          "description": "A long enough description to pass the extractor's bar for content.",
          "datePosted": 20260915
        }
      </script></head><body></body></html>`;

      expect(() => extractJsonLdJobPosting(html, 'https://acme.com/careers/weird-date')).not.toThrow();
      const result = extractJsonLdJobPosting(html, 'https://acme.com/careers/weird-date');
      expect(result).not.toBeNull();
      expect(result!.postedDateIso).toBeNull();
    });

    it('skips a block with a non-string title/name rather than throwing or passing it through unvalidated', () => {
      const html = `<html><head><script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": {"nested": "object title"},
          "description": "A long enough description to pass the extractor's bar for content."
        }
      </script></head><body></body></html>`;

      expect(() => extractJsonLdJobPosting(html, 'https://acme.com/careers/weird-title')).not.toThrow();
      const result = extractJsonLdJobPosting(html, 'https://acme.com/careers/weird-title');
      expect(result).toBeNull();
    });

    it('falls back to extractLocation() against the description text when JSON-LD has no location signal at all', () => {
      const html = `<html><head><script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "Backend Engineer",
          "description": "This role is based in Pune, India and offers a hybrid work setup for the right candidate."
        }
      </script></head><body></body></html>`;

      const result = extractJsonLdJobPosting(html, 'https://acme.com/careers/description-fallback');

      expect(result).not.toBeNull();
      expect(result!.locationHint).toBe('Pune, India');
    });
  });
});
