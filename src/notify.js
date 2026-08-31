/**
 * Failure reporting.
 *
 * Three layers, in order of how much you will actually notice them:
 *
 *  1. The workflow exits non-zero, so GitHub emails you. That is the baseline
 *     and it needs no configuration at all.
 *  2. One GitHub Issue per failing target, opened on the first failure, updated
 *     in place while it stays down, and closed automatically on recovery. It is
 *     deduplicated by a hidden marker in the issue body, so a week-long outage
 *     is one issue and one notification, not one per run.
 *  3. An optional Discord or Slack webhook, silently skipped when `WEBHOOK_URL`
 *     is unset.
 *
 * Nothing in here is allowed to throw: a failure to *report* a failure must not
 * change the exit code or hide the run's actual result.
 */

const API = 'https://api.github.com';
export const ALERT_LABEL = 'pulse-alert';

/**
 * @param {string} id
 * @returns {string} The hidden marker that ties an issue to a target.
 */
export function markerFor(id) {
  return `<!-- pulse:target=${id} -->`;
}

/**
 * @typedef {object} NotifyOptions
 * @property {import('./types.js').RunResult[]} results
 * @property {string} [repo] `owner/name`. Defaults to `GITHUB_REPOSITORY`.
 * @property {string} [token] Defaults to `GITHUB_TOKEN`.
 * @property {string} [runUrl] Link back to the workflow run.
 * @property {string} [webhookUrl] Defaults to `WEBHOOK_URL`.
 * @property {typeof globalThis.fetch} [fetchImpl]
 * @property {(line: string) => void} [log]
 * @property {() => Date} [now]
 */

/**
 * @param {NotifyOptions} options
 * @returns {Promise<{ opened: string[], updated: string[], closed: string[], webhook: 'sent' | 'skipped' | 'failed', skipped?: string }>}
 */
export async function notify(options) {
  const env = process.env;
  const {
    results,
    repo = env.GITHUB_REPOSITORY,
    token = env.GITHUB_TOKEN,
    runUrl = buildRunUrl(env),
    webhookUrl = env.WEBHOOK_URL,
    fetchImpl = globalThis.fetch,
    log = () => {},
    now = () => new Date(),
  } = options;

  /** @type {{ opened: string[], updated: string[], closed: string[], webhook: 'sent' | 'skipped' | 'failed', skipped?: string }} */
  const summary = { opened: [], updated: [], closed: [], webhook: 'skipped' };

  if (!repo || !token) {
    summary.skipped = 'GitHub issue alerts need GITHUB_REPOSITORY and GITHUB_TOKEN; skipping.';
    log(summary.skipped);
  } else {
    try {
      Object.assign(
        summary,
        await syncIssues({ results, repo, token, runUrl, fetchImpl, log, now }),
        { webhook: summary.webhook }
      );
    } catch (error) {
      log(`GitHub issue sync failed (the run result is unaffected): ${describe(error)}`);
    }
  }

  if (webhookUrl) {
    summary.webhook = (await sendWebhook({ url: webhookUrl, results, runUrl, fetchImpl, log }))
      ? 'sent'
      : 'failed';
  }

  return summary;
}

/**
 * Open, update or close one issue per target.
 *
 * @param {{ results: import('./types.js').RunResult[], repo: string, token: string, runUrl?: string, fetchImpl: typeof globalThis.fetch, log: (line: string) => void, now: () => Date }} options
 * @returns {Promise<{ opened: string[], updated: string[], closed: string[] }>}
 */
export async function syncIssues({ results, repo, token, runUrl, fetchImpl, log, now }) {
  const request = githubRequest(fetchImpl, token);
  const opened = [];
  const updated = [];
  const closed = [];

  const open = await request(
    'GET',
    `${API}/repos/${repo}/issues?state=open&labels=${ALERT_LABEL}&per_page=100`
  );
  /** @type {Map<string, any>} */
  const byTarget = new Map();
  for (const issue of Array.isArray(open) ? open : []) {
    const match = /<!-- pulse:target=([a-z0-9-]+) -->/.exec(issue.body ?? '');
    if (match) byTarget.set(match[1], issue);
  }

  const failing = results.filter((result) => !result.ok);
  if (failing.length > 0 && byTarget.size === 0) {
    // Only needed the first time anything fails; 422 means it already exists.
    await request('POST', `${API}/repos/${repo}/labels`, {
      name: ALERT_LABEL,
      color: 'd73a4a',
      description: 'Opened automatically by Pulse when a monitored target is down.',
    }).catch(() => {});
  }

  for (const result of results) {
    const issue = byTarget.get(result.id);

    if (!result.ok && !issue) {
      await request('POST', `${API}/repos/${repo}/issues`, {
        title: `🔴 Pulse: ${result.name} is down`,
        body: issueBody(result, { runUrl, firstSeen: result.checkedAt, now: now() }),
        labels: [ALERT_LABEL],
      });
      opened.push(result.id);
      log(`opened an issue for ${result.id}`);
    } else if (!result.ok && issue) {
      // Editing the body rather than commenting: it keeps the issue current
      // without sending you a notification every ten minutes for a day.
      await request('PATCH', `${API}/repos/${repo}/issues/${issue.number}`, {
        body: issueBody(result, {
          runUrl,
          firstSeen: firstSeenFrom(issue.body) ?? result.checkedAt,
          now: now(),
        }),
      });
      updated.push(result.id);
      log(`updated issue #${issue.number} for ${result.id}`);
    } else if (result.ok && issue) {
      await request('POST', `${API}/repos/${repo}/issues/${issue.number}/comments`, {
        body: [
          `✅ Recovered at ${result.checkedAt}.`,
          '',
          `\`${result.detail ?? 'check passed'}\` in ${result.durationMs} ms after ${result.attempts} attempt(s).`,
          runUrl ? `\n[Run that saw the recovery](${runUrl})` : '',
        ].join('\n'),
      });
      await request('PATCH', `${API}/repos/${repo}/issues/${issue.number}`, {
        state: 'closed',
        state_reason: 'completed',
      });
      closed.push(result.id);
      log(`closed issue #${issue.number} for ${result.id}`);
    }
  }

  return { opened, updated, closed };
}

/**
 * @param {import('./types.js').RunResult} result
 * @param {{ runUrl?: string, firstSeen: string, now: Date }} context
 * @returns {string}
 */
function issueBody(result, { runUrl, firstSeen, now }) {
  return [
    markerFor(result.id),
    `<!-- pulse:firstSeen=${firstSeen} -->`,
    '',
    `**${result.name}** (\`${result.id}\`) is failing its \`${result.type}\` check.`,
    '',
    '| | |',
    '| --- | --- |',
    `| First seen failing | ${firstSeen} |`,
    `| Last checked | ${result.checkedAt} |`,
    `| Attempts | ${result.attempts} |`,
    result.statusCode ? `| HTTP status | ${result.statusCode} |` : '| HTTP status | — |',
    result.platform ? `| Platform | ${result.platform} |` : '',
    result.publicUrl ? `| Public URL | ${result.publicUrl} |` : '',
    '',
    '**Error**',
    '',
    '```',
    result.error ?? 'failed',
    ...(result.detail ? ['', result.detail] : []),
    '```',
    '',
    runUrl ? `[Workflow run](${runUrl})` : '',
    '',
    `_Pulse closes this issue automatically on the next successful check. Updated ${now.toISOString()}._`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * @param {string | undefined} body
 * @returns {string | undefined}
 */
function firstSeenFrom(body) {
  const match = /<!-- pulse:firstSeen=([^\s>]+) -->/.exec(body ?? '');
  return match?.[1];
}

/**
 * Discord and Slack disagree about the field name and ignore the other one, so
 * sending both makes a single `WEBHOOK_URL` work with either service.
 *
 * @param {{ url: string, results: import('./types.js').RunResult[], runUrl?: string, fetchImpl: typeof globalThis.fetch, log: (line: string) => void }} options
 * @returns {Promise<boolean>}
 */
export async function sendWebhook({ url, results, runUrl, fetchImpl, log }) {
  const failing = results.filter((result) => !result.ok);
  if (failing.length === 0) return true;

  const text = [
    `🔴 **Pulse: ${failing.length} target${failing.length === 1 ? '' : 's'} down**`,
    ...failing.map(
      (result) => `• **${result.name}** (\`${result.id}\`) — ${result.error ?? 'failed'}`
    ),
    runUrl ? `\n${runUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text, text }),
    });
    if (!response.ok) {
      log(`webhook returned ${response.status} ${response.statusText}; continuing.`);
      return false;
    }
    return true;
  } catch (error) {
    log(`webhook failed (${describe(error)}); continuing.`);
    return false;
  }
}

/**
 * @param {typeof globalThis.fetch} fetchImpl
 * @param {string} token
 */
function githubRequest(fetchImpl, token) {
  /**
   * @param {string} method
   * @param {string} url
   * @param {unknown} [body]
   * @returns {Promise<any>}
   */
  return async function request(method, url, body) {
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'pulse-keepalive',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(
        `${method} ${url.replace(API, '')} → ${response.status} ${response.statusText}: ${detail}`
      );
    }
    return response.status === 204 ? null : response.json();
  };
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
function buildRunUrl(env) {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
  return `${GITHUB_SERVER_URL ?? 'https://github.com'}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
