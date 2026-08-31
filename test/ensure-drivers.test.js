import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const SCRIPT = fileURLToPath(new URL('../src/tools/ensure-drivers.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/targets.fixture.json', import.meta.url));

/**
 * Regression test: `ensure-drivers.js` used to read only the committed
 * `config/targets.json`, ignoring the `PULSE_TARGETS_JSON` secret. In the
 * hidden-targets mode that file is an empty stub, so a mongo target that only
 * ever existed in the secret was invisible to this step - it would report "no
 * drivers needed", and the run would then fail with ERR_MODULE_NOT_FOUND on
 * `mongodb` because the driver was never installed.
 *
 * These run the real script as a subprocess (not npm-installing anything -
 * `--help`-style dry inspection isn't available, so this only checks what it
 * *decides* to do, not the actual `npm install`).
 */

test('a mongo target that only exists in PULSE_TARGETS_JSON is detected', async () => {
  const config = JSON.parse(await readFile(FIXTURE, 'utf8'));
  assert.ok(
    config.targets.some((/** @type {any} */ t) => t.type === 'mongo'),
    'fixture must contain a mongo target for this test to mean anything'
  );

  const result = spawnSync(process.execPath, [SCRIPT, '--tier', 'daily'], {
    encoding: 'utf8',
    env: { ...process.env, PULSE_TARGETS_JSON: JSON.stringify(config) },
  });

  assert.match(result.stdout, /Checking driver needs against PULSE_TARGETS_JSON/);
  assert.match(result.stdout, /Installing driver\(s\) for this run: mongodb/);
});

test('an explicit --config still wins over the secret', async () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--config', FIXTURE, '--tier', 'daily'], {
    encoding: 'utf8',
    env: { ...process.env, PULSE_TARGETS_JSON: '{"targets":[]}' },
  });

  assert.match(result.stdout, new RegExp(`Checking driver needs against ${escapeRegExp(FIXTURE)}`));
  assert.match(result.stdout, /Installing driver\(s\) for this run: mongodb/);
});

test('a config with no mongo target installs nothing, from either source', async () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--tier', 'daily'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PULSE_TARGETS_JSON: JSON.stringify({
        targets: [{ id: 'x', name: 'X', type: 'http', tier: 'daily', url: 'https://x.example' }],
      }),
    },
  });

  assert.match(result.stdout, /No database drivers needed/);
});

test('the frequent tier only looks at frequent-tier targets, hidden config included', async () => {
  const config = JSON.parse(await readFile(FIXTURE, 'utf8'));
  // In the fixture the mongo target is tier "daily", not "frequent".
  const result = spawnSync(process.execPath, [SCRIPT, '--tier', 'frequent'], {
    encoding: 'utf8',
    env: { ...process.env, PULSE_TARGETS_JSON: JSON.stringify(config) },
  });

  assert.match(result.stdout, /No database drivers needed/);
});

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
