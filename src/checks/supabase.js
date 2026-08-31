/**
 * Supabase check.
 *
 * Supabase pauses a free project after ~7 days of insufficient *database*
 * activity. Requests to the frontend do not count, and neither does anything
 * served from a CDN - the request has to reach Postgres.
 *
 * So this calls PostgREST directly:
 *
 *   GET {supabaseUrl}/rest/v1/{table}?select={column}&limit=1
 *   apikey: <anon key>
 *   Authorization: Bearer <anon key>
 *
 * PostgREST turns that into a real `SELECT` against Postgres, which is what
 * counts as activity. It also means the project needs no deployed backend at
 * all: a purely static frontend on Vercel or Netlify is monitored just fine.
 *
 * 200 and 206 are both healthy - PostgREST answers 206 when it decides the
 * response is a partial range, which is a normal outcome for a limited select
 * and says nothing about health.
 *
 * Row Level Security is not a problem here. With RLS on and no policy for the
 * anon role, the query returns `200 []` - the statement still executed in
 * Postgres, which is all the keep-alive needs.
 */

import { CheckFailure } from '../lib/errors.js';

const HEALTHY_STATUSES = Object.freeze([200, 206]);

/** @type {import('../types.js').Check} */
const supabaseCheck = {
  type: 'supabase',

  fields: Object.freeze(['supabaseUrl', 'apiKey', 'table', 'column']),

  describe(target) {
    return `GET ${buildRestUrl(target)}`;
  },

  async run(target, ctx) {
    const apiKey = /** @type {string} */ (target.apiKey);
    const url = buildRestUrl(target);

    const response = await ctx.fetch(url, {
      method: 'GET',
      headers: {
        apikey: apiKey,
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        'user-agent': ctx.userAgent,
      },
      signal: ctx.signal,
    });

    const text = await response.text();

    if (!HEALTHY_STATUSES.includes(response.status)) {
      throw new CheckFailure(
        `Supabase REST returned ${response.status} ${response.statusText}`.trim(),
        { statusCode: response.status, hint: explain(response.status, text, target) }
      );
    }

    const rows = countRows(text);
    return {
      statusCode: response.status,
      detail: `PostgREST ${response.status} · select ${target.column ?? 'id'} from ${
        target.table ?? 'heartbeat'
      }${rows === null ? '' : ` · ${rows} row${rows === 1 ? '' : 's'}`}`,
    };
  },
};

/**
 * @param {import('../types.js').Target} target
 * @returns {string}
 */
export function buildRestUrl(target) {
  const base = String(target.supabaseUrl).replace(/\/+$/, '');
  const table = encodeURIComponent(target.table ?? 'heartbeat');
  const column = encodeURIComponent(target.column ?? 'id');
  return `${base}/rest/v1/${table}?select=${column}&limit=1`;
}

/**
 * Turn a PostgREST error into the sentence that actually shortens the debugging
 * session, because these all look identical in a workflow log otherwise.
 *
 * @param {number} status
 * @param {string} body
 * @param {import('../types.js').Target} target
 * @returns {string}
 */
function explain(status, body, target) {
  const table = target.table ?? 'heartbeat';
  const detail = body.replace(/\s+/g, ' ').trim().slice(0, 200);

  switch (status) {
    case 401:
      return `The anon key was rejected. The secret for this target is unset, stale, or holds a service-role key from a different project. ${detail}`;
    case 403:
      return `Authenticated but forbidden. Usually an RLS policy that denies the anon role even the ability to attempt the select. ${detail}`;
    case 404:
      return `Table "${table}" does not exist in the exposed schema. Create it with templates/supabase-heartbeat-table.sql, or set "table" to one that exists. ${detail}`;
    case 400:
      return `PostgREST rejected the query - most often column "${
        target.column ?? 'id'
      }" does not exist on "${table}". ${detail}`;
    case 503:
    case 540:
      return `The project looks paused or unreachable. Restore it from the Supabase dashboard, then check why the previous keep-alive runs did not reach Postgres. ${detail}`;
    default:
      return detail;
  }
}

/**
 * @param {string} text
 * @returns {number | null} Row count, or null when the body was not a JSON array.
 */
function countRows(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

export default supabaseCheck;
