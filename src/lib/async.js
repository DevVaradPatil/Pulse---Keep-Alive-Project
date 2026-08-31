/**
 * Small async primitives. Kept dependency-free and injectable so the tests can
 * run the real logic with a fake clock instead of actually sleeping.
 */

/**
 * @param {number} ms
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<void>}
 */
export function sleep(ms, options = {}) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      options.signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(options.signal?.reason ?? new Error('Aborted'));
    };
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        reject(options.signal.reason ?? new Error('Aborted'));
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving input
 * order in the returned array.
 *
 * The worker is never allowed to reject: a rejection here would abandon the
 * remaining items, which is exactly the "one dead project stops the other
 * twenty from being pinged" bug this project must not have. Callers pass a
 * worker that captures its own failures; if one throws anyway we capture it as
 * a rejected settlement rather than tearing the batch down.
 *
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<Array<{ ok: true, value: R } | { ok: false, error: unknown }>>}
 */
export async function mapWithConcurrency(items, limit, worker) {
  /** @type {Array<{ ok: true, value: R } | { ok: false, error: unknown }>} */
  const settled = new Array(items.length);
  const effectiveLimit = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
  let cursor = 0;

  const runLane = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        settled[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        settled[index] = { ok: false, error };
      }
    }
  };

  await Promise.all(Array.from({ length: effectiveLimit }, runLane));
  return settled;
}

/**
 * Retry `attemptFn` with exponential backoff and full-width jitter.
 *
 * Every failure is retryable. A 503 from a container that is still booting, a
 * DNS blip and a genuinely dead host are indistinguishable on the first
 * attempt, and the whole point of the retry budget is that a single blip must
 * not page anyone.
 *
 * @template R
 * @param {(attempt: number) => Promise<R>} attemptFn Receives the 1-based attempt number.
 * @param {object} options
 * @param {number} options.retries Retries after the first attempt.
 * @param {number} [options.baseMs] Delay before the first retry.
 * @param {number} [options.maxMs] Cap for a single delay.
 * @param {() => number} [options.random] Injectable RNG in [0, 1).
 * @param {(ms: number) => Promise<void>} [options.sleepFn] Injectable sleep.
 * @param {(info: { attempt: number, delayMs: number, error: unknown }) => void} [options.onRetry]
 * @returns {Promise<{ value: R, attempts: number }>}
 */
export async function withRetry(attemptFn, options) {
  const {
    retries,
    baseMs = 500,
    maxMs = 8000,
    random = Math.random,
    sleepFn = sleep,
    onRetry,
  } = options;

  const maxAttempts = Math.max(1, retries + 1);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return { value: await attemptFn(attempt), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      const delayMs = backoffDelay(attempt, { baseMs, maxMs, random });
      onRetry?.({ attempt, delayMs, error });
      await sleepFn(delayMs);
    }
  }

  if (lastError instanceof Error) {
    /** @type {Error & { attempts?: number }} */ (lastError).attempts = maxAttempts;
  }
  throw lastError;
}

/**
 * Delay before the retry that follows `attempt`: `baseMs * 2^(attempt-1)`,
 * capped at `maxMs`, then jittered to 50-100% of that value so a batch of
 * targets that failed together does not retry in lockstep.
 *
 * @param {number} attempt 1-based number of the attempt that just failed.
 * @param {{ baseMs: number, maxMs: number, random?: () => number }} options
 * @returns {number} Milliseconds, always an integer >= 0.
 */
export function backoffDelay(attempt, { baseMs, maxMs, random = Math.random }) {
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exponential * (0.5 + random() * 0.5));
}
