#!/usr/bin/env node
/**
 * Validate `config/targets.json` without touching the network or needing a
 * single secret to be set. This is what `validate.yml` runs on every push, and
 * what you run locally before opening a PR.
 *
 *   node src/tools/validate-config.js [--config <path>] [--strict]
 *
 * Exit codes: 0 valid, 1 invalid (or `--strict` with warnings).
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_CONFIG_PATH, DEFAULT_SCHEMA_PATH } from '../config/load.js';
import { validateConfig } from '../config/validate.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: DEFAULT_CONFIG_PATH },
    schema: { type: 'string', default: DEFAULT_SCHEMA_PATH },
    strict: { type: 'boolean', default: false },
  },
});

const configPath = /** @type {string} */ (values.config);
const schemaPath = /** @type {string} */ (values.schema);

/** @type {unknown} */
let config;
/** @type {object} */
let schema;

try {
  config = JSON.parse(await readFile(configPath, 'utf8'));
  schema = JSON.parse(await readFile(schemaPath, 'utf8'));
} catch (error) {
  console.error(
    `Could not read the config: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}

const { errors, warnings } = validateConfig(config, schema);

for (const warning of warnings) console.warn(`⚠  ${warning}\n`);

if (errors.length > 0) {
  console.error(`✖  ${configPath} is not valid — ${errors.length} problem(s):\n`);
  for (const error of errors) console.error(`   • ${error}\n`);
  console.error('Nothing was checked. Fix the entries above and run this again.');
  process.exit(1);
}

const count = /** @type {{ targets?: unknown[] }} */ (config).targets?.length ?? 0;
console.log(`✔  ${configPath} is valid: ${count} target(s), ${warnings.length} warning(s).`);

if (values.strict && warnings.length > 0) {
  console.error('--strict was set and there are warnings, so this is a failure.');
  process.exit(1);
}
