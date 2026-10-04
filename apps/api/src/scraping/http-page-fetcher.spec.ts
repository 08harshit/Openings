import { fetchPage } from './http-page-fetcher';

describe('fetchPage', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockFetchOnce(response: Partial<Response> & { text: () => Promise<string> }): void {
    global.fetch = jest.fn().mockResolvedValue(response as Response);
  }

  it('returns the page on a successful HTML response', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      url: 'https://example.com/careers',
      text: async () => '<html><body>Jobs here</body></html>',
    });

    const result = await fetchPage('https://example.com/careers', 5000);

    expect(result).toEqual({
      url: 'https://example.com/careers',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      html: '<html><body>Jobs here</body></html>',
    });
  });

  it('returns null when the content-type is not HTML', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      url: 'https://example.com/careers.pdf',
      text: async () => '%PDF-1.4 binary garbage',
    });

    const result = await fetchPage('https://example.com/careers.pdf', 5000);

    expect(result).toBeNull();
  });

  it('returns null when the response body exceeds the size limit', async () => {
    const hugeHtml = 'x'.repeat(6 * 1024 * 1024); // 6MB, over the 5MB cap
    mockFetchOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      url: 'https://example.com/huge',
      text: async () => hugeHtml,
    });

    const result = await fetchPage('https://example.com/huge', 5000);

    expect(result).toBeNull();
  });

  it('retries on a 503 and eventually returns null if every attempt fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ 'content-type': 'text/html' }),
      url: 'https://example.com/down',
      text: async () => '',
    } as Response);

    const result = await fetchPage('https://example.com/down', 1000);

    expect(result).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(3); // matches retry()'s default attempts: 3
  });

  it('returns null without retrying on a 404', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({ 'content-type': 'text/html' }),
      url: 'https://example.com/missing',
      text: async () => '',
    } as Response);

    const result = await fetchPage('https://example.com/missing', 1000);

    expect(result).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1); // 404 is not retryable
  });

  it('returns null when fetch itself throws (network error)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await fetchPage('https://example.com/unreachable', 1000);

    expect(result).toBeNull();
  });
});
