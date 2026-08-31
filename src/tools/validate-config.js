#!/usr/bin/env node
/**
 * Validate a target list without touching the network or needing a single
 * secret to be set. This is what `validate.yml` runs on every push, and what
 * you run locally before pasting a config into the PULSE_TARGETS_JSON secret.
 *
 * It validates whatever the runner would actually use, in the same precedence:
 * an explicit `--config`, then the PULSE_TARGETS_JSON secret, then the
 * committed `config/targets.json`.
 *
 *   node src/tools/validate-config.js
 *   node src/tools/validate-config.js --config ./my-targets.json
 *   PULSE_TARGETS_JSON="$(cat ./my-targets.json)" node src/tools/validate-config.js
 *
 * Exit codes: 0 valid, 1 invalid (or `--strict` with warnings).
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_SCHEMA_PATH, readConfigSource, resolveEnv } from '../config/load.js';
import { validateConfig } from '../config/validate.js';
import { ConfigError } from '../lib/errors.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    schema: { type: 'string', default: DEFAULT_SCHEMA_PATH },
    strict: { type: 'boolean', default: false },
  },
});

/** @type {unknown} */
let config;
/** @type {string} */
let label;
/** @type {boolean} */
let fromSecret;
/** @type {object} */
let schema;

try {
  ({
    raw: config,
    label,
    fromSecret,
  } = await readConfigSource({ configPath: values.config, env: resolveEnv() }));
  schema = JSON.parse(await readFile(/** @type {string} */ (values.schema), 'utf8'));
} catch (error) {
  console.error(
    error instanceof ConfigError
      ? error.format()
      : `Could not read the config: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}

const { errors, warnings } = validateConfig(config, schema);

for (const warning of warnings) console.warn(`⚠  ${warning}\n`);

if (errors.length > 0) {
  console.error(`✖  ${label} is not valid — ${errors.length} problem(s):\n`);
  for (const error of errors) console.error(`   • ${error}\n`);
  console.error('Nothing was checked. Fix the entries above and run this again.');
  process.exit(1);
}

const count = /** @type {{ targets?: unknown[] }} */ (config).targets?.length ?? 0;
console.log(
  `✔  ${label} is valid: ${count} target(s), ${warnings.length} warning(s).` +
    (fromSecret
      ? '\n   Source: the PULSE_TARGETS_JSON secret, so nothing identifying is committed.'
      : '')
);

if (values.strict && warnings.length > 0) {
  console.error('--strict was set and there are warnings, so this is a failure.');
  process.exit(1);
}
