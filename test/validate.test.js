import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_SCHEMA_PATH } from '../src/config/load.js';
import { validateConfig } from '../src/config/validate.js';

const schema = JSON.parse(await readFile(DEFAULT_SCHEMA_PATH, 'utf8'));

/**
 * @param {object} [overrides]
 * @returns {Record<string, any>}
 */
function httpTarget(overrides = {}) {
  return {
    id: 'demo',
    name: 'Demo',
    type: 'http',
    tier: 'daily',
    url: 'https://demo.example/api/health',
    expectBodyContains: '"ok":true',
    ...overrides,
  };
}

/**
 * @param {Array<Record<string, any>>} targets
 */
function validate(targets) {
  return validateConfig({ $schema: './targets.schema.json', targets }, schema);
}

test('the shipped config and the example config both validate', async () => {
  for (const name of ['targets.json', 'targets.example.json']) {
    const config = JSON.parse(
      await readFile(new URL(`../config/${name}`, import.meta.url), 'utf8')
    );
    const { errors } = validateConfig(config, schema);
    assert.deepEqual(errors, [], `${name} should be valid`);
  }
});

test('rejects an unknown field with a suggestion', () => {
  const { errors } = validate([httpTarget({ expectStatuss: 200 })]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown property "expectStatuss".*did you mean "expectStatus"/);
});

test('rejects a field that belongs to another check type', () => {
  const { errors } = validate([httpTarget({ table: 'heartbeat' })]);
  assert.match(errors.join('\n'), /only valid on targets of type "supabase"/);
});

test('rejects duplicate ids', () => {
  const { errors } = validate([httpTarget(), httpTarget({ name: 'Copy' })]);
  assert.match(errors.join('\n'), /duplicate id "demo"/);
});

test('rejects a missing required field for the declared type', () => {
  const { errors } = validate([{ id: 'x', name: 'X', type: 'supabase', tier: 'daily' }]);
  const joined = errors.join('\n');
  assert.match(joined, /missing the required property "supabaseUrl"/);
  assert.match(joined, /missing the required property "apiKey"/);
});

test('rejects an id that is not a slug, and an unknown tier', () => {
  const { errors } = validate([httpTarget({ id: 'Not A Slug', tier: 'hourly' })]);
  const joined = errors.join('\n');
  assert.match(joined, /does not match the required pattern/);
  assert.match(joined, /must be one of "daily", "frequent"/);
});

test('rejects a secret reference that is not declared in requiredSecrets', () => {
  const { errors } = validate([httpTarget({ headers: { authorization: 'Bearer ${DEMO_TOKEN}' } })]);
  assert.match(errors.join('\n'), /uses \$\{DEMO_TOKEN\} but does not list it in requiredSecrets/);
});

test('rejects a declared secret that is never used', () => {
  const { errors } = validate([httpTarget({ requiredSecrets: ['STALE_SECRET'] })]);
  assert.match(errors.join('\n'), /declares requiredSecrets entry "STALE_SECRET" but never uses/);
});

test('accepts a target whose secrets line up in both directions', () => {
  const { errors } = validate([
    httpTarget({
      headers: { authorization: 'Bearer ${DEMO_TOKEN}' },
      requiredSecrets: ['DEMO_TOKEN'],
    }),
  ]);
  assert.deepEqual(errors, []);
});

test('rejects a literal Mongo connection string in a public repo', () => {
  const { errors } = validate([
    {
      id: 'cluster',
      name: 'Cluster',
      type: 'mongo',
      tier: 'daily',
      connectionString: 'mongodb+srv://user:hunter2@cluster.mongodb.net',
    },
  ]);
  assert.match(errors.join('\n'), /connectionString must be a \$\{SECRET\} reference/);
});

test('rejects a literal credential in a header', () => {
  const { errors } = validate([httpTarget({ headers: { 'x-api-key': 'sk-live-abc' } })]);
  assert.match(errors.join('\n'), /header "x-api-key" has a literal value/);
});

test('rejects a body on a GET request', () => {
  const { errors } = validate([httpTarget({ body: { ping: true } })]);
  assert.match(errors.join('\n'), /GET request cannot carry a body/);
});

test('warns, but does not fail, on an http check with no body assertion', () => {
  const bare = httpTarget();
  delete bare.expectBodyContains;
  const { errors, warnings } = validate([bare]);
  assert.deepEqual(errors, []);
  assert.match(warnings.join('\n'), /cached 200 from a CDN edge/);
});

test('warns about more than one frequent-tier target (Render instance-hours)', () => {
  const { errors, warnings } = validate([
    httpTarget({ id: 'a', tier: 'frequent' }),
    httpTarget({ id: 'b', tier: 'frequent' }),
  ]);
  assert.deepEqual(errors, []);
  assert.match(warnings.join('\n'), /750 instance-hours per ACCOUNT/);
});

test('fails if a check type exists in only one of the registry and the schema', () => {
  const drifted = structuredClone(schema);
  drifted.$defs.target.properties.type.enum = ['http', 'supabase', 'mongo', 'redis'];
  const { errors } = validateConfig({ targets: [] }, drifted);
  assert.match(errors.join('\n'), /no src\/checks\/redis\.js registered/);
});

test('fails loudly if the schema grows a keyword the validator does not implement', () => {
  const drifted = structuredClone(schema);
  drifted.$defs.target.properties.name.format = 'email';
  assert.throws(() => validateConfig({ targets: [] }, drifted), /does not implement/);
});
