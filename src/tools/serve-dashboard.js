#!/usr/bin/env node
/**
 * Serve the dashboard locally, against the real history.
 *
 * This is how a private repository views its status. GitHub Pages needs a
 * public repository on the Free plan, and the published page fetches
 * history.json from raw.githubusercontent.com, which also needs the repo to be
 * public - so on a private repo the hosted dashboard is not merely disabled,
 * it is unavailable by construction.
 *
 * The page itself is identical. Only the data source changes: instead of a raw
 * GitHub URL, this reads history.json out of the local `status` branch and
 * serves it from memory. Nothing is published, nothing is written to disk.
 *
 *   npm run dashboard              # fetch the status branch, then serve
 *   npm run dashboard -- --no-fetch
 *   npm run dashboard -- --history ./some/history.json --port 4000
 */

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DASHBOARD_DIR = fileURLToPath(new URL('../../dashboard', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HISTORY_PATH_ON_BRANCH = 'status/history.json';

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
});

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    history: { type: 'string' },
    branch: { type: 'string', default: 'status' },
    fetch: { type: 'boolean', default: true },
    'no-fetch': { type: 'boolean', default: false },
  },
});

const port = Number(values.port);
const branch = /** @type {string} */ (values.branch);
const shouldFetch = values.fetch && !values['no-fetch'];

/**
 * Read the history from an explicit file, or out of the status branch.
 *
 * `git show` rather than a checkout: it never touches the working tree, so this
 * is safe to run while you have uncommitted work.
 *
 * @returns {Promise<{ body: string, origin: string }>}
 */
async function loadHistoryJson() {
  if (values.history) {
    return { body: await readFile(values.history, 'utf8'), origin: values.history };
  }

  if (shouldFetch) {
    try {
      await run('git', ['fetch', 'origin', `${branch}:${branch}`], { cwd: REPO_ROOT });
    } catch {
      // No remote, no network, or the branch does not exist yet. Fall through
      // to whatever local copy of the branch exists.
    }
  }

  for (const ref of [branch, `origin/${branch}`]) {
    try {
      const { stdout } = await run('git', ['show', `${ref}:${HISTORY_PATH_ON_BRANCH}`], {
        cwd: REPO_ROOT,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { body: stdout, origin: `${ref}:${HISTORY_PATH_ON_BRANCH}` };
    } catch {
      // Try the next ref.
    }
  }

  throw new Error(
    `Could not read ${HISTORY_PATH_ON_BRANCH} from the "${branch}" branch.\n` +
      'The daily heartbeat creates it on its first successful run. Until then there is nothing to show.\n' +
      'To preview against a file instead:  npm run dashboard -- --history ./path/to/history.json'
  );
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;

  // The dashboard asks for ./history.json; everything else is a static asset.
  if (pathname === '/history.json') {
    try {
      const { body } = await loadHistoryJson();
      response.writeHead(200, {
        'content-type': CONTENT_TYPES['.json'],
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch (error) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  // normalize() collapses any ../ before the prefix check, so a request cannot
  // escape the dashboard directory.
  const filePath = normalize(join(DASHBOARD_DIR, pathname));
  if (!filePath.startsWith(DASHBOARD_DIR)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(file);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`Not found: ${pathname}`);
  }
});

server.listen(port, () => {
  console.log(`Pulse dashboard: http://localhost:${port}`);
  console.log(
    values.history
      ? `Reading history from ${values.history}`
      : `Reading history from the "${branch}" branch${shouldFetch ? ' (fetched from origin)' : ''}`
  );
  console.log('Nothing is published. Ctrl+C to stop.');
});
