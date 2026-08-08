/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Used to bound concurrent Claude calls during ingestion — the free-tier rate
 * limits are the binding constraint, not our own throughput.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: effectiveLimit }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * An error whose thrower knows the correct retry delay (e.g. parsed from an
 * HTTP `Retry-After` header) rather than leaving it to `retry()`'s guessed
 * exponential backoff. When present, `retry()` uses this instead of — not in
 * addition to — the computed backoff, since the server's own stated cooldown
 * is authoritative for rate limits.
 */
export interface RetryDelayHint {
  retryAfterMs?: number;
}

/**
 * Retry with exponential backoff + jitter.
 *
 * `shouldRetry` decides which failures are worth retrying — callers pass the
 * predicate because "retryable" means different things for an HTTP 429 from
 * Firecrawl and a 429 from Groq.
 */
export async function retry<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    /** Ceiling for a server-provided Retry-After hint. A hint is real
     * server guidance (we've seen Groq hand back 28+ minutes under heavy
     * load) and worth honoring — but blindly sleeping that long inside a
     * single retry loop can hold a broader lock the caller owns (e.g.
     * IngestService's per-user run lock) for hours. Cap it and let this
     * attempt fail instead of stalling the whole caller indefinitely. */
    maxHintDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  } = {},
): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 8_000,
    maxHintDelayMs = 60_000,
    shouldRetry = () => true,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error)) break;

      const hint = (error as RetryDelayHint)?.retryAfterMs;
      const delay =
        hint !== undefined
          ? Math.min(hint, maxHintDelayMs)
          : Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs) + Math.random() * baseDelayMs;
      onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Reject if `promise` hasn't settled within `ms`. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
