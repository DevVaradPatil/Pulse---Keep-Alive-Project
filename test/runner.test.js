import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOne, runChecks } from '../src/runner.js';
import { BUILT_IN_DEFAULTS } from '../src/config/load.js';

/** Deterministic, instant runner options: no jitter, no real backoff, no network. */
const runnerOptions = {
  defaults: { ...BUILT_IN_DEFAULTS, concurrency: 5, jitterMs: 0 },
  random: () => 0,
  sleepFn: async () => {},
  now: () => new Date('2026-08-31T21:17:00.000Z'),
};

/**
 * @param {object} [overrides]
 * @returns {import('../src/types.js').Target}
 */
function target(overrides = {}) {
  return {
    id: 'demo',
    name: 'Demo',
    type: 'http',
    tier: 'daily',
    enabled: true,
    timeoutMs: 5000,
    retries: 2,
    url: 'https://demo.example/api/health',
    ...overrides,
  };
}

test('a healthy target reports ok, one attempt and a duration', async () => {
  const [result] = await runChecks([target()], {
    ...runnerOptions,
    fetchImpl: async () => new Response('{"ok":true}', { status: 200 }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.statusCode, 200);
  assert.equal(result.checkedAt, '2026-08-31T21:17:00.000Z');
  assert.ok(result.durationMs >= 0);
});

test('one failing target does not stop the others - the whole point', async () => {
  const targets = [
    target({ id: 'alpha', url: 'https://alpha.example/health' }),
    target({ id: 'broken', url: 'https://broken.example/health', retries: 1 }),
    target({ id: 'gamma', url: 'https://gamma.example/health' }),
    target({ id: 'delta', url: 'https://delta.example/health' }),
  ];

  /** @type {string[]} */
  const requested = [];
  const results = await runChecks(targets, {
    ...runnerOptions,
    fetchImpl: async (url) => {
      requested.push(String(url));
      if (String(url).includes('broken')) throw new Error('getaddrinfo ENOTFOUND broken.example');
      return new Response('{"ok":true}', { status: 200 });
    },
  });

  assert.equal(results.length, 4, 'every target produces a result');
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, false, true, true]
  );
  for (const id of ['alpha', 'gamma', 'delta']) {
    assert.ok(
      requested.some((url) => url.includes(id)),
      `${id} was still checked after the failure`
    );
  }
  assert.match(results[1].error ?? '', /ENOTFOUND broken\.example/);
  assert.equal(results[1].attempts, 2);
});

test('a target that throws a non-Error still yields a result for every target', async () => {
  const results = await runChecks([target({ id: 'weird', retries: 0 })], {
    ...runnerOptions,
    fetchImpl: async () => {
      throw 'a string, not an Error';
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? '', /a string, not an Error/);
});

test('a slow target is aborted at its own timeout and does not hang the run', async () => {
  const started = Date.now();
  const results = await runChecks(
    [
      target({ id: 'slow', url: 'https://slow.example/health', timeoutMs: 60, retries: 0 }),
      target({ id: 'fast', url: 'https://fast.example/health' }),
    ],
    {
      ...runnerOptions,
      fetchImpl: async (url, init) => {
        if (String(url).includes('slow')) {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          });
        }
        return new Response('{"ok":true}', { status: 200 });
      },
    }
  );

  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? '', /timed out after 60 ms/);
  assert.equal(results[1].ok, true);
  assert.ok(Date.now() - started < 5000, 'the run finished long before the default timeout');
});

test('retries a blip and reports success with the attempt count', async () => {
  let calls = 0;
  const result = await checkOne(target({ retries: 2 }), {
    ...runnerOptions,
    userAgent: 'test',
    fetchImpl: async () => {
      calls += 1;
      return new Response(calls < 3 ? 'bad gateway' : '{"ok":true}', {
        status: calls < 3 ? 502 : 200,
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
});

test('results carry the dashboard metadata straight from the config', async () => {
  const [result] = await runChecks(
    [
      target({
        platform: 'render+postgres',
        publicUrl: 'https://demo.example',
        notes: 'hits SELECT 1',
      }),
    ],
    { ...runnerOptions, fetchImpl: async () => new Response('{"ok":true}', { status: 200 }) }
  );

  assert.equal(result.platform, 'render+postgres');
  assert.equal(result.publicUrl, 'https://demo.example');
  assert.equal(result.notes, 'hits SELECT 1');
});
