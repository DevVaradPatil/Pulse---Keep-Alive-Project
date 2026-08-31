import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEnv } from '../src/config/load.js';
import { ConfigError } from '../src/lib/errors.js';

test('without PULSE_SECRETS_JSON the environment is returned untouched', () => {
  const env = { A: '1' };
  assert.equal(resolveEnv(env), env);
});

test('injected secrets are merged in, so a new project needs no workflow edit', () => {
  const merged = resolveEnv({
    PATH: '/usr/bin',
    PULSE_SECRETS_JSON: JSON.stringify({ DEMO_ANON_KEY: 'abc', OTHER: 'xyz' }),
  });

  assert.equal(merged.DEMO_ANON_KEY, 'abc');
  assert.equal(merged.OTHER, 'xyz');
  assert.equal(merged.PATH, '/usr/bin', 'the ambient environment survives');
});

test('empty and non-string entries are ignored rather than masking a real value', () => {
  const merged = resolveEnv({
    KEPT: 'from-shell',
    PULSE_SECRETS_JSON: JSON.stringify({ KEPT: '', NUMERIC: 42, NULLY: null }),
  });

  assert.equal(merged.KEPT, 'from-shell');
  assert.equal(merged.NUMERIC, undefined);
  assert.equal(merged.NULLY, undefined);
});

test('malformed injected JSON fails loudly instead of silently losing every secret', () => {
  assert.throws(
    () => resolveEnv({ PULSE_SECRETS_JSON: '{oops' }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.format(), /toJSON\(secrets\)/);
      return true;
    }
  );
});
