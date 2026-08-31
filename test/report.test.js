import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMarkdown, renderTable, summarise, writeStepSummary } from '../src/report.js';
import { buildRedactor } from '../src/run.js';

/** @type {import('../src/types.js').RunResult[]} */
const results = [
  {
    id: 'alpha',
    name: 'Alpha',
    type: 'supabase',
    tier: 'daily',
    ok: true,
    durationMs: 143,
    attempts: 1,
    statusCode: 200,
    detail: 'PostgREST 200 · select id from heartbeat · 1 row',
    checkedAt: '2026-08-31T21:17:00.000Z',
    publicUrl: 'https://alpha.example',
  },
  {
    id: 'beta',
    name: 'Beta',
    type: 'http',
    tier: 'frequent',
    ok: false,
    durationMs: 30001,
    attempts: 3,
    error: 'timed out after 30000 ms',
    checkedAt: '2026-08-31T21:17:30.000Z',
  },
];

test('summarise counts what the exit code depends on', () => {
  assert.deepEqual(summarise(results), { total: 2, ok: 1, failed: 1, slowestMs: 30001 });
});

test('the console table aligns columns and shows the error for failures', () => {
  const table = renderTable(results, { colour: false });
  const [header, rule, alpha, beta] = table.split('\n');

  assert.match(header, /^STATUS {2}TARGET {2}TIER {6}TIME {6}TRIES {2}DETAIL$/);
  assert.match(rule, /^-+ {2}-+ {2}-+ {2}-+ {2}-+ {2}-+$/);
  for (const [label, value] of [
    ['STATUS', 'UP'],
    ['TARGET', 'alpha'],
    ['TIER', 'daily'],
    ['TIME', '143 ms'],
  ]) {
    assert.equal(alpha.indexOf(value), header.indexOf(label), `the ${label} column stays aligned`);
  }
  assert.ok(alpha.endsWith('PostgREST 200 · select id from heartbeat · 1 row'));
  assert.ok(beta.startsWith('DOWN'));
  assert.ok(
    beta.endsWith('timed out after 30000 ms'),
    'failures show the error in place of the detail'
  );
});

test('the Markdown summary leads with the failure count and lists failing targets', () => {
  const markdown = renderMarkdown(results, {
    tier: 'daily',
    startedAt: new Date('2026-08-31T21:17:00.000Z'),
    durationMs: 4200,
  });

  assert.match(markdown, /^## Pulse — 1 failing/);
  assert.match(markdown, /\*\*1\/2 up\*\* · `daily` tier/);
  assert.match(markdown, /\[Alpha\]\(https:\/\/alpha\.example\)/);
  assert.match(markdown, /### Failing targets/);
  assert.match(markdown, /timed out after 30000 ms/);
});

test('an all-healthy run says so and omits the failure section', () => {
  const markdown = renderMarkdown([results[0]], {
    startedAt: new Date('2026-08-31T21:17:00.000Z'),
    durationMs: 900,
  });
  assert.match(markdown, /^## Pulse — all healthy/);
  assert.doesNotMatch(markdown, /### Failing targets/);
});

test('pipes in an error message cannot break the Markdown table', () => {
  const markdown = renderMarkdown([{ ...results[1], error: 'got 500 | body: <html>' }], {
    startedAt: new Date(),
    durationMs: 1,
  });
  assert.match(markdown, /got 500 \\\| body/);
});

test('writeStepSummary appends when GITHUB_STEP_SUMMARY is set, and no-ops when it is not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-summary-'));
  const path = join(dir, 'summary.md');

  assert.equal(await writeStepSummary('# hello', { GITHUB_STEP_SUMMARY: path }), true);
  assert.equal(await writeStepSummary('# again', { GITHUB_STEP_SUMMARY: path }), true);
  assert.equal(await readFile(path, 'utf8'), '# hello\n# again\n');

  assert.equal(await writeStepSummary('# nowhere', {}), false);
});

test('resolved secret values are masked everywhere they could be printed or committed', () => {
  const redact = buildRedactor(/** @type {any} */ ([{ requiredSecrets: ['ANON_KEY', 'SHORT'] }]), {
    ANON_KEY: 'super-secret-value',
    SHORT: 'abc',
  });

  assert.equal(redact('apikey=super-secret-value failed'), 'apikey=*** failed');
  assert.equal(redact('the word abc is too short to mask'), 'the word abc is too short to mask');
});
