import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, mapWithConcurrency, withRetry } from '../src/lib/async.js';

test('withRetry returns the first success without sleeping', async () => {
  const slept = [];
  const { value, attempts } = await withRetry(async () => 'ok', {
    retries: 2,
    sleepFn: async (ms) => void slept.push(ms),
  });
  assert.equal(value, 'ok');
  assert.equal(attempts, 1);
  assert.deepEqual(slept, []);
});

test('withRetry recovers from a blip and reports the attempt count', async () => {
  let calls = 0;
  const slept = [];
  const { value, attempts } = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('502 bad gateway');
      return 'recovered';
    },
    {
      retries: 2,
      baseMs: 1000,
      maxMs: 15000,
      random: () => 0,
      sleepFn: async (ms) => void slept.push(ms),
    }
  );

  assert.equal(value, 'recovered');
  assert.equal(attempts, 3);
  // 1000 then 2000, each jittered to 50% by random() === 0.
  assert.deepEqual(slept, [500, 1000]);
});

test('withRetry gives up after retries + 1 attempts and tags the error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error('still down');
      },
      { retries: 2, sleepFn: async () => {} }
    ),
    (/** @type {any} */ error) => {
      assert.equal(error.message, 'still down');
      assert.equal(error.attempts, 3);
      return true;
    }
  );
  assert.equal(calls, 3);
});

test('withRetry with retries: 0 makes exactly one attempt', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error('nope');
      },
      { retries: 0, sleepFn: async () => {} }
    )
  );
  assert.equal(calls, 1);
});

test('backoff grows exponentially, is capped, and is jittered to 50-100%', () => {
  const full = { baseMs: 1000, maxMs: 8000, random: () => 1 };
  assert.equal(backoffDelay(1, full), 1000);
  assert.equal(backoffDelay(2, full), 2000);
  assert.equal(backoffDelay(3, full), 4000);
  assert.equal(backoffDelay(4, full), 8000);
  assert.equal(backoffDelay(9, full), 8000, 'capped at maxMs');
  assert.equal(backoffDelay(1, { ...full, random: () => 0 }), 500, 'jittered down to half');
});

test('mapWithConcurrency never exceeds the cap and preserves input order', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);

  const settled = await mapWithConcurrency(items, 5, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, item % 3));
    inFlight -= 1;
    return item * 2;
  });

  assert.equal(peak, 5);
  assert.deepEqual(
    settled.map((entry) => (entry.ok ? entry.value : null)),
    items.map((i) => i * 2)
  );
});

test('mapWithConcurrency captures a throwing worker instead of abandoning the batch', async () => {
  const settled = await mapWithConcurrency([1, 2, 3], 2, async (item) => {
    if (item === 2) throw new Error('boom');
    return item;
  });

  assert.equal(settled.length, 3);
  assert.deepEqual(settled[0], { ok: true, value: 1 });
  assert.equal(settled[1].ok, false);
  assert.deepEqual(settled[2], { ok: true, value: 3 });
});
