/**
 * Universal retry wrapper with exponential backoff.
 * Applies to all providers (previously only Gemini had retries).
 */

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  shouldRetry?: (error: Error) => boolean;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 2,
  baseDelayMs: 2000,
  shouldRetry: (error: Error) =>
    error.message.includes("timed out") ||
    error.message.includes("ECONNRESET") ||
    error.message.includes("ETIMEDOUT") ||
    error.message.includes("ECONNREFUSED")
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;

      if (attempt < opts.maxRetries && opts.shouldRetry?.(err)) {
        const delay = opts.baseDelayMs * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}
