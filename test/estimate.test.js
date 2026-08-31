import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateWorkflows, readSchedules, runsPerMonth } from '../src/tools/estimate-minutes.js';

test('counts runs per 30-day month for the schedules this repo uses', () => {
  assert.equal(runsPerMonth('17 21 * * *'), 30, 'daily');
  assert.equal(runsPerMonth('*/10 * * * *'), 4320, 'every ten minutes');
  assert.equal(runsPerMonth('43 4 * * 1'), 4, 'weekly, ~4 Mondays in 30 days');
  assert.equal(runsPerMonth('*/30 * * * *'), 1440);
  assert.equal(runsPerMonth('0 * * * *'), 720, 'hourly');
});

test('handles lists and ranges', () => {
  assert.equal(runsPerMonth('0,30 * * * *'), 1440);
  assert.equal(runsPerMonth('0 9-17 * * *'), 270, '9 hours a day for 30 days');
});

test('rejects an expression that is not five fields', () => {
  assert.throws(() => runsPerMonth('*/10 * * *'), /five-field cron/);
});

test('reads cron lines whether quoted, bare, or followed by a comment', () => {
  const { crons } = readSchedules(
    [
      'on:',
      '  schedule:',
      "    - cron: '17 21 * * *'",
      '    - cron: "0 6 * * *"',
      '    - cron: 43 4 * * 1 # Mondays, 04:43 UTC',
      'jobs:',
    ].join('\n')
  );
  assert.deepEqual(crons, ['17 21 * * *', '0 6 * * *', '43 4 * * 1']);
});

test('refuses to silently understate a schedule it cannot parse', () => {
  assert.throws(
    () => readSchedules(['on:', '  schedule:', '    - { cron: "*/5 * * * *" }'].join('\n')),
    /could not read any cron expression/
  );
});

test('detects a job gated behind a repository variable as costing nothing', () => {
  const gatedYaml = [
    'on:',
    '  schedule:',
    "    - cron: '*/10 * * * *'",
    'jobs:',
    '  heartbeat:',
    "    if: ${{ vars.PULSE_TIER_FREQUENT == 'enabled' }}",
    '    runs-on: ubuntu-latest',
  ].join('\n');

  assert.equal(readSchedules(gatedYaml).gated, true);
  assert.equal(readSchedules(gatedYaml.replace(/^ {4}if:.*$/m, '')).gated, false);
});

test('the shipped workflows fit a private repository on the free plan', async () => {
  const rows = await estimateWorkflows();
  const total = rows.reduce((sum, row) => sum + row.minutes, 0);

  assert.ok(rows.length >= 3, 'daily, frequent and keepalive all counted');
  assert.ok(
    total <= 2000,
    `scheduled workflows must fit the 2,000-minute private budget out of the box, got ${total}`
  );

  const frequent = rows.find((row) => row.file.includes('frequent'));
  assert.equal(frequent?.gated, true, 'the expensive tier ships gated off');
  assert.equal(frequent?.minutes, 0);
});
