import test from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_LABEL, markerFor, notify, sendWebhook, syncIssues } from '../src/notify.js';

/**
 * @param {object} [overrides]
 * @returns {import('../src/types.js').RunResult}
 */
function result(overrides = {}) {
  return {
    id: 'alpha',
    name: 'Alpha',
    type: 'http',
    tier: 'daily',
    ok: false,
    durationMs: 200,
    attempts: 3,
    error: 'expected HTTP 200 but got 503',
    checkedAt: '2026-08-31T21:17:00.000Z',
    ...overrides,
  };
}

/**
 * @param {any[]} openIssues
 */
function githubStub(openIssues) {
  /** @type {Array<{ method: string, url: string, body: any }>} */
  const calls = [];
  /** @type {any} */
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? 'GET', url: String(url), body });

    if (String(url).includes('/issues?')) {
      return new Response(JSON.stringify(openIssues), { status: 200 });
    }
    return new Response(JSON.stringify({ number: 42 }), { status: 201 });
  };
  return { calls, fetchImpl };
}

const base = {
  repo: 'owner/repo',
  token: 't',
  log: () => {},
  now: () => new Date('2026-08-31T21:18:00.000Z'),
};

test('opens one issue on the first failure, with the dedup marker and the label', async () => {
  const { calls, fetchImpl } = githubStub([]);
  const summary = await syncIssues({ ...base, results: [result()], fetchImpl });

  assert.deepEqual(summary.opened, ['alpha']);
  const created = calls.find((call) => call.method === 'POST' && call.url.endsWith('/issues'));
  assert.equal(created?.body.title, '🔴 Pulse: Alpha is down');
  assert.deepEqual(created?.body.labels, [ALERT_LABEL]);
  assert.match(created?.body.body, new RegExp(markerFor('alpha')));
  assert.match(created?.body.body, /expected HTTP 200 but got 503/);
});

test('a target that is still down updates the existing issue instead of opening a second one', async () => {
  const { calls, fetchImpl } = githubStub([
    { number: 7, body: `${markerFor('alpha')}\n<!-- pulse:firstSeen=2026-08-20T00:00:00.000Z -->` },
  ]);
  const summary = await syncIssues({ ...base, results: [result()], fetchImpl });

  assert.deepEqual(summary, { opened: [], updated: ['alpha'], closed: [] });
  assert.equal(
    calls.filter((call) => call.method === 'POST' && call.url.endsWith('/issues')).length,
    0
  );

  const patch = calls.find((call) => call.method === 'PATCH');
  assert.match(patch?.url ?? '', /\/issues\/7$/);
  assert.match(patch?.body.body, /First seen failing \| 2026-08-20T00:00:00\.000Z/);
  // Editing the body rather than commenting is what keeps a week-long outage
  // down to a single notification.
  assert.equal(
    calls.some((call) => call.url.includes('/comments')),
    false
  );
});

test('recovery comments once and closes the issue', async () => {
  const { calls, fetchImpl } = githubStub([{ number: 7, body: markerFor('alpha') }]);
  const summary = await syncIssues({
    ...base,
    results: [result({ ok: true, error: undefined, detail: 'HTTP 200 · 41 B' })],
    fetchImpl,
  });

  assert.deepEqual(summary.closed, ['alpha']);
  assert.match(calls.find((call) => call.url.includes('/comments'))?.body.body ?? '', /Recovered/);
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.equal(patch?.body.state, 'closed');
});

test('a healthy target with no open issue touches nothing', async () => {
  const { calls, fetchImpl } = githubStub([]);
  const summary = await syncIssues({ ...base, results: [result({ ok: true })], fetchImpl });

  assert.deepEqual(summary, { opened: [], updated: [], closed: [] });
  assert.equal(calls.filter((call) => call.method !== 'GET').length, 0);
});

test('issues for other targets are left alone', async () => {
  const { calls, fetchImpl } = githubStub([{ number: 9, body: markerFor('beta') }]);
  await syncIssues({ ...base, results: [result({ ok: true })], fetchImpl });

  assert.equal(
    calls.some((call) => call.url.includes('/issues/9')),
    false
  );
});

test('a failure to report a failure never breaks the run', async () => {
  const summary = await notify({
    results: [result()],
    repo: 'owner/repo',
    token: 't',
    fetchImpl: async () => new Response('rate limited', { status: 403 }),
    log: () => {},
  });
  assert.deepEqual(summary.opened, []);
});

test('issue alerting is skipped, with a reason, when there is no token', async () => {
  const summary = await notify({
    results: [result()],
    repo: 'owner/repo',
    token: undefined,
    webhookUrl: undefined,
    fetchImpl: async () => new Response('{}', { status: 200 }),
    log: () => {},
  });
  assert.match(summary.skipped ?? '', /GITHUB_TOKEN/);
});

test('the webhook payload works for both Discord and Slack, and is skipped when healthy', async () => {
  /** @type {any} */
  let sent;
  const fetchImpl = /** @type {any} */ (
    async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response('', { status: 204 });
    }
  );

  await sendWebhook({
    url: 'https://hook.example/x',
    results: [result()],
    fetchImpl,
    log: () => {},
  });
  assert.equal(sent.content, sent.text);
  assert.match(sent.content, /1 target down/);

  sent = undefined;
  await sendWebhook({
    url: 'https://hook.example/x',
    results: [result({ ok: true })],
    fetchImpl,
    log: () => {},
  });
  assert.equal(sent, undefined, 'no webhook noise when everything is healthy');
});

test('a webhook that is down is reported but not fatal', async () => {
  const ok = await sendWebhook({
    url: 'https://hook.example/x',
    results: [result()],
    fetchImpl: /** @type {any} */ (
      async () => {
        throw new Error('ECONNREFUSED');
      }
    ),
    log: () => {},
  });
  assert.equal(ok, false);
});
