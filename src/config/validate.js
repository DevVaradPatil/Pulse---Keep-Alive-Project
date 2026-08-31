/**
 * Semantic validation of `config/targets.json`.
 *
 * The JSON Schema covers shape. This module covers the rules a schema cannot
 * express, and it exists so that adding a project carelessly fails in CI rather
 * than silently monitoring nothing:
 *
 *  - duplicate `id`s (the dashboard key, so a duplicate would overwrite history)
 *  - fields that belong to a different check type
 *  - `${SECRET}` references not declared in `requiredSecrets`, and vice versa
 *  - credentials that must never be committed at any visibility
 */

import { assertRegistryMatchesSchema, checks, CHECK_TYPES } from '../checks/index.js';
import { collectSecretRefs } from './interpolate.js';
import { assertSupportedSchema, validateSchema } from './schema.js';

/** Fields every target may carry, regardless of check type. */
export const COMMON_FIELDS = Object.freeze([
  'id',
  'name',
  'type',
  'tier',
  'enabled',
  'platform',
  'publicUrl',
  'notes',
  'requiredSecrets',
  'timeoutMs',
  'retries',
]);

/**
 * @typedef {object} ValidationResult
 * @property {string[]} errors Must be empty for the config to be usable.
 * @property {string[]} warnings Worth reading; do not fail CI.
 */

/**
 * @param {unknown} rawConfig Parsed contents of targets.json, not yet interpolated.
 * @param {object} schema Parsed contents of targets.schema.json.
 * @returns {ValidationResult}
 */
export function validateConfig(rawConfig, schema) {
  assertSupportedSchema(schema);

  /** @type {string[]} */
  const errors = validateSchema(rawConfig, schema).map(
    (e) => `${e.path === '(root)' ? 'config' : e.path}: ${e.message}`
  );
  /** @type {string[]} */
  const warnings = [];

  // A check type that exists in only one of the two places is a half-finished
  // extension: either the schema forbids a config that would work, or it allows
  // one that would crash at run time.
  errors.push(...assertRegistryMatchesSchema(schema));

  // Once the shape is wrong, every semantic rule below would report noise
  // derived from the same mistake.
  if (errors.length > 0) return { errors, warnings };

  const config = /** @type {{ targets: Array<Record<string, any>> }} */ (rawConfig);
  const targets = config.targets ?? [];

  if (targets.length === 0) {
    warnings.push(
      'config/targets.json has no targets, so every run will be a no-op. See SETUP.md, "Add a new project in 60 seconds".'
    );
  }

  const seen = new Map();
  for (const [index, target] of targets.entries()) {
    const where = `targets[${index}] (${target.id ?? 'no id'})`;

    if (seen.has(target.id)) {
      errors.push(
        `${where}: duplicate id "${target.id}", already used by targets[${seen.get(target.id)}]. ` +
          'Ids are the dashboard key and must be unique, otherwise one project silently overwrites the history of the other.'
      );
    } else {
      seen.set(target.id, index);
    }

    validateTypeFields(target, where, errors);
    validateSecrets(target, where, errors);
    validateCredentialHygiene(target, where, errors, warnings);

    if (target.enabled === false) {
      warnings.push(`${where}: enabled is false, so this target is never checked.`);
    }
    if (
      target.type === 'http' &&
      target.body != null &&
      ['GET', 'HEAD'].includes(target.method ?? 'GET')
    ) {
      errors.push(
        `${where}: a ${target.method ?? 'GET'} request cannot carry a body. Remove "body", or set "method" to POST.`
      );
    }
    if (target.type === 'http' && target.expectBodyContains === undefined) {
      warnings.push(
        `${where}: no expectBodyContains. A cached 200 from a CDN edge will pass this check even if the database is asleep. ` +
          'Assert on something the health endpoint only emits after touching the database, e.g. "\\"ok\\":true".'
      );
    }
  }

  const frequent = targets.filter((t) => t.tier === 'frequent' && t.enabled !== false);
  if (frequent.length > 1) {
    warnings.push(
      `${frequent.length} targets are on the "frequent" tier (${frequent.map((t) => t.id).join(', ')}). ` +
        "Render's free tier gives 750 instance-hours per ACCOUNT per month, and one service kept awake 24/7 burns ~730 of them. " +
        'Keeping more than one service permanently awake will exhaust the allowance mid-month and suspend all of them. See SETUP.md.'
    );
  }

  return { errors, warnings };
}

/**
 * Reject fields that belong to another check type. This is the error you get
 * when you copy an existing entry to add a new project and forget to swap a
 * field, which is the single most likely way to break this config.
 *
 * @param {Record<string, any>} target
 * @param {string} where
 * @param {string[]} errors
 */
function validateTypeFields(target, where, errors) {
  const check = checks[target.type];
  if (!check) return; // Unknown type is already a schema error.

  const allowed = new Set([...COMMON_FIELDS, ...check.fields]);
  for (const key of Object.keys(target)) {
    if (allowed.has(key)) continue;
    const owner = CHECK_TYPES.find((type) => checks[type].fields.includes(key));
    errors.push(
      owner
        ? `${where}: "${key}" is only valid on targets of type "${owner}", but this target is type "${target.type}".`
        : `${where}: "${key}" is not a known field for type "${target.type}".`
    );
  }
}

/**
 * Both directions, deliberately. An undeclared reference means the workflow
 * will not pass the secret through; a declared-but-unused one is dead config
 * that outlives the target it belonged to.
 *
 * @param {Record<string, any>} target
 * @param {string} where
 * @param {string[]} errors
 */
function validateSecrets(target, where, errors) {
  const referenced = collectSecretRefs(target, `targets[${target.id ?? '?'}]`);
  const declared = new Set(target.requiredSecrets ?? []);
  const usedNames = new Set(referenced.map((ref) => ref.name));

  for (const ref of referenced) {
    if (!declared.has(ref.name)) {
      errors.push(
        `${where}: uses \${${ref.name}} but does not list it in requiredSecrets. ` +
          `Add "${ref.name}" to requiredSecrets, and make sure the workflow passes it through in its env: block.`
      );
    }
  }
  for (const name of declared) {
    if (!usedNames.has(name)) {
      errors.push(
        `${where}: declares requiredSecrets entry "${name}" but never uses \${${name}}. ` +
          'Remove it, or use it - an unused entry usually means a renamed field.'
      );
    }
  }
}

/**
 * Values that must never be committed, whatever the repository's visibility.
 *
 * Private is not a safe place for a password either: every collaborator can
 * read it, so can anyone who obtains a token, and the history keeps the value
 * for anyone who later gains access.
 *
 * @param {Record<string, any>} target
 * @param {string} where
 * @param {string[]} errors
 * @param {string[]} warnings
 */
function validateCredentialHygiene(target, where, errors, warnings) {
  const isRef = (/** @type {unknown} */ value) =>
    typeof value === 'string' && /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value);

  if (target.type === 'mongo' && !isRef(target.connectionString)) {
    errors.push(
      `${where}: connectionString must be a \${SECRET} reference. A Mongo URI contains a password, which does not belong in a repository at any visibility.`
    );
  }
  if (target.type === 'supabase' && !isRef(target.apiKey)) {
    warnings.push(
      `${where}: apiKey is a literal value. A Supabase anon key is designed to be public, but committing it ` +
        'makes rotation a code change, and in a public repo it will be scraped. Move it to a GitHub secret and reference it as ${SECRET_NAME}.'
    );
  }
  for (const [header, value] of Object.entries(target.headers ?? {})) {
    if (/^(authorization|x-api-key|apikey)$/i.test(header) && !isRef(value)) {
      errors.push(
        `${where}: header "${header}" has a literal value. Credentials must be \${SECRET} references, never committed.`
      );
    }
  }
}
