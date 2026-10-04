import { Logger } from '@nestjs/common';
import { retry } from '../common/async.util';

const logger = new Logger('HttpPageFetcher');

/** 5MB — generous for any real career-page HTML document, and small enough
 * that a pathological response can't exhaust memory. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string | null;
  html: string;
}

class FetcherRetryableError extends Error {}

/**
 * Fetch a page's HTML over plain HTTP, with a timeout, a realistic
 * User-Agent (many career-page CDNs/WAFs block requests with no UA or an
 * obviously-bot one), and the same retry-on-429/5xx policy used elsewhere
 * in this codebase (see FirecrawlService.request()). Never throws — a
 * timeout, a network error, a non-HTML response, or an oversized response
 * all resolve to `null`, the same "try the next thing" contract
 * FirecrawlService.scrapePage() already uses.
 */
export async function fetchPage(url: string, timeoutMs: number): Promise<FetchedPage | null> {
  try {
    return await retry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let res: Response;
        try {
          res = await fetch(url, {
            signal: controller.signal,
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
          });
        } finally {
          clearTimeout(timer);
        }

        if (res.status === 429 || res.status >= 500) {
          throw new FetcherRetryableError(`HTTP ${res.status} fetching ${url}`);
        }
        if (!res.ok) {
          logger.debug(`Non-retryable status ${res.status} fetching ${url}`);
          return null;
        }

        const contentType = res.headers.get('content-type');
        if (!contentType || !contentType.toLowerCase().startsWith('text/html')) {
          logger.debug(`Skipping non-HTML content-type "${contentType}" for ${url}`);
          return null;
        }

        const html = await res.text();
        if (html.length > MAX_RESPONSE_BYTES) {
          logger.warn(`Response for ${url} exceeded ${MAX_RESPONSE_BYTES} bytes, skipping`);
          return null;
        }

        return {
          url: res.url || url,
          status: res.status,
          contentType,
          html,
        };
      },
      {
        attempts: 3,
        baseDelayMs: 500,
        shouldRetry: (error) => error instanceof FetcherRetryableError,
      },
    );
  } catch (error) {
    logger.debug(`fetchPage exhausted retries or failed for ${url}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}
