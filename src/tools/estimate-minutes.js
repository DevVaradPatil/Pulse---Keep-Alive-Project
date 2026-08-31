#!/usr/bin/env node
/**
 * Estimate the GitHub Actions minutes this repository's schedules will consume
 * per month, and check them against a plan's budget.
 *
 * This exists because the public/private decision is entirely an arithmetic
 * question, and getting it wrong is expensive in a way you only discover
 * halfway through a month when your workflows stop running.
 *
 * The billing rules that matter:
 *   - A public repository has unlimited minutes on standard runners.
 *   - A private repository on GitHub Free has 2,000 minutes per month.
 *   - Every job is rounded UP to the nearest minute. A job that takes nine
 *     seconds costs one minute, so the cost of a schedule is simply its number
 *     of runs - which is why a 10-minute cron costs ~4,320 minutes a month and
 *     cannot fit in a private repository's budget, no matter how fast it is.
 *   - A job skipped by a job-level `if:` never allocates a runner, so it costs
 *     nothing. That is how the frequent tier stays free until you enable it.
 *
 *   node src/tools/estimate-minutes.js [--plan private-free|public] [--json]
 *
 * Exits 1 if the estimate exceeds the plan's budget.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const WORKFLOW_DIR = fileURLToPath(new URL('../../.github/workflows', import.meta.url));
const DAYS_PER_MONTH = 30;

/** Minutes billed for a single job, by GitHub's per-job round-up. */
const MINUTES_PER_RUN = 1;

const PLANS = Object.freeze({
  'private-free': { label: 'private repository, GitHub Free', budget: 2000 },
  'private-pro': { label: 'private repository, GitHub Pro', budget: 3000 },
  public: { label: 'public repository', budget: Infinity },
});

/**
 * Count how many times a five-field cron expression fires in a 30-day month.
 *
 * Brute force over every minute of the window: 43,200 iterations is instant and
 * removes any chance of an off-by-one in a hand-rolled cron calculation.
 *
 * @param {string} expression Standard five-field cron: minute hour dom month dow.
 * @returns {number}
 */
export function runsPerMonth(expression) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`"${expression}" is not a five-field cron expression.`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map(parseField);
  let count = 0;

  // A fixed, arbitrary start: any 30-day window gives the same answer for the
  // expressions a scheduler like this uses.
  const start = Date.UTC(2026, 0, 1);
  for (let offset = 0; offset < DAYS_PER_MONTH * 24 * 60; offset++) {
    const at = new Date(start + offset * 60000);
    if (!minute.has(at.getUTCMinutes())) continue;
    if (!hour.has(at.getUTCHours())) continue;
    if (!month.has(at.getUTCMonth() + 1)) continue;

    // Cron's day fields are an OR when both are restricted, which is a genuine
    // quirk of the format rather than a bug here.
    const domRestricted = fields[2] !== '*';
    const dowRestricted = fields[4] !== '*';
    const domMatch = dayOfMonth.has(at.getUTCDate());
    const dowMatch = dayOfWeek.has(at.getUTCDay());

    if (domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch) count += 1;
  }

  return count;
}

/**
 * @param {string} field
 * @param {number} index
 * @returns {Set<number>}
 */
function parseField(field, index) {
  const ranges = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 6], // day of week
  ][index];

  /** @type {Set<number>} */
  const values = new Set();

  for (const part of field.split(',')) {
    const [spec, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in cron field "${field}".`);

    let from;
    let to;
    if (spec === '*') {
      [from, to] = ranges;
    } else if (spec.includes('-')) {
      const [a, b] = spec.split('-').map(Number);
      from = a;
      to = b;
    } else {
      from = Number(spec);
      to = Number(spec);
    }

    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new Error(`Bad cron field "${field}".`);
    }
    for (let value = from; value <= to; value += step) values.add(value % (ranges[1] + 1));
  }

  return values;
}

/**
 * Pull the schedules out of a workflow file without a YAML parser.
 *
 * Deliberately textual: the point of this tool is to keep the project at zero
 * dependencies, and cron lines have exactly one shape in these files.
 *
 * @param {string} text
 * @returns {{ crons: string[], gated: boolean }}
 */
export function readSchedules(text) {
  // Quoted or bare, with or without a trailing `# comment`.
  const crons = [
    ...text.matchAll(/^\s*-\s*cron:\s*(?:'([^']+)'|"([^"]+)"|([^#\n]+?))\s*(?:#.*)?$/gm),
  ].map((match) => (match[1] ?? match[2] ?? match[3]).trim());

  // A schedule block whose crons we failed to read would silently understate
  // the bill, which is the one mistake this tool exists to prevent.
  if (/^\s*schedule:\s*$/m.test(text) && crons.length === 0) {
    throw new Error('Found a `schedule:` block but could not read any cron expression from it.');
  }
  // A job-level `if:` that tests a repository variable means the schedule fires
  // but allocates no runner unless the variable is set, so it costs nothing.
  const gated = /^\s{4}if:\s*.*vars\./m.test(text);
  return { crons, gated };
}

/**
 * @param {{ dir?: string }} [options]
 * @returns {Promise<Array<{ file: string, crons: string[], gated: boolean, runs: number, minutes: number }>>}
 */
export async function estimateWorkflows(options = {}) {
  const dir = options.dir ?? WORKFLOW_DIR;
  const files = (await readdir(dir)).filter((name) => /\.ya?ml$/.test(name)).sort();

  const rows = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    const { crons, gated } = readSchedules(text);
    if (crons.length === 0) continue;

    const runs = crons.reduce((sum, cron) => sum + runsPerMonth(cron), 0);
    rows.push({ file, crons, gated, runs, minutes: gated ? 0 : runs * MINUTES_PER_RUN });
  }
  return rows;
}

// Everything below is the CLI. Guarded so the tests can import the functions
// above without a command line running.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await cli();
}

async function cli() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string', default: 'private-free' },
      json: { type: 'boolean', default: false },
    },
  });

  const planKey = /** @type {string} */ (values.plan);
  const plan = PLANS[planKey];
  if (!plan) {
    console.error(`Unknown --plan "${planKey}". Known plans: ${Object.keys(PLANS).join(', ')}.`);
    process.exit(2);
  }

  const rows = await estimateWorkflows();
  const total = rows.reduce((sum, row) => sum + row.minutes, 0);
  const gatedRuns = rows.filter((row) => row.gated).reduce((sum, row) => sum + row.runs, 0);

  if (values.json) {
    console.log(JSON.stringify({ plan: planKey, budget: plan.budget, total, rows }, null, 2));
  } else {
    console.log(`Scheduled Actions cost — ${plan.label}\n`);
    const width = Math.max(...rows.map((row) => row.file.length), 8);
    console.log(
      `${'WORKFLOW'.padEnd(width)}  ${'RUNS/MO'.padStart(8)}  ${'MIN/MO'.padStart(7)}  SCHEDULE`
    );
    for (const row of rows) {
      console.log(
        `${row.file.padEnd(width)}  ${String(row.runs).padStart(8)}  ${String(row.minutes).padStart(7)}  ` +
          `${row.crons.join(', ')}${row.gated ? '  (gated off — costs nothing until enabled)' : ''}`
      );
    }
    console.log(
      `\n${'TOTAL'.padEnd(width)}  ${''.padStart(8)}  ${String(total).padStart(7)}  ` +
        `of ${plan.budget === Infinity ? 'unlimited' : `${plan.budget} minutes/month`}`
    );
    if (gatedRuns > 0) {
      console.log(
        `\nEnabling every gated schedule would add ~${gatedRuns} minutes/month, for ~${total + gatedRuns} total.`
      );
    }
  }

  if (total > plan.budget) {
    console.error(
      `\nOver budget: ~${total} minutes/month against ${plan.budget} for a ${plan.label}.\n` +
        'Reduce a cron frequency, gate a workflow behind a repository variable, or make the repository public.'
    );
    process.exit(1);
  }
}
