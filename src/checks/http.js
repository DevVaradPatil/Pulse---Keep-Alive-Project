/**
 * Plain HTTP check.
 *
 * This is the recommended type for anything that has a deployed backend: point
 * it at a health endpoint from `templates/` that touches the database, and
 * assert on the body so a cached 200 from a CDN edge cannot pass for a healthy
 * database.
 */

import { CheckFailure } from '../lib/errors.js';

/** @type {import('../types.js').Check} */
const httpCheck = {
  type: 'http',

  fields: Object.freeze(['url', 'method', 'headers', 'body', 'expectStatus', 'expectBodyContains']),

  describe(target) {
    return `${target.method ?? 'GET'} ${target.url}`;
  },

  async run(target, ctx) {
    const method = (target.method ?? 'GET').toUpperCase();
    /** @type {Record<string, string>} */
    const headers = { 'user-agent': ctx.userAgent, accept: '*/*' };
    for (const [key, value] of Object.entries(target.headers ?? {})) {
      headers[key.toLowerCase()] = value;
    }

    /** @type {string | undefined} */
    let body;
    if (target.body !== undefined && target.body !== null) {
      if (typeof target.body === 'string') {
        body = target.body;
      } else {
        body = JSON.stringify(target.body);
        headers['content-type'] ??= 'application/json';
      }
    }

    const url = /** @type {string} */ (target.url);
    const response = await ctx.fetch(url, {
      method,
      headers,
      body,
      redirect: 'follow',
      signal: ctx.signal,
    });

    // Always drain the body: an unread response keeps the socket open, and the
    // first 200 characters are the most useful thing we can put in a failure
    // message. Health endpoints are tiny by construction.
    const text = method === 'HEAD' ? '' : await response.text();
    const expected = normaliseExpectedStatuses(target.expectStatus ?? 200);

    if (!expected.includes(response.status)) {
      throw new CheckFailure(
        `expected HTTP ${expected.join(' or ')} but got ${response.status} ${response.statusText}`.trim(),
        { statusCode: response.status, hint: snippet(text) }
      );
    }

    if (target.expectBodyContains !== undefined && !text.includes(target.expectBodyContains)) {
      throw new CheckFailure(
        `HTTP ${response.status} but the body did not contain ${JSON.stringify(target.expectBodyContains)}`,
        {
          statusCode: response.status,
          hint: `Received: ${snippet(text) || '(empty body)'}`,
        }
      );
    }

    return {
      statusCode: response.status,
      detail: `HTTP ${response.status}${text ? ` · ${formatBytes(Buffer.byteLength(text))}` : ''}`,
    };
  },
};

/**
 * @param {number | number[]} expectStatus
 * @returns {number[]}
 */
export function normaliseExpectedStatuses(expectStatus) {
  return Array.isArray(expectStatus) ? expectStatus : [expectStatus];
}

/**
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function snippet(text, max = 200) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export default httpCheck;
