import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRun,
  emptyHistory,
  loadHistory,
  mergeMonths,
  percentile,
  pruneHistory,
  rollUp,
  saveHistory,
} from '../src/history.js';
import { ConfigError } from '../src/lib/errors.js';

/**
 * @param {object} [overrides]
 * @returns {import('../src/types.js').RunResult}
 */
function result(overrides = {}) {
  return {
    id: 'demo',
    name: 'Demo',
    type: 'http',
    tier: 'daily',
    ok: true,
    durationMs: 120,
    attempts: 1,
    statusCode: 200,
    checkedAt: '2026-08-31T21:17:00.000Z',
    ...overrides,
  };
}

/**
 * @param {string} isoDay
 * @param {boolean} ok
 * @param {number} ms
 */
function run(isoDay, ok, ms) {
  return { t: `${isoDay}T02:17:00.000Z`, ok, ms, a: 1 };
}

test('appendRun records the fields the dashboard needs', () => {
  const history = appendRun(emptyHistory(), [result({ platform: 'vercel+supabase' })], {
    now: new Date('2026-08-31T21:18:00.000Z'),
  });

  assert.equal(history.lastRun, '2026-08-31T21:18:00.000Z');
  assert.deepEqual(history.targets.demo.runs, [
    { t: '2026-08-31T21:17:00.000Z', ok: true, ms: 120, a: 1, s: 200 },
  ]);
  assert.equal(history.targets.demo.platform, 'vercel+supabase');
});

test('appendRun stores the error only for failures', () => {
  const history = appendRun(emptyHistory(), [
    result({ ok: false, error: 'expected HTTP 200 but got 503' }),
  ]);
  assert.equal(history.targets.demo.runs[0].e, 'expected HTTP 200 but got 503');
  assert.equal(appendRun(emptyHistory(), [result()]).targets.demo.runs[0].e, undefined);
});

test('appendRun leaves other targets untouched, so --target does not truncate history', () => {
  let history = appendRun(emptyHistory(), [result({ id: 'a' }), result({ id: 'b' })]);
  history = appendRun(history, [result({ id: 'a', durationMs: 300 })]);

  assert.equal(history.targets.a.runs.length, 2);
  assert.equal(history.targets.b.runs.length, 1);
});

test('appendRun follows a rename in the config without losing history', () => {
  let history = appendRun(emptyHistory(), [result({ name: 'Old Name' })]);
  history = appendRun(history, [result({ name: 'New Name' })]);

  assert.equal(history.targets.demo.name, 'New Name');
  assert.equal(history.targets.demo.runs.length, 2);
});

test('pruning rolls runs older than the retention window into monthly aggregates', () => {
  const now = new Date('2026-08-31T00:00:00.000Z');
  let history = emptyHistory();
  history.targets.demo = {
    name: 'Demo',
    runs: [
      run('2026-01-10', true, 100),
      run('2026-01-11', false, 900),
      run('2026-01-12', true, 200),
      run('2026-01-13', true, 300),
      run('2026-08-30', true, 150), // inside the 90-day window
    ],
    months: [],
  };

  history = pruneHistory(history, { now });

  assert.deepEqual(
    history.targets.demo.runs.map((r) => r.t),
    ['2026-08-30T02:17:00.000Z'],
    'only recent detail survives'
  );
  assert.deepEqual(history.targets.demo.months, [
    { m: '2026-01', total: 4, ok: 3, uptime: 75, meanMs: 375, p95Ms: 900 },
  ]);
});

test('pruning is idempotent and keeps the file from growing without bound', () => {
  const now = new Date('2026-08-31T00:00:00.000Z');
  const history = emptyHistory();
  history.targets.demo = { name: 'Demo', runs: [run('2026-01-10', true, 100)], months: [] };

  const once = pruneHistory(history, { now });
  const twice = pruneHistory(once, { now });
  assert.deepEqual(twice, once);
});

test('a month rolled up across two prunes keeps exact counts and a weighted mean', () => {
  const merged = mergeMonths(
    { m: '2026-01', total: 10, ok: 10, uptime: 100, meanMs: 100, p95Ms: 200 },
    { m: '2026-01', total: 10, ok: 5, uptime: 50, meanMs: 300, p95Ms: 400 }
  );
  assert.deepEqual(merged, {
    m: '2026-01',
    total: 20,
    ok: 15,
    uptime: 75,
    meanMs: 200,
    p95Ms: 300,
  });
});

test('monthly aggregates are capped, oldest first', () => {
  const now = new Date('2026-08-31T00:00:00.000Z');
  const history = emptyHistory();
  history.targets.demo = {
    name: 'Demo',
    runs: [],
    months: Array.from({ length: 30 }, (_, i) => ({
      m: `20${24 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`,
      total: 30,
      ok: 30,
      uptime: 100,
      meanMs: 100,
      p95Ms: 100,
    })),
  };

  const pruned = pruneHistory(history, { now, monthlyRetention: 24 });
  assert.equal(pruned.targets.demo.months.length, 24);
  assert.equal(pruned.targets.demo.months.at(-1)?.m, '2026-06');
});

test('rollUp computes uptime, mean and p95', () => {
  const rolled = rollUp('2026-01', [
    run('2026-01-01', true, 100),
    run('2026-01-02', true, 200),
    run('2026-01-03', false, 300),
    run('2026-01-04', true, 400),
  ]);
  assert.deepEqual(rolled, { m: '2026-01', total: 4, ok: 3, uptime: 75, meanMs: 250, p95Ms: 400 });
});

test('percentile picks the right sample and copes with an empty set', () => {
  assert.equal(percentile([], 0.95), 0);
  assert.equal(percentile([10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
});

test('a run with an unparseable timestamp is dropped rather than kept forever', () => {
  const history = emptyHistory();
  history.targets.demo = {
    name: 'Demo',
    runs: [{ t: 'not-a-date', ok: true, ms: 1, a: 1 }],
    months: [],
  };
  const pruned = pruneHistory(history, { now: new Date('2026-08-31T00:00:00.000Z') });
  assert.deepEqual(pruned.targets.demo.runs, []);
});

test('a missing history file loads as an empty history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-history-'));
  assert.deepEqual(await loadHistory(join(dir, 'nope.json')), emptyHistory());
});

test('a malformed history file fails loudly instead of being silently overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-history-'));
  const path = join(dir, 'history.json');
  await writeFile(path, '{ this is not json', 'utf8');
  await assert.rejects(loadHistory(path), ConfigError);
});

test('a history from a newer Pulse is refused rather than downgraded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-history-'));
  const path = join(dir, 'history.json');
  await writeFile(path, JSON.stringify({ version: 99, targets: {} }), 'utf8');
  await assert.rejects(loadHistory(path), /newer version of Pulse/);
});

test('save then load round-trips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-history-'));
  const path = join(dir, 'nested', 'history.json');
  const history = appendRun(emptyHistory(), [result()], {
    now: new Date('2026-08-31T21:18:00.000Z'),
  });
  await saveHistory(path, history);
  // Round-tripping through JSON drops the undefined optional fields, which is
  // exactly what the committed file should contain.
  assert.deepEqual(await loadHistory(path), JSON.parse(JSON.stringify(history)));
});
