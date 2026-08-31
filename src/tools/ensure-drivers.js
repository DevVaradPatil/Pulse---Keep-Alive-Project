#!/usr/bin/env node
/**
 * Install the database drivers this run actually needs, and nothing else.
 *
 * The pinger has no runtime dependencies. That is what makes it fast to start,
 * impossible to break with a transitive update, and safe to run straight from
 * source in a workflow. Only the `mongo` check type needs a driver, so it is
 * installed on demand — and only for runs whose config contains a mongo target.
 *
 *   node src/tools/ensure-drivers.js [--tier daily] [--config <path>]
 *
 * Prints what it did and exits 0 when nothing was needed.
 */

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { DEFAULT_CONFIG_PATH } from '../config/load.js';

/** Check type → npm package. A new type needing a driver adds one line here. */
const DRIVERS = Object.freeze({
  mongo: 'mongodb@^6',
});

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: DEFAULT_CONFIG_PATH },
    tier: { type: 'string' },
  },
});

const config = JSON.parse(await readFile(/** @type {string} */ (values.config), 'utf8'));
/** @type {Array<Record<string, any>>} */
const targets = (config.targets ?? []).filter(
  (/** @type {Record<string, any>} */ target) =>
    target.enabled !== false &&
    // Mirrors selectTargets(): the daily run covers everything, the frequent
    // run covers only frequent-tier targets.
    (values.tier !== 'frequent' || target.tier === 'frequent')
);

const needed = [...new Set(targets.map((target) => DRIVERS[target.type]).filter(Boolean))];

if (needed.length === 0) {
  console.log('No database drivers needed for this run — the zero-dependency path.');
  process.exit(0);
}

console.log(`Installing driver(s) for this run: ${needed.join(', ')}`);
const result = spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', ...needed], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  console.error(
    `npm install failed with status ${result.status}. Targets of type "mongo" cannot run without their driver.`
  );
  process.exit(1);
}
