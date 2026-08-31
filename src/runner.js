/**
 * The runner: turn a list of targets into a list of results.
 *
 * Two properties matter more than anything else in this file.
 *
 * 1. It never fails fast. Every target is attempted, whatever the others do.
 *    One dead project must not stop the other twenty from being pinged, because
 *    "the run aborted early" and "your database was pinged" look identical in a
 *    workflow log right up until the project is paused.
 * 2. It never throws. Failures become results. The caller decides the exit code
 *    from the collected results, once.
 */

import { getCheck } from './checks/index.js';
import { mapWithConcurrency, sleep, withRetry } from './lib/async.js';
import { trimErrorMessage } from './lib/errors.js';

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function buildUserAgent(env = process.env) {
  const repo = env.GITHUB_REPOSITORY ?? 'devVaradPatil/pulse';
  return `Pulse/1.0 (+https://github.com/${repo}; free-tier keep-alive monitor)`;
}

/**
 * @typedef {object} RunOptions
 * @property {import('./types.js').RunDefaults} defaults
 * @property {typeof globalThis.fetch} [fetchImpl] Injected in tests; no test ever touches the network.
 * @property {string} [userAgent]
 * @property {() => number} [random] Injectable RNG, for deterministic jitter and backoff in tests.
 * @property {(ms: number) => Promise<void>} [sleepFn] Injectable sleep, so tests do not wait.
 * @property {() => Date} [now]
 * @property {(result: import('./types.js').RunResult) => void} [onResult] Called as each target settles.
 * @property {(line: string) => void} [onRetryLog]
 */

/**
 * @param {import('./types.js').Target[]} targets
 * @param {RunOptions} options
 * @returns {Promise<import('./types.js').RunResult[]>}
 */
export async function runChecks(targets, options) {
  const {
    defaults,
    fetchImpl = globalThis.fetch,
    userAgent = buildUserAgent(),
    random = Math.random,
    sleepFn = sleep,
    now = () => new Date(),
    onResult,
    onRetryLog,
  } = options;

  const settled = await mapWithConcurrency(targets, defaults.concurrency, async (target) => {
    // Jitter the start so twenty targets do not all fire in the same
    // millisecond - politeness towards the hosts, and it keeps a burst of
    // retries from lining up.
    await sleepFn(Math.round(random() * defaults.jitterMs));

    const result = await checkOne(target, {
      defaults,
      fetchImpl,
      userAgent,
      random,
      sleepFn,
      now,
      onRetryLog,
    });
    onResult?.(result);
    return result;
  });

  return settled.map((entry, index) =>
    entry.ok
      ? entry.value
      : // Defensive: checkOne is written not to throw. If it ever does, the run
        // still produces a result for every target instead of losing one.
        failedResult(targets[index], {
          error: trimErrorMessage(entry.error),
          attempts: 0,
          durationMs: 0,
          checkedAt: now().toISOString(),
        })
  );
}

/**
 * Check a single target, with retries. Always resolves.
 *
 * @param {import('./types.js').Target} target
 * @param {Required<Pick<RunOptions, 'defaults' | 'userAgent' | 'random' | 'sleepFn' | 'now'>> & { fetchImpl: typeof globalThis.fetch, onRetryLog?: (line: string) => void }} ctx
 * @returns {Promise<import('./types.js').RunResult>}
 */
export async function checkOne(target, ctx) {
  const { defaults, fetchImpl, userAgent, random, sleepFn, now, onRetryLog } = ctx;
  const checkedAt = now().toISOString();
  let lastAttemptMs = 0;

  /** @param {number} _attempt */
  const attempt = async (_attempt) => {
    const check = getCheck(target.type);
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            `timed out after ${target.timeoutMs} ms (per-attempt timeout for "${target.id}")`
          )
        ),
      target.timeoutMs
    );
    const startedAt = Date.now();
    try {
      return await check.run(target, {
        signal: controller.signal,
        fetch: fetchImpl,
        userAgent,
        timeoutMs: target.timeoutMs,
      });
    } finally {
      lastAttemptMs = Date.now() - startedAt;
      clearTimeout(timer);
    }
  };

  try {
    const { value, attempts } = await withRetry(attempt, {
      retries: target.retries,
      baseMs: defaults.backoffBaseMs,
      maxMs: defaults.backoffMaxMs,
      random,
      sleepFn,
      onRetry: ({ attempt: n, delayMs, error }) =>
        onRetryLog?.(
          `${target.id}: attempt ${n} failed (${trimErrorMessage(error, 120)}), retrying in ${delayMs} ms`
        ),
    });

    return {
      ...identity(target),
      ok: true,
      attempts,
      durationMs: lastAttemptMs,
      statusCode: value.statusCode,
      detail: value.detail,
      checkedAt,
    };
  } catch (error) {
    const attempts = /** @type {{ attempts?: number }} */ (error)?.attempts ?? target.retries + 1;
    const statusCode = /** @type {{ statusCode?: number }} */ (error)?.statusCode;
    const hint = /** @type {{ hint?: string }} */ (error)?.hint;

    return failedResult(target, {
      error: trimErrorMessage(error),
      attempts,
      durationMs: lastAttemptMs,
      statusCode,
      detail: hint ? trimErrorMessage(new Error(hint), 200) : undefined,
      checkedAt,
    });
  }
}

/**
 * @param {import('./types.js').Target} target
 * @param {{ error: string, attempts: number, durationMs: number, statusCode?: number, detail?: string, checkedAt: string }} info
 * @returns {import('./types.js').RunResult}
 */
function failedResult(target, info) {
  return { ...identity(target), ok: false, ...info };
}

/**
 * The target fields that travel with a result into the history file and the
 * dashboard, so the dashboard needs no second source of truth.
 *
 * @param {import('./types.js').Target} target
 */
function identity(target) {
  return {
    id: target.id,
    name: target.name,
    type: target.type,
    tier: target.tier,
    platform: target.platform,
    publicUrl: target.publicUrl,
    notes: target.notes,
  };
}
