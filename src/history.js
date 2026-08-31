/**
 * History: load, append, prune, roll up.
 *
 * The file lives on the orphan `status` branch, is rewritten once a day by the
 * daily workflow, and is fetched directly by the dashboard. Two constraints
 * shape everything here:
 *
 *  - It must not grow without bound. One commit a day for years is fine; a file
 *    that grows by 20 rows a day forever is not. Detail is kept for 90 days,
 *    then collapsed into one row per target per month.
 *  - It must stay small enough to fetch on page load, so keys are short and the
 *    dashboard needs no second request.
 *
 * Shape:
 *
 * {
 *   "version": 1,
 *   "lastRun": "2026-08-31T21:17:04.000Z",
 *   "targets": {
 *     "<id>": {
 *       "name", "platform", "publicUrl", "notes", "type", "tier",
 *       "runs":   [{ "t": iso, "ok": bool, "ms": n, "s": status?, "a": attempts, "e": error? }],
 *       "months": [{ "m": "2026-05", "total": n, "ok": n, "uptime": 96.8, "meanMs": n, "p95Ms": n }]
 *     }
 *   }
 * }
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ConfigError } from './lib/errors.js';

export const HISTORY_VERSION = 1;
export const DETAIL_RETENTION_DAYS = 90;
export const MONTHLY_RETENTION = 24;

/**
 * @typedef {object} HistoryRun
 * @property {string} t ISO timestamp.
 * @property {boolean} ok
 * @property {number} ms Response time of the final attempt.
 * @property {number} [s] HTTP status, when there was one.
 * @property {number} a Attempts used.
 * @property {string} [e] Trimmed error message.
 */

/**
 * @typedef {object} HistoryMonth
 * @property {string} m `YYYY-MM`.
 * @property {number} total
 * @property {number} ok
 * @property {number} uptime Percentage, one decimal place.
 * @property {number} meanMs
 * @property {number} p95Ms Approximate once buckets have been merged; see rollUp().
 */

/**
 * @typedef {object} HistoryTarget
 * @property {string} name
 * @property {string} [platform]
 * @property {string} [publicUrl]
 * @property {string} [notes]
 * @property {string} [type]
 * @property {string} [tier]
 * @property {HistoryRun[]} runs
 * @property {HistoryMonth[]} months
 */

/**
 * @typedef {object} History
 * @property {number} version
 * @property {string | null} lastRun
 * @property {Record<string, HistoryTarget>} targets
 */

/**
 * @returns {History}
 */
export function emptyHistory() {
  return { version: HISTORY_VERSION, lastRun: null, targets: {} };
}

/**
 * @param {string} path
 * @returns {Promise<History>} An empty history when the file does not exist yet.
 */
export async function loadHistory(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error).code === 'ENOENT') return emptyHistory();
    throw error;
  }

  if (text.trim() === '') return emptyHistory();

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `${path} exists but is not valid JSON, so appending to it would lose data.`,
      {
        cause: error,
        hint: 'Inspect the file on the `status` branch. If it is beyond repair, delete it: the next daily run recreates it and only the historical detail is lost.',
      }
    );
  }

  return normalise(parsed, path);
}

/**
 * @param {unknown} parsed
 * @param {string} path
 * @returns {History}
 */
function normalise(parsed, path) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${path} is valid JSON but not a Pulse history object.`);
  }
  const history = /** @type {Partial<History>} */ (parsed);
  if (history.version !== undefined && history.version > HISTORY_VERSION) {
    throw new ConfigError(
      `${path} was written by a newer version of Pulse (history version ${history.version}, this build understands ${HISTORY_VERSION}).`,
      { hint: 'Update the checkout, or delete the file to start a fresh history.' }
    );
  }
  return {
    version: HISTORY_VERSION,
    lastRun: typeof history.lastRun === 'string' ? history.lastRun : null,
    targets: Object.fromEntries(
      Object.entries(history.targets ?? {}).map(([id, target]) => [
        id,
        {
          ...target,
          name: target?.name ?? id,
          runs: Array.isArray(target?.runs) ? target.runs : [],
          months: Array.isArray(target?.months) ? target.months : [],
        },
      ])
    ),
  };
}

/**
 * Append one run's results. Targets absent from `results` keep their history
 * untouched, so re-checking a single target with `--target` never truncates
 * everything else.
 *
 * @param {History} history
 * @param {import('./types.js').RunResult[]} results
 * @param {{ now?: Date }} [options]
 * @returns {History} A new object; the input is not mutated.
 */
export function appendRun(history, results, options = {}) {
  const now = options.now ?? new Date();
  /** @type {History} */
  const next = {
    version: HISTORY_VERSION,
    lastRun: now.toISOString(),
    targets: { ...history.targets },
  };

  for (const result of results) {
    const existing = next.targets[result.id];
    /** @type {HistoryRun} */
    const run = {
      t: result.checkedAt,
      ok: result.ok,
      ms: result.durationMs,
      a: result.attempts,
    };
    if (result.statusCode !== undefined) run.s = result.statusCode;
    if (!result.ok && result.error) run.e = result.error;

    next.targets[result.id] = {
      // Metadata always follows the config, so renaming a project in
      // targets.json renames it on the dashboard without losing its history.
      name: result.name,
      platform: result.platform,
      publicUrl: result.publicUrl,
      notes: result.notes,
      type: result.type,
      tier: result.tier,
      runs: [...(existing?.runs ?? []), run],
      months: existing?.months ?? [],
    };
  }

  return next;
}

/**
 * Move runs older than the detail window into monthly aggregates, and drop
 * monthly aggregates older than `MONTHLY_RETENTION` months.
 *
 * @param {History} history
 * @param {{ now?: Date, retentionDays?: number, monthlyRetention?: number }} [options]
 * @returns {History} A new object; the input is not mutated.
 */
export function pruneHistory(history, options = {}) {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? DETAIL_RETENTION_DAYS;
  const monthlyRetention = options.monthlyRetention ?? MONTHLY_RETENTION;
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  /** @type {Record<string, HistoryTarget>} */
  const targets = {};

  for (const [id, target] of Object.entries(history.targets)) {
    /** @type {HistoryRun[]} */
    const kept = [];
    /** @type {Map<string, HistoryRun[]>} */
    const expiring = new Map();

    for (const run of target.runs) {
      const at = Date.parse(run.t);
      // A run with an unparseable timestamp cannot be bucketed and cannot be
      // aged out; dropping it is better than keeping it forever.
      if (Number.isNaN(at)) continue;
      if (at >= cutoff) {
        kept.push(run);
        continue;
      }
      const month = run.t.slice(0, 7);
      const bucket = expiring.get(month) ?? [];
      bucket.push(run);
      expiring.set(month, bucket);
    }

    let months = [...target.months];
    for (const [month, runs] of expiring) {
      const index = months.findIndex((entry) => entry.m === month);
      const rolled = rollUp(month, runs);
      months =
        index === -1
          ? [...months, rolled]
          : months.map((entry, i) => (i === index ? mergeMonths(entry, rolled) : entry));
    }

    months.sort((a, b) => a.m.localeCompare(b.m));
    if (months.length > monthlyRetention) months = months.slice(months.length - monthlyRetention);

    kept.sort((a, b) => a.t.localeCompare(b.t));
    targets[id] = { ...target, runs: kept, months };
  }

  return { version: HISTORY_VERSION, lastRun: history.lastRun, targets };
}

/**
 * @param {string} month `YYYY-MM`.
 * @param {HistoryRun[]} runs
 * @returns {HistoryMonth}
 */
export function rollUp(month, runs) {
  const ok = runs.filter((run) => run.ok).length;
  const durations = runs.map((run) => run.ms).sort((a, b) => a - b);
  return {
    m: month,
    total: runs.length,
    ok,
    uptime: round(runs.length === 0 ? 0 : (ok / runs.length) * 100, 1),
    meanMs: Math.round(durations.reduce((sum, ms) => sum + ms, 0) / (durations.length || 1)),
    p95Ms: percentile(durations, 0.95),
  };
}

/**
 * Merge a freshly rolled-up bucket into an existing one for the same month.
 *
 * This happens when the 90-day boundary falls mid-month, so a month is rolled
 * up over two or three consecutive daily runs. Counts and the mean stay exact
 * because they are weighted by sample count. p95 cannot be recovered exactly
 * from two summaries, so it is weighted the same way: an approximation, and
 * documented as one wherever it is displayed.
 *
 * @param {HistoryMonth} existing
 * @param {HistoryMonth} incoming
 * @returns {HistoryMonth}
 */
export function mergeMonths(existing, incoming) {
  const total = existing.total + incoming.total;
  const ok = existing.ok + incoming.ok;
  const weighted = (/** @type {number} */ a, /** @type {number} */ b) =>
    Math.round((a * existing.total + b * incoming.total) / (total || 1));
  return {
    m: existing.m,
    total,
    ok,
    uptime: round(total === 0 ? 0 : (ok / total) * 100, 1),
    meanMs: weighted(existing.meanMs, incoming.meanMs),
    p95Ms: weighted(existing.p95Ms, incoming.p95Ms),
  };
}

/**
 * @param {number[]} sorted Ascending.
 * @param {number} fraction
 * @returns {number}
 */
export function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

/**
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * @param {string} path
 * @param {History} history
 * @returns {Promise<void>}
 */
export async function saveHistory(path, history) {
  await mkdir(dirname(path), { recursive: true });
  // Trailing newline and stable key order keep the daily diff to the lines that
  // actually changed, which makes the status branch readable in a browser.
  await writeFile(path, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}
