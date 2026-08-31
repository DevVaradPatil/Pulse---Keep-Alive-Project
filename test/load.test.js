import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILT_IN_DEFAULTS, loadConfig, selectTargets } from '../src/config/load.js';
import { ConfigError, MissingSecretError } from '../src/lib/errors.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/targets.fixture.json', import.meta.url));
const env = {
  FIXTURE_SUPABASE_ANON_KEY: 'anon-key-value',
  FIXTURE_MONGO_URI: 'mongodb+srv://user:pw@cluster.example/test',
};

test('loads the fixture, resolves secrets and merges defaults', async () => {
  const config = await loadConfig({ configPath: FIXTURE, env });

  assert.equal(config.targets.length, 3, 'the disabled target is excluded');
  assert.equal(config.disabledCount, 1);
  assert.equal(config.defaults.concurrency, 3, 'file defaults win');
  assert.equal(
    config.defaults.backoffBaseMs,
    BUILT_IN_DEFAULTS.backoffBaseMs,
    'built-ins fill the gaps'
  );

  const supabase = config.targets.find((target) => target.id === 'fixture-supabase');
  assert.equal(supabase?.apiKey, 'anon-key-value', 'the ${SECRET} was resolved');
  assert.equal(supabase?.timeoutMs, 15000, 'inherits the file default');
  assert.equal(supabase?.retries, 1);

  const render = config.targets.find((target) => target.id === 'fixture-render');
  assert.equal(render?.timeoutMs, 30000, 'per-target override wins over the default');
});

test('a missing secret stops the run before a single request is sent', async () => {
  await assert.rejects(loadConfig({ configPath: FIXTURE, env: {} }), (/** @type {any} */ error) => {
    assert.ok(error instanceof MissingSecretError);
    assert.match(
      error.format(),
      /FIXTURE_SUPABASE_ANON_KEY \(used at targets\[fixture-supabase\]\.apiKey\)/
    );
    assert.match(error.format(), /export FIXTURE_SUPABASE_ANON_KEY/);
    return true;
  });
});

test('--skip-secrets tolerates unset secrets for a dry run', async () => {
  const config = await loadConfig({ configPath: FIXTURE, env: {}, allowMissingSecrets: true });
  const supabase = config.targets.find((target) => target.id === 'fixture-supabase');
  assert.equal(supabase?.apiKey, '${FIXTURE_SUPABASE_ANON_KEY}');
});

test('an invalid config reports every problem at once and never partially loads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-config-'));
  const path = join(dir, 'targets.json');
  await writeFile(
    path,
    JSON.stringify({
      targets: [
        { id: 'dupe', name: 'A', type: 'http', tier: 'daily', url: 'https://a.example' },
        { id: 'dupe', name: 'B', type: 'http', tier: 'weekly', url: 'https://b.example' },
      ],
    }),
    'utf8'
  );

  await assert.rejects(loadConfig({ configPath: path, env }), (/** @type {any} */ error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.format(), /must be one of "daily", "frequent"/);
    return true;
  });
});

test('a JSON syntax error names the likely cause', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-config-'));
  const path = join(dir, 'targets.json');
  await writeFile(path, '{ "targets": [], }', 'utf8');

  await assert.rejects(loadConfig({ configPath: path, env }), (/** @type {any} */ error) => {
    assert.match(error.format(), /not valid JSON/);
    assert.match(error.format(), /trailing comma/);
    return true;
  });
});

test('a missing config file says how to fix it', async () => {
  await assert.rejects(
    loadConfig({ configPath: join(tmpdir(), 'definitely-not-here.json'), env }),
    (/** @type {any} */ error) => {
      assert.match(error.format(), /Cannot find/);
      assert.match(error.format(), /--config <path>/);
      return true;
    }
  );
});

test('the daily run covers every enabled target, whatever its tier', async () => {
  const { targets } = await loadConfig({ configPath: FIXTURE, env });
  assert.deepEqual(
    selectTargets(targets, { tier: 'daily' }).map((target) => target.id),
    ['fixture-supabase', 'fixture-render', 'fixture-mongo'],
    'otherwise a frequent-tier target would never get a history entry'
  );
});

test('the frequent run covers only frequent-tier targets', async () => {
  const { targets } = await loadConfig({ configPath: FIXTURE, env });
  assert.deepEqual(
    selectTargets(targets, { tier: 'frequent' }).map((target) => target.id),
    ['fixture-render']
  );
});

test('--target narrows to a single project, and combines with --tier', async () => {
  const { targets } = await loadConfig({ configPath: FIXTURE, env });
  assert.deepEqual(
    selectTargets(targets, { id: 'fixture-mongo' }).map((target) => target.id),
    ['fixture-mongo']
  );
  assert.deepEqual(selectTargets(targets, { tier: 'frequent', id: 'fixture-mongo' }), []);
});
