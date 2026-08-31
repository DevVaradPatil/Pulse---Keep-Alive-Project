/**
 * Loading, validating and resolving `config/targets.json`.
 *
 * The order here is deliberate: parse, then validate the *raw* file, then
 * resolve secrets. Validating before interpolation means schema errors point at
 * the text you actually wrote, and no secret value can ever appear in a
 * validation message.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../lib/errors.js';
import { interpolate } from './interpolate.js';
import { validateConfig } from './validate.js';

export const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL('../../config/targets.json', import.meta.url)
);
export const DEFAULT_SCHEMA_PATH = fileURLToPath(
  new URL('../../config/targets.schema.json', import.meta.url)
);

/**
 * Applied to every target that does not override the field. Kept here rather
 * than in the schema so there is exactly one place to read the effective value.
 *
 * @type {import('../types.js').RunDefaults}
 */
export const BUILT_IN_DEFAULTS = Object.freeze({
  timeoutMs: 30000,
  retries: 2,
  expectStatus: 200,
  concurrency: 5,
  jitterMs: 2000,
  backoffBaseMs: 1000,
  backoffMaxMs: 15000,
});

/**
 * Merge GitHub Actions secrets injected as a single JSON blob into the ambient
 * environment.
 *
 * The workflows set `PULSE_SECRETS_JSON: ${{ toJSON(secrets) }}`. Without this,
 * every new project with a secret would need a matching line in an `env:` block
 * in two workflow files — which would break the one-file-one-entry rule that
 * the whole design exists to protect.
 *
 * The trade-off, stated plainly: the pinger process can see every repository
 * secret, not only the ones it uses. Since the process runs code from this
 * repository's default branch and Actions never exposes secrets to pull
 * requests from forks, the exposure is the same code that would have read them
 * from individual `env:` entries anyway. If you would rather not, delete the
 * `PULSE_SECRETS_JSON` line from the workflows and list secrets explicitly.
 *
 * @param {Record<string, string | undefined>} [processEnv]
 * @returns {Record<string, string | undefined>}
 */
export function resolveEnv(processEnv = process.env) {
  const injected = processEnv.PULSE_SECRETS_JSON;
  if (!injected) return processEnv;

  /** @type {Record<string, unknown>} */
  let parsed;
  try {
    parsed = JSON.parse(injected);
  } catch (error) {
    throw new ConfigError('PULSE_SECRETS_JSON is set but is not valid JSON.', {
      cause: error,
      hint: 'It should be `${{ toJSON(secrets) }}` in the workflow. Nothing else should ever set it.',
    });
  }

  const merged = { ...processEnv };
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value !== '') merged[name] = value;
  }
  return merged;
}

/**
 * Decide where the target list comes from.
 *
 * Precedence, most explicit first:
 *
 *   1. `--config <path>`            an explicit file, always wins
 *   2. `PULSE_TARGETS_JSON`         the whole config as one secret
 *   3. `config/targets.json`        the committed file
 *
 * Option 2 exists for a public repository that must not reveal *what* is being
 * monitored. `${SECRET}` references already keep keys out of the repo, but the
 * URLs, project names and platform labels are still identifying, and a public
 * repo publishes them to anyone who looks. Putting the entire config in one
 * repository secret leaves nothing in the repo but code.
 *
 * The cost is real and worth stating: no diff, no pull-request review, and no
 * editor autocomplete when you change it. A private repository keeps all of
 * that and needs none of this - see SETUP.md, "Choose your mode".
 *
 * @param {{ configPath?: string, env: Record<string, string | undefined> }} options
 * @returns {Promise<{ raw: unknown, label: string, fromSecret: boolean }>}
 */
export async function readConfigSource({ configPath, env }) {
  if (configPath) {
    return { raw: await readJson(configPath), label: configPath, fromSecret: false };
  }

  const inline = env.PULSE_TARGETS_JSON;
  if (inline && inline.trim() !== '') {
    try {
      return { raw: JSON.parse(inline), label: 'PULSE_TARGETS_JSON', fromSecret: true };
    } catch (error) {
      throw new ConfigError('PULSE_TARGETS_JSON is set but is not valid JSON.', {
        cause: error,
        hint: [
          'It must hold the entire contents of a targets file, the same shape as config/targets.json.',
          'Check it locally before pasting it into the secret:',
          "  node -e \"JSON.parse(require('fs').readFileSync('my-targets.json','utf8'))\"",
        ].join('\n'),
      });
    }
  }

  return {
    raw: await readJson(DEFAULT_CONFIG_PATH),
    label: DEFAULT_CONFIG_PATH,
    fromSecret: false,
  };
}

/**
 * @typedef {object} LoadedConfig
 * @property {import('../types.js').RunDefaults} defaults
 * @property {import('../types.js').Target[]} targets Enabled targets only, secrets resolved.
 * @property {string[]} warnings
 * @property {number} disabledCount
 * @property {string} source Where the config came from, for messages.
 * @property {boolean} fromSecret Whether it came from PULSE_TARGETS_JSON, which changes what has to be masked.
 * @property {boolean} publishDetails Whether names, platforms, URLs and notes may leave this repository.
 */

/**
 * @param {object} [options]
 * @param {string} [options.configPath]
 * @param {string} [options.schemaPath]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {boolean} [options.allowMissingSecrets] Only ever set by `--dry-run --skip-secrets`.
 * @returns {Promise<LoadedConfig>}
 */
export async function loadConfig(options = {}) {
  const {
    configPath,
    schemaPath = DEFAULT_SCHEMA_PATH,
    env = resolveEnv(),
    allowMissingSecrets = false,
  } = options;

  const { raw, label, fromSecret } = await readConfigSource({ configPath, env });
  const schema = await readJson(schemaPath);

  const { errors, warnings } = validateConfig(raw, schema);
  if (errors.length > 0) {
    throw new ConfigError(`${label} is not valid:`, {
      problems: errors,
      hint: 'Fix the entries above. `npm run validate` reproduces this locally, and validate.yml runs it on every push.',
    });
  }

  const config =
    /** @type {{ defaults?: object, privacy?: { publishDetails?: boolean }, targets: Array<Record<string, any>> }} */ (
      raw
    );
  /** @type {import('../types.js').RunDefaults} */
  const defaults = { ...BUILT_IN_DEFAULTS, ...(config.defaults ?? {}) };

  // Privacy defaults to "publish everything", except when the config arrived as
  // a secret: hiding the target list and then republishing the names and URLs
  // in the history file would defeat the point. An explicit value always wins.
  const publishDetails = config.privacy?.publishDetails ?? !fromSecret;

  const enabled = config.targets.filter((target) => target.enabled !== false);
  const targets = enabled.map((target) =>
    resolveTarget(target, defaults, env, allowMissingSecrets)
  );

  return {
    defaults,
    targets,
    warnings,
    disabledCount: config.targets.length - enabled.length,
    source: label,
    fromSecret,
    publishDetails,
  };
}

/**
 * @param {Record<string, any>} target
 * @param {import('../types.js').RunDefaults} defaults
 * @param {Record<string, string | undefined>} env
 * @param {boolean} allowMissingSecrets
 * @returns {import('../types.js').Target}
 */
function resolveTarget(target, defaults, env, allowMissingSecrets) {
  const { value } = interpolate(target, env, {
    basePath: `targets[${target.id}]`,
    allowMissing: allowMissingSecrets,
  });

  return {
    enabled: true,
    timeoutMs: defaults.timeoutMs,
    retries: defaults.retries,
    expectStatus: defaults.expectStatus,
    .../** @type {object} */ (value),
  };
}

/**
 * @param {string} path
 * @returns {Promise<any>}
 */
async function readJson(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    throw new ConfigError(
      code === 'ENOENT' ? `Cannot find ${path}.` : `Cannot read ${path}: ${String(error)}`,
      {
        cause: error,
        hint:
          code === 'ENOENT'
            ? 'Run Pulse from the repository root, or pass --config <path>.'
            : undefined,
      }
    );
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
        hint: 'A trailing comma after the last entry is the usual cause. JSON does not allow comments either - use the "notes" field.',
      }
    );
  }
}

/**
 * Decide which targets a run covers.
 *
 * `daily` covers **every** enabled target, not only the ones tagged `daily`.
 * The daily run is what writes history, so a frequent-tier target that were
 * excluded here would never get a history entry and its dashboard card would
 * stay empty forever. The frequent run is the narrow one: it exists purely to
 * keep short-spin-down services awake between daily runs.
 *
 * @param {import('../types.js').Target[]} targets
 * @param {{ tier?: string, id?: string }} filter
 * @returns {import('../types.js').Target[]}
 */
export function selectTargets(targets, filter = {}) {
  let selected = targets;
  if (filter.tier === 'frequent') {
    selected = selected.filter((target) => target.tier === 'frequent');
  }
  if (filter.id) {
    selected = selected.filter((target) => target.id === filter.id);
  }
  return selected;
}
