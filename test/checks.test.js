import test from 'node:test';
import assert from 'node:assert/strict';
import httpCheck from '../src/checks/http.js';
import supabaseCheck, { buildRestUrl } from '../src/checks/supabase.js';
import { redact } from '../src/checks/mongo.js';
import { assertRegistryMatchesSchema, CHECK_TYPES, getCheck } from '../src/checks/index.js';
import { CheckFailure } from '../src/lib/errors.js';
import { readFile } from 'node:fs/promises';
import { DEFAULT_SCHEMA_PATH } from '../src/config/load.js';

/**
 * @param {(url: string, init?: any) => Promise<Response>} impl
 */
function context(impl) {
  return {
    signal: new AbortController().signal,
    fetch: /** @type {any} */ (impl),
    userAgent: 'Pulse/test',
    timeoutMs: 5000,
  };
}

test('http: passes on the expected status and body substring', async () => {
  const outcome = await httpCheck.run(
    /** @type {any} */ ({ url: 'https://x.example/health', expectBodyContains: '"ok":true' }),
    context(async () => new Response('{"ok":true,"db":"postgres"}', { status: 200 }))
  );
  assert.equal(outcome.statusCode, 200);
  assert.match(outcome.detail, /^HTTP 200/);
});

test('http: fails on an unexpected status and says what it wanted', async () => {
  await assert.rejects(
    httpCheck.run(
      /** @type {any} */ ({ url: 'https://x.example/health', expectStatus: [200, 204] }),
      context(async () => new Response('nope', { status: 503, statusText: 'Service Unavailable' }))
    ),
    (/** @type {any} */ error) => {
      assert.ok(error instanceof CheckFailure);
      assert.match(error.message, /expected HTTP 200 or 204 but got 503/);
      assert.equal(error.statusCode, 503);
      return true;
    }
  );
});

test('http: a 200 that does not contain the expected body is a failure', async () => {
  // The CDN-cache case: the edge answers 200 with a stale page while the
  // database behind it is asleep.
  await assert.rejects(
    httpCheck.run(
      /** @type {any} */ ({ url: 'https://x.example/health', expectBodyContains: '"ok":true' }),
      context(
        async () => new Response('<!doctype html><title>cached page</title>', { status: 200 })
      )
    ),
    /body did not contain "\\"ok\\":true"/
  );
});

test('http: sends the identifying User-Agent and any configured headers', async () => {
  /** @type {any} */
  let seen;
  await httpCheck.run(
    /** @type {any} */ ({ url: 'https://x.example/health', headers: { 'X-Trace': 'yes' } }),
    context(async (_url, init) => {
      seen = init;
      return new Response('ok', { status: 200 });
    })
  );
  assert.equal(seen.headers['user-agent'], 'Pulse/test');
  assert.equal(seen.headers['x-trace'], 'yes');
});

test('http: an object body is JSON-encoded with a content-type', async () => {
  /** @type {any} */
  let seen;
  await httpCheck.run(
    /** @type {any} */ ({ url: 'https://x.example/health', method: 'POST', body: { ping: 1 } }),
    context(async (_url, init) => {
      seen = init;
      return new Response('ok', { status: 200 });
    })
  );
  assert.equal(seen.body, '{"ping":1}');
  assert.equal(seen.headers['content-type'], 'application/json');
});

test('supabase: builds a PostgREST select that actually reaches Postgres', () => {
  assert.equal(
    buildRestUrl(/** @type {any} */ ({ supabaseUrl: 'https://ref.supabase.co/' })),
    'https://ref.supabase.co/rest/v1/heartbeat?select=id&limit=1'
  );
  assert.equal(
    buildRestUrl(
      /** @type {any} */ ({ supabaseUrl: 'https://ref.supabase.co', table: 'pings', column: 'uid' })
    ),
    'https://ref.supabase.co/rest/v1/pings?select=uid&limit=1'
  );
});

test('supabase: sends the anon key as both apikey and bearer token', async () => {
  /** @type {any} */
  let seen;
  await supabaseCheck.run(
    /** @type {any} */ ({ supabaseUrl: 'https://ref.supabase.co', apiKey: 'anon-key' }),
    context(async (_url, init) => {
      seen = init;
      return new Response('[{"id":1}]', { status: 200 });
    })
  );
  assert.equal(seen.headers.apikey, 'anon-key');
  assert.equal(seen.headers.authorization, 'Bearer anon-key');
});

test('supabase: treats both 200 and 206 as healthy', async () => {
  for (const status of [200, 206]) {
    const outcome = await supabaseCheck.run(
      /** @type {any} */ ({ supabaseUrl: 'https://ref.supabase.co', apiKey: 'k' }),
      context(async () => new Response('[]', { status }))
    );
    assert.equal(outcome.statusCode, status);
  }
});

test('supabase: an empty result under RLS is still healthy - the query ran', async () => {
  const outcome = await supabaseCheck.run(
    /** @type {any} */ ({ supabaseUrl: 'https://ref.supabase.co', apiKey: 'k' }),
    context(async () => new Response('[]', { status: 200 }))
  );
  assert.match(outcome.detail, /0 rows/);
});

test('supabase: explains a 404 as a missing table and a 401 as a bad key', async () => {
  const failure = async (status, body) => {
    try {
      await supabaseCheck.run(
        /** @type {any} */ ({
          supabaseUrl: 'https://ref.supabase.co',
          apiKey: 'k',
          table: 'heartbeat',
        }),
        context(async () => new Response(body, { status }))
      );
      assert.fail('should have thrown');
    } catch (error) {
      return /** @type {CheckFailure} */ (error);
    }
  };

  assert.match((await failure(404, '{}')).hint ?? '', /Table "heartbeat" does not exist/);
  assert.match((await failure(401, '{}')).hint ?? '', /anon key was rejected/);
});

test('mongo: credentials are stripped from anything that could be logged', () => {
  assert.equal(
    redact('failed to connect to mongodb+srv://admin:s3cr3t@cluster0.mongodb.net/test'),
    'failed to connect to mongodb+srv://<credentials>@cluster0.mongodb.net/test'
  );
});

test('the registry, the schema enum and the check files agree', async () => {
  const schema = JSON.parse(await readFile(DEFAULT_SCHEMA_PATH, 'utf8'));
  assert.deepEqual(assertRegistryMatchesSchema(schema), []);
  for (const type of CHECK_TYPES) {
    const check = getCheck(type);
    assert.equal(check.type, type);
    assert.ok(Array.isArray(check.fields));
    assert.equal(typeof check.run, 'function');
    assert.equal(typeof check.describe, 'function');
  }
});

test('an unknown check type fails with a message that says how to add one', () => {
  assert.throws(
    () => getCheck('redis'),
    (/** @type {any} */ error) => {
      assert.match(error.message, /Unknown check type "redis"/);
      assert.match(error.hint, /creating src\/checks\/redis\.js and registering it/);
      return true;
    }
  );
});
