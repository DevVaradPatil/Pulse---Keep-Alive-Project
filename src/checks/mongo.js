/**
 * MongoDB Atlas check.
 *
 * Atlas auto-pauses an idle free (M0) cluster after ~30 days with no *driver*
 * connections. An HTTP request to something in front of the cluster only counts
 * if that something actually opens a connection, so this check opens one
 * itself: connect, run `{ ping: 1 }`, close.
 *
 * Prefer the `http` type with a health endpoint from `templates/` when the
 * project has a deployed backend. This type is the fallback for clusters with
 * no app in front of them, and it carries a real cost:
 *
 *   - GitHub-hosted runners have dynamic IPs, so the Atlas IP access list has
 *     to contain 0.0.0.0/0. Anyone on the internet can then reach the cluster's
 *     login prompt, which makes a long random password and a least-privilege
 *     user mandatory rather than advisable.
 *   - The connection string contains that password, so it must live in a
 *     GitHub secret. Validation rejects a literal one.
 *
 * The `mongodb` driver is not a dependency of this project. It is installed
 * on demand by `src/tools/ensure-drivers.js`, only in the workflow runs whose
 * config actually contains a mongo target, so the common path stays at zero
 * runtime dependencies.
 */

import { CheckFailure, ConfigError } from '../lib/errors.js';

/** @type {import('../types.js').Check} */
const mongoCheck = {
  type: 'mongo',

  fields: Object.freeze(['connectionString', 'dbName']),

  describe(target) {
    return `db.command({ ping: 1 }) on ${redact(String(target.connectionString))} (db: ${
      target.dbName ?? 'admin'
    })`;
  },

  async run(target, ctx) {
    const { MongoClient } = await loadDriver();
    const client = new MongoClient(String(target.connectionString), {
      // The driver has its own timeouts; the runner's AbortController does not
      // reach into it, so these have to mirror the target's timeout budget.
      serverSelectionTimeoutMS: ctx.timeoutMs,
      connectTimeoutMS: ctx.timeoutMs,
      socketTimeoutMS: ctx.timeoutMs,
      appName: 'pulse-keepalive',
    });

    try {
      await client.connect();
      const started = Date.now();
      const result = await client.db(target.dbName ?? 'admin').command({ ping: 1 });
      const pingMs = Date.now() - started;

      if (result?.ok !== 1) {
        throw new CheckFailure(
          `ping command returned ${JSON.stringify(result)} instead of { ok: 1 }`
        );
      }
      return { detail: `ping ok · ${pingMs} ms` };
    } catch (error) {
      if (error instanceof CheckFailure) throw error;
      throw new CheckFailure(describeDriverError(error), { cause: error, hint: hintFor(error) });
    } finally {
      // force close: a hung connection would otherwise keep the runner alive
      // until the job timeout, long after the result is known.
      await client.close(true).catch(() => {});
    }
  },
};

/**
 * @returns {Promise<{ MongoClient: any }>}
 */
async function loadDriver() {
  try {
    // The specifier goes through a variable on purpose: `mongodb` is not a
    // dependency of this project, so a literal import would make `tsc` demand
    // types for a package that is only present when a mongo target exists.
    const specifier = 'mongodb';
    return await import(specifier);
  } catch (error) {
    throw new ConfigError(
      'The "mongodb" driver is not installed, but a target of type "mongo" is configured.',
      {
        cause: error,
        hint: [
          'Run `node src/tools/ensure-drivers.js` (the workflows do this automatically), or install it directly:',
          '  npm install --no-save mongodb',
        ].join('\n'),
      }
    );
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeDriverError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message.split('\n')[0]);
}

/**
 * @param {unknown} error
 * @returns {string | undefined}
 */
function hintFor(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/server selection timed out|ETIMEDOUT|ENOTFOUND/i.test(message)) {
    return 'Usually the Atlas IP access list. GitHub runners have dynamic IPs, so the list must contain 0.0.0.0/0 - see SETUP.md.';
  }
  if (/authentication failed|bad auth/i.test(message)) {
    return 'The database user or password in the connection-string secret is wrong, or the user was removed from the project.';
  }
  if (/not authorized/i.test(message)) {
    return 'The user cannot run ping on this database. Grant it read access, or set "dbName" to one it can reach (usually "admin").';
  }
  return undefined;
}

/**
 * Strip credentials out of anything that might reach a log, a GitHub Issue or
 * a committed history file.
 *
 * @param {string} text
 * @returns {string}
 */
export function redact(text) {
  return text.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/gi, '$1<credentials>@');
}

export default mongoCheck;
