/**
 * Secret interpolation for the config file.
 *
 * No key is ever committed, whatever the repository's visibility. Any string in
 * `config/targets.json` may contain `${SECRET_NAME}` placeholders which are
 * resolved from `process.env` at runtime, where GitHub Actions injects them
 * from repository secrets. A private repository is not an excuse to inline one:
 * every collaborator can read it, and a repo that starts private can be made
 * public with one click years later.
 *
 * The one behaviour that must never happen is silently sending a request with
 * the literal text `${SPOTIFY_SUPABASE_ANON_KEY}` as the API key, because the
 * resulting 401 looks like a rotated key and wastes an evening. Unresolved
 * references are collected and reported by name and by config path.
 */

import { MissingSecretError } from '../lib/errors.js';

/** Matches `${NAME}`. A literal `$${NAME}` is an escape and is not a reference. */
const REFERENCE = /(\$?)\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * @typedef {object} SecretReference
 * @property {string} name Environment variable name.
 * @property {string} path Dotted path within the config, for error messages.
 */

/**
 * List every `${SECRET}` referenced inside a value, without resolving anything.
 * Used by validation to cross-check `requiredSecrets`.
 *
 * @param {unknown} value
 * @param {string} [basePath]
 * @returns {SecretReference[]}
 */
export function collectSecretRefs(value, basePath = '') {
  /** @type {SecretReference[]} */
  const found = [];
  walk(value, basePath, (text, path) => {
    for (const match of text.matchAll(REFERENCE)) {
      if (match[1] === '$') continue; // escaped: $${NAME}
      found.push({ name: match[2], path });
    }
    return text;
  });
  return found;
}

/**
 * Resolve every `${SECRET}` inside a value against `env`.
 *
 * @param {unknown} value
 * @param {Record<string, string | undefined>} env
 * @param {object} [options]
 * @param {string} [options.basePath] Path prefix used in error messages.
 * @param {boolean} [options.allowMissing] Leave unresolved refs as `${NAME}` instead of throwing. Only ever true for `--dry-run --skip-secrets`.
 * @returns {{ value: unknown, missing: SecretReference[], resolved: SecretReference[] }}
 */
export function interpolate(value, env, options = {}) {
  const { basePath = '', allowMissing = false } = options;
  /** @type {SecretReference[]} */
  const missing = [];
  /** @type {SecretReference[]} */
  const resolved = [];

  const next = walk(value, basePath, (text, path) =>
    text.replace(REFERENCE, (whole, escape, name) => {
      if (escape === '$') return whole.slice(1); // $${NAME} -> ${NAME}
      const found = env[name];
      if (found === undefined || found === '') {
        missing.push({ name, path });
        return whole;
      }
      resolved.push({ name, path });
      return found;
    })
  );

  if (missing.length > 0 && !allowMissing) {
    throw new MissingSecretError(
      `${missing.length} secret${missing.length === 1 ? '' : 's'} referenced by the target config ${
        missing.length === 1 ? 'is' : 'are'
      } not set in the environment:`,
      {
        problems: missing.map((ref) => `${ref.name} (used at ${ref.path})`),
        hint: [
          'Set them as GitHub repository secrets: Settings > Secrets and variables > Actions.',
          'The heartbeat workflows pass every repository secret through, so no workflow edit is needed',
          '(unless you removed the PULSE_SECRETS_JSON line, in which case add an env: entry too).',
          'Locally, export them in your shell first:',
          ...unique(missing.map((ref) => ref.name)).map((name) => `  export ${name}='...'`),
        ].join('\n'),
      }
    );
  }

  return { value: next, missing, resolved };
}

/**
 * Depth-first structural copy that applies `transform` to every string.
 *
 * @param {unknown} value
 * @param {string} path
 * @param {(text: string, path: string) => string} transform
 * @returns {unknown}
 */
function walk(value, path, transform) {
  if (typeof value === 'string') return transform(value, path || '(root)');
  if (Array.isArray(value)) return value.map((item, i) => walk(item, `${path}[${i}]`, transform));
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = walk(item, path ? `${path}.${key}` : key, transform);
    }
    return out;
  }
  return value;
}

/**
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
function unique(items) {
  return [...new Set(items)];
}
