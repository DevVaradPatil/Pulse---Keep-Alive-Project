import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { loadConfig, readConfigSource } from '../src/config/load.js';
import {
  buildRedactor,
  emitActionsMasks,
  sensitiveValuesFor,
  stripIdentifiers,
} from '../src/lib/mask.js';
import { ConfigError } from '../src/lib/errors.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/targets.fixture.json', import.meta.url));
const env = {
  FIXTURE_SUPABASE_ANON_KEY: 'anon-key-value-long-enough',
  FIXTURE_MONGO_URI: 'mongodb+srv://user:pw@cluster.example/test',
};

// --- where the config comes from -------------------------------------------

test('an explicit --config path beats the PULSE_TARGETS_JSON secret', async () => {
  const source = await readConfigSource({
    configPath: FIXTURE,
    env: { PULSE_TARGETS_JSON: '{"targets":[]}' },
  });
  assert.equal(source.fromSecret, false);
  assert.equal(source.label, FIXTURE);
});

test('PULSE_TARGETS_JSON supplies the whole config, so nothing identifying is committed', async () => {
  const inline = await readFile(FIXTURE, 'utf8');
  const source = await readConfigSource({ env: { PULSE_TARGETS_JSON: inline } });

  assert.equal(source.fromSecret, true);
  assert.equal(source.label, 'PULSE_TARGETS_JSON');
  assert.equal(/** @type {any} */ (source.raw).targets.length, 4);
});

test('a whitespace-only PULSE_TARGETS_JSON falls through to the committed file', async () => {
  const source = await readConfigSource({ env: { PULSE_TARGETS_JSON: '   ' } });
  assert.equal(source.fromSecret, false);
  assert.match(source.label, /targets\.json$/);
});

test('a malformed PULSE_TARGETS_JSON explains how to check it, and never half-loads', async () => {
  await assert.rejects(
    readConfigSource({ env: { PULSE_TARGETS_JSON: '{"targets":[' } }),
    (/** @type {any} */ error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.format(), /entire contents of a targets file/);
      return true;
    }
  );
});

test('a config from a secret is validated exactly like a committed one', async () => {
  const inline = JSON.stringify({
    targets: [{ id: 'x', name: 'X', type: 'http', tier: 'weekly', url: 'https://x.example' }],
  });
  await assert.rejects(loadConfig({ env: { ...env, PULSE_TARGETS_JSON: inline } }), (error) => {
    assert.match(/** @type {ConfigError} */ (error).format(), /must be one of "daily", "frequent"/);
    return true;
  });
});

// --- publication policy -----------------------------------------------------

test('a committed config publishes details by default', async () => {
  const config = await loadConfig({ configPath: FIXTURE, env });
  assert.equal(config.publishDetails, true);
  assert.equal(config.fromSecret, false);
});

test('a config from a secret does not republish what it was hiding', async () => {
  const inline = await readFile(FIXTURE, 'utf8');
  const config = await loadConfig({ env: { ...env, PULSE_TARGETS_JSON: inline } });

  assert.equal(config.fromSecret, true);
  assert.equal(
    config.publishDetails,
    false,
    'privacy by default in the mode you chose for privacy'
  );
});

test('an explicit privacy setting overrides the default in both directions', async () => {
  const base = JSON.parse(await readFile(FIXTURE, 'utf8'));

  const forced = await loadConfig({
    env: {
      ...env,
      PULSE_TARGETS_JSON: JSON.stringify({ ...base, privacy: { publishDetails: true } }),
    },
  });
  assert.equal(forced.publishDetails, true);

  const hidden = await loadConfig({
    configPath: FIXTURE,
    env,
    // A committed config that still wants ids-only output.
  });
  assert.equal(hidden.publishDetails, true, 'unchanged without an explicit setting');
});

test('stripIdentifiers keeps the failure legible but drops everything identifying', () => {
  const [stripped] = stripIdentifiers([
    /** @type {any} */ ({
      id: 'notes-api',
      name: 'Personal Notes API',
      platform: 'render+postgres',
      publicUrl: 'https://notes.example',
      notes: 'runs SELECT 1',
      type: 'http',
      tier: 'daily',
      ok: false,
      durationMs: 12,
      attempts: 3,
      error: 'expected HTTP 200 but got 503',
      checkedAt: '2026-08-31T00:00:00.000Z',
    }),
  ]);

  assert.equal(stripped.name, 'notes-api', 'the name falls back to the id');
  assert.equal(stripped.platform, undefined);
  assert.equal(stripped.publicUrl, undefined);
  assert.equal(stripped.notes, undefined);
  assert.equal(stripped.error, 'expected HTTP 200 but got 503', 'still debuggable');
  assert.equal(stripped.ok, false);
  assert.equal(stripped.attempts, 3);
});

// --- masking ----------------------------------------------------------------

test('secret values are masked, and identifiers only when the config was hidden', () => {
  /** @type {any} */
  const targets = [
    {
      id: 'demo',
      requiredSecrets: ['ANON_KEY'],
      url: 'https://secret-project.example/api/health',
      publicUrl: 'https://secret-project.example',
    },
  ];
  const environment = { ANON_KEY: 'anon-key-value-long-enough' };

  const plain = sensitiveValuesFor(targets, environment);
  assert.deepEqual(plain, ['anon-key-value-long-enough']);

  const hidden = sensitiveValuesFor(targets, environment, { includeIdentifiers: true });
  assert.ok(hidden.includes('https://secret-project.example/api/health'));
  assert.ok(hidden.includes('secret-project.example'), 'the bare host too');
});

test('a mongo connection string is masked in every mode', () => {
  const values = sensitiveValuesFor(
    /** @type {any} */ ([{ id: 'm', connectionString: 'mongodb+srv://u:pw@cluster.example/db' }]),
    {}
  );
  assert.deepEqual(values, ['mongodb+srv://u:pw@cluster.example/db']);
});

test('the redactor replaces the longest match first', () => {
  const redact = buildRedactor(['https://secret.example/api/health', 'secret.example']);
  assert.equal(redact('GET https://secret.example/api/health failed'), 'GET *** failed');
});

test('values too short to mask safely are left alone', () => {
  const redact = buildRedactor(['abc', undefined, 'long-enough-value']);
  assert.equal(redact('abc and long-enough-value'), 'abc and ***');
});

test('add-mask commands are emitted inside Actions and nowhere else', () => {
  /** @type {string[]} */
  const lines = [];
  const written = emitActionsMasks(['a-secret-value'], {
    env: { GITHUB_ACTIONS: 'true' },
    write: (line) => lines.push(line),
  });

  assert.equal(written, 1);
  assert.deepEqual(lines, ['::add-mask::a-secret-value']);

  lines.length = 0;
  assert.equal(emitActionsMasks(['a-secret-value'], { env: {}, write: (l) => lines.push(l) }), 0);
  assert.deepEqual(lines, [], 'no workflow-command noise in a normal terminal');
});

test('a newline inside a secret cannot truncate the mask command', () => {
  /** @type {string[]} */
  const lines = [];
  emitActionsMasks(['line-one\nline-two-secret'], {
    env: { GITHUB_ACTIONS: 'true' },
    write: (line) => lines.push(line),
  });
  assert.deepEqual(lines, ['::add-mask::line-one line-two-secret']);
});
