/**
 * The check registry.
 *
 * Adding a check type is two edits, by design:
 *   1. a new file in this directory exporting the `Check` shape from types.js
 *   2. one import and one entry below, plus the same string in the `type` enum
 *      of config/targets.schema.json
 *
 * `assertRegistryMatchesSchema()` fails validation if those two lists ever
 * drift apart, so a half-finished check type cannot ship.
 */

import httpCheck from './http.js';
import supabaseCheck from './supabase.js';
import mongoCheck from './mongo.js';
import { ConfigError } from '../lib/errors.js';

/** @type {Record<string, import('../types.js').Check>} */
export const checks = Object.freeze({
  http: httpCheck,
  supabase: supabaseCheck,
  mongo: mongoCheck,
});

/** @type {readonly string[]} */
export const CHECK_TYPES = Object.freeze(Object.keys(checks));

/**
 * @param {string} type
 * @returns {import('../types.js').Check}
 */
export function getCheck(type) {
  const check = checks[type];
  if (!check) {
    throw new ConfigError(`Unknown check type "${type}".`, {
      hint: `Known types: ${CHECK_TYPES.join(', ')}. Add a new one by creating src/checks/${type}.js and registering it in src/checks/index.js.`,
    });
  }
  return check;
}

/**
 * @param {object} schema Parsed targets.schema.json.
 * @returns {string[]} One message per drift, empty when the two agree.
 */
export function assertRegistryMatchesSchema(schema) {
  const enumerated = /** @type {any} */ (schema)?.$defs?.target?.properties?.type?.enum ?? [];
  /** @type {string[]} */
  const problems = [];

  for (const type of enumerated) {
    if (!CHECK_TYPES.includes(type)) {
      problems.push(
        `config/targets.schema.json allows type "${type}" but there is no src/checks/${type}.js registered in src/checks/index.js.`
      );
    }
  }
  for (const type of CHECK_TYPES) {
    if (!enumerated.includes(type)) {
      problems.push(
        `src/checks/${type}.js is registered but "${type}" is missing from the type enum in config/targets.schema.json, so no config may use it.`
      );
    }
  }
  return problems;
}
