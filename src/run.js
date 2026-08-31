#!/usr/bin/env node
/**
 * Pulse entrypoint.
 *
 * Exit codes are meaningful, because the workflow's exit code is the alert:
 *   0  every selected target is healthy (or there was nothing to do)
 *   1  at least one target ultimately failed, after retries
 *   2  the run never started: bad config, missing secret, bad flag
 *
 * Usage:
 *   node src/run.js --tier daily --notify --out .pulse/run.json
 *   node src/run.js --target spotify-clone
 *   node src/run.js --dry-run --skip-secrets
 */

import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, resolveEnv, selectTargets } from './config/load.js';
import { getCheck } from './checks/index.js';
import { buildUserAgent, runChecks } from './runner.js';
import { renderMarkdown, renderTable, summarise, writeStepSummary } from './report.js';
import { notify } from './notify.js';
import { ConfigError } from './lib/errors.js';

const USAGE = `
Pulse — keep-alive and uptime checks for free-tier side projects.

  node src/run.js [options]

Options:
  --tier <daily|frequent>  Which run this is. "daily" covers every enabled target
                           (and is the one that records history); "frequent" covers
                           only targets tagged frequent. Default: all targets.
  --target <id>            Check a single target by id. Combines with --tier.
  --dry-run                Resolve and validate everything, send no requests.
  --skip-secrets           Only with --dry-run: tolerate unset \${SECRET} references.
  --notify                 Open/update/close GitHub issues and post the webhook.
  --out <path>             Write the results as JSON (used by the history step).
  --config <path>          Default: config/targets.json
  --concurrency <n>        Override the configured concurrency cap.
  --help                   Show this.
`.trim();

/**
 * @param {string[]} argv
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv = process.argv.slice(2)) {
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        tier: { type: 'string' },
        target: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'skip-secrets': { type: 'boolean', default: false },
        notify: { type: 'boolean', default: false },
        out: { type: 'string' },
        config: { type: 'string' },
        concurrency: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }

  const flags = /** @type {Record<string, any>} */ (parsed.values);
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }

  if (flags.tier !== undefined && !['daily', 'frequent'].includes(flags.tier)) {
    console.error(`--tier must be "daily" or "frequent", got ${JSON.stringify(flags.tier)}.`);
    return 2;
  }
  if (flags['skip-secrets'] && !flags['dry-run']) {
    console.error(
      '--skip-secrets is only allowed together with --dry-run. Pinging with an unresolved ${SECRET} would look like a rotated key.'
    );
    return 2;
  }

  const startedAt = new Date();
  // Resolved once so the loader and the redactor see exactly the same secrets.
  const env = resolveEnv();

  /** @type {import('./config/load.js').LoadedConfig} */
  let config;
  try {
    config = await loadConfig({
      configPath: flags.config,
      env,
      allowMissingSecrets: Boolean(flags['skip-secrets']),
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.format());
      return 2;
    }
    throw error;
  }

  for (const warning of config.warnings) console.warn(`warning: ${warning}`);

  const targets = selectTargets(config.targets, { tier: flags.tier, id: flags.target });
  const redact = buildRedactor(config.targets, env);

  if (flags.target && targets.length === 0) {
    console.error(
      `No enabled target with id "${flags.target}"${flags.tier ? ` on the ${flags.tier} tier` : ''}. ` +
        `Known ids: ${config.targets.map((t) => t.id).join(', ') || '(none)'}`
    );
    return 2;
  }
  if (targets.length === 0) {
    console.log(
      `Nothing to check${flags.tier ? ` on the ${flags.tier} tier` : ''}` +
        `${config.disabledCount > 0 ? ` (${config.disabledCount} target(s) disabled)` : ''}. Exiting cleanly.`
    );
    return 0;
  }

  const defaults = {
    ...config.defaults,
    ...(flags.concurrency ? { concurrency: Number(flags.concurrency) } : {}),
  };

  if (flags['dry-run']) {
    printPlan(targets, defaults, redact);
    return 0;
  }

  console.log(
    `Checking ${targets.length} target${targets.length === 1 ? '' : 's'}` +
      `${flags.tier ? ` on the ${flags.tier} tier` : ''}, up to ${defaults.concurrency} at a time.\n`
  );

  const results = (
    await runChecks(targets, {
      defaults,
      userAgent: buildUserAgent(),
      onResult: (result) =>
        console.log(
          `${result.ok ? '  ok  ' : ' FAIL '} ${result.id.padEnd(24)} ${String(result.durationMs).padStart(6)} ms  ${redact(
            result.ok ? (result.detail ?? '') : (result.error ?? '')
          )}`
        ),
      onRetryLog: (line) => console.log(`  ...  ${redact(line)}`),
    })
  ).map((result) => ({
    ...result,
    detail: result.detail ? redact(result.detail) : result.detail,
    error: result.error ? redact(result.error) : result.error,
  }));

  const durationMs = Date.now() - startedAt.getTime();
  const { total, ok, failed } = summarise(results);

  console.log(`\n${renderTable(results)}\n`);
  console.log(`${ok}/${total} healthy, ${failed} failing, in ${(durationMs / 1000).toFixed(1)}s`);

  await writeStepSummary(renderMarkdown(results, { tier: flags.tier, startedAt, durationMs }));

  if (flags.out) {
    await mkdir(dirname(flags.out), { recursive: true });
    await writeFile(
      flags.out,
      `${JSON.stringify({ startedAt: startedAt.toISOString(), tier: flags.tier ?? null, results }, null, 2)}\n`,
      'utf8'
    );
    console.log(`Wrote ${flags.out}`);
  }

  if (flags.notify) {
    const summary = await notify({ results, log: (line) => console.log(`notify: ${line}`) });
    const counts = [
      summary.opened.length && `${summary.opened.length} opened`,
      summary.updated.length && `${summary.updated.length} updated`,
      summary.closed.length && `${summary.closed.length} closed`,
    ].filter(Boolean);
    if (counts.length > 0) console.log(`notify: issues — ${counts.join(', ')}`);
  }

  return failed > 0 ? 1 : 0;
}

/**
 * @param {import('./types.js').Target[]} targets
 * @param {import('./types.js').RunDefaults} defaults
 * @param {(text: string) => string} redact
 */
function printPlan(targets, defaults, redact) {
  console.log(
    `Dry run: config is valid and ${targets.length} target${targets.length === 1 ? '' : 's'} resolved. No requests were sent.\n`
  );
  for (const target of targets) {
    console.log(`  ${target.id}  [${target.type}/${target.tier}]  ${target.name}`);
    console.log(`      ${redact(getCheck(target.type).describe(target))}`);
    console.log(
      `      timeout ${target.timeoutMs} ms · ${target.retries} retries · secrets: ${
        target.requiredSecrets?.join(', ') || 'none'
      }`
    );
  }
  console.log(
    `\nRunner: concurrency ${defaults.concurrency}, jitter up to ${defaults.jitterMs} ms, backoff ${defaults.backoffBaseMs}–${defaults.backoffMaxMs} ms.`
  );
}

/**
 * Mask resolved secret values in anything we print, write to history, or send
 * to a GitHub issue. Actions masks secrets in its own logs, but the history
 * file and issue bodies are ours to keep clean — and locally nothing masks
 * anything at all.
 *
 * @param {import('./types.js').Target[]} targets
 * @param {Record<string, string | undefined>} [env]
 * @returns {(text: string) => string}
 */
export function buildRedactor(targets, env = process.env) {
  const values = new Set();
  for (const target of targets) {
    for (const name of target.requiredSecrets ?? []) {
      const value = env[name];
      // Very short values would mask ordinary words in error messages.
      if (value && value.length >= 8) values.add(value);
    }
  }
  const sorted = [...values].sort((a, b) => b.length - a.length);
  return (text) => sorted.reduce((acc, value) => acc.split(value).join('***'), text);
}

// Only run when executed directly, so tests can import main() without it firing.
// pathToFileURL rather than string surgery: on Windows the two spellings of a
// path differ in ways that would silently disable this.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main();
}
