import { stripHtml } from './html.util';

describe('stripHtml', () => {
  it('strips tags and converts common block elements to newlines', () => {
    const html = '<p>First paragraph.</p><p>Second paragraph.</p><br>After break.';
    const result = stripHtml(html);
    expect(result).toBe('First paragraph.\n Second paragraph.\n\nAfter break.');
  });

  it('removes script and style blocks entirely, including their content', () => {
    const html = '<p>Visible</p><script>var x = "hidden";</script><style>.a{color:red}</style>';
    const result = stripHtml(html);
    expect(result).not.toContain('hidden');
    expect(result).not.toContain('color:red');
    expect(result).toBe('Visible');
  });

  it('decodes common HTML entities', () => {
    expect(stripHtml('Tom &amp; Jerry &lt;tag&gt; test&nbsp;here')).toBe('Tom & Jerry <tag> test here');
  });

  it('collapses excessive blank lines to at most one', () => {
    const html = '<p>A</p><p></p><p></p><p>B</p>';
    const result = stripHtml(html);
    expect(result).not.toMatch(/\n{3,}/);
  });
});
