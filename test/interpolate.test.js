import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSecretRefs, interpolate } from '../src/config/interpolate.js';
import { MissingSecretError } from '../src/lib/errors.js';

test('resolves ${SECRET} references anywhere in the structure', () => {
  const { value } = interpolate(
    {
      apiKey: '${ANON_KEY}',
      headers: { authorization: 'Bearer ${ANON_KEY}' },
      list: ['${OTHER}'],
      untouched: 42,
    },
    { ANON_KEY: 'abc123', OTHER: 'xyz' }
  );

  assert.deepEqual(value, {
    apiKey: 'abc123',
    headers: { authorization: 'Bearer abc123' },
    list: ['xyz'],
    untouched: 42,
  });
});

test('throws rather than pinging with the literal placeholder', () => {
  assert.throws(
    () => interpolate({ apiKey: '${MISSING_KEY}' }, {}),
    (/** @type {any} */ error) => {
      assert.ok(error instanceof MissingSecretError);
      assert.match(error.message, /1 secret referenced/);
      assert.deepEqual(error.problems, ['MISSING_KEY (used at apiKey)']);
      return true;
    }
  );
});

test('an empty environment variable counts as missing', () => {
  assert.throws(() => interpolate({ apiKey: '${EMPTY}' }, { EMPTY: '' }), MissingSecretError);
});

test('reports every missing secret at once, with its config path', () => {
  try {
    interpolate({ a: '${ONE}', nested: { b: '${TWO}' } }, {}, { basePath: 'targets[demo]' });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(error instanceof MissingSecretError);
    assert.deepEqual(error.problems, [
      'ONE (used at targets[demo].a)',
      'TWO (used at targets[demo].nested.b)',
    ]);
  }
});

test('--dry-run --skip-secrets leaves references intact instead of throwing', () => {
  const { value, missing } = interpolate({ apiKey: '${MISSING_KEY}' }, {}, { allowMissing: true });
  assert.deepEqual(value, { apiKey: '${MISSING_KEY}' });
  assert.deepEqual(missing, [{ name: 'MISSING_KEY', path: 'apiKey' }]);
});

test('$${NAME} is an escape for a literal ${NAME}', () => {
  const { value, missing } = interpolate({ literal: '$${NOT_A_SECRET}' }, {});
  assert.deepEqual(value, { literal: '${NOT_A_SECRET}' });
  assert.deepEqual(missing, []);
});

test('collectSecretRefs finds references without needing the environment', () => {
  const refs = collectSecretRefs(
    { url: 'https://x/${A}', headers: { k: '${B}' } },
    'targets[demo]'
  );
  assert.deepEqual(refs, [
    { name: 'A', path: 'targets[demo].url' },
    { name: 'B', path: 'targets[demo].headers.k' },
  ]);
});
