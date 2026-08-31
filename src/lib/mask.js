/**
 * Keeping sensitive values out of everything Pulse writes.
 *
 * There are two separate mechanisms here and they cover different holes.
 *
 * 1. `buildRedactor()` masks values inside strings that *Pulse itself* writes:
 *    the console table, the step summary, the committed history file, and
 *    GitHub issue bodies. Those last two matter most - Actions scrubs its own
 *    logs, but it has no idea what we commit to a branch or post to an issue.
 *
 * 2. `emitActionsMasks()` tells the Actions runner to scrub a value from the
 *    log. GitHub already does this for registered repository secrets, but not
 *    for values that only *appear* inside one: if the whole target list arrives
 *    as one `PULSE_TARGETS_JSON` secret, the individual URLs inside it are not
 *    registered and would be printed in the clear. `::add-mask::` closes that.
 */

/**
 * Values shorter than this are not masked. Masking a 3-character string would
 * replace ordinary words all over an error message and make it unreadable.
 */
const MIN_MASKABLE_LENGTH = 8;

/**
 * Build a function that replaces every known sensitive value with `***`.
 *
 * @param {Iterable<string | undefined>} values
 * @returns {(text: string) => string}
 */
export function buildRedactor(values) {
  const sorted = [...collectMaskable(values)].sort((a, b) => b.length - a.length);
  if (sorted.length === 0) return (text) => text;
  // Longest first, so masking "https://x.example/api/health" does not leave the
  // tail of a longer secret that contained it.
  return (text) => sorted.reduce((acc, value) => acc.split(value).join('***'), text);
}

/**
 * Ask the Actions runner to scrub these values from the log.
 *
 * A no-op outside Actions: locally the terminal is yours, and printing
 * `::add-mask::` lines to it would be noise.
 *
 * @param {Iterable<string | undefined>} values
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(line: string) => void} [options.write]
 * @returns {number} How many values were registered.
 */
export function emitActionsMasks(values, options = {}) {
  const { env = process.env, write = (line) => process.stdout.write(`${line}\n`) } = options;
  if (env.GITHUB_ACTIONS !== 'true') return 0;

  let count = 0;
  for (const value of collectMaskable(values)) {
    // A newline would end the workflow command early and leak the remainder.
    write(`::add-mask::${value.replace(/\r?\n/g, ' ')}`);
    count += 1;
  }
  return count;
}

/**
 * Every value worth masking for a set of resolved targets: the secrets they
 * used, and - when the config itself came from a secret - the URLs and hosts
 * that would otherwise identify the projects being monitored.
 *
 * @param {import('../types.js').Target[]} targets
 * @param {Record<string, string | undefined>} env
 * @param {{ includeIdentifiers?: boolean }} [options]
 * @returns {string[]}
 */
export function sensitiveValuesFor(targets, env, options = {}) {
  /** @type {Array<string | undefined>} */
  const values = [];

  for (const target of targets) {
    for (const name of target.requiredSecrets ?? []) values.push(env[name]);

    // A connection string always contains a password, whatever the mode.
    values.push(target.connectionString);

    if (options.includeIdentifiers) {
      values.push(target.url, target.supabaseUrl, target.publicUrl);
      // Bare hosts too: a cluster hostname in a driver error message identifies
      // the project just as well as the full URL does.
      for (const url of [
        target.url,
        target.supabaseUrl,
        target.publicUrl,
        target.connectionString,
      ]) {
        const host = hostOf(url);
        if (host) values.push(host);
      }
    }
  }

  return [...collectMaskable(values)];
}

/**
 * Strip identifying fields out of results before they are published.
 *
 * "Published" means the three places a result outlives the run: the committed
 * history file, a GitHub issue body, and the workflow step summary. Hiding the
 * config in a secret would be pointless if the results then republished the
 * project names and URLs it was hiding.
 *
 * Failure text is deliberately kept - `expected HTTP 200 but got 503` is not
 * identifying, and losing it would make a red dashboard useless. Any URL inside
 * it is masked separately by the redactor.
 *
 * @param {import('../types.js').RunResult[]} results
 * @returns {import('../types.js').RunResult[]}
 */
export function stripIdentifiers(results) {
  return results.map((result) => {
    const { platform: _platform, publicUrl: _publicUrl, notes: _notes, ...kept } = result;
    return { ...kept, name: result.id };
  });
}

/**
 * @param {Iterable<string | undefined>} values
 * @returns {Set<string>}
 */
function collectMaskable(values) {
  /** @type {Set<string>} */
  const set = new Set();
  for (const value of values) {
    if (typeof value === 'string' && value.length >= MIN_MASKABLE_LENGTH) set.add(value);
  }
  return set;
}

/**
 * @param {string | undefined} url
 * @returns {string | undefined}
 */
function hostOf(url) {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
