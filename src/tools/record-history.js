#!/usr/bin/env node
/**
 * Append one run to the history file, then prune it.
 *
 * Split out of `run.js` on purpose: the history lives on a separate `status`
 * branch which the workflow checks out into its own directory, and the append
 * has to happen whether the checks passed or failed. Keeping it a separate step
 * means a failing check still records that it failed.
 *
 *   node src/tools/record-history.js --run .pulse/run.json --history status-data/status/history.json
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  appendRun,
  loadHistory,
  pruneHistory,
  saveHistory,
  DETAIL_RETENTION_DAYS,
} from '../history.js';
import { ConfigError } from '../lib/errors.js';

const { values } = parseArgs({
  options: {
    run: { type: 'string' },
    history: { type: 'string' },
    'retention-days': { type: 'string' },
  },
});

if (!values.run || !values.history) {
  console.error(
    'Usage: node src/tools/record-history.js --run <results.json> --history <history.json>'
  );
  process.exit(2);
}

const runPath = /** @type {string} */ (values.run);
const historyPath = /** @type {string} */ (values.history);
const retentionDays = values['retention-days']
  ? Number(values['retention-days'])
  : DETAIL_RETENTION_DAYS;

try {
  const payload = JSON.parse(await readFile(runPath, 'utf8'));
  const results = /** @type {import('../types.js').RunResult[]} */ (payload.results ?? []);

  if (results.length === 0) {
    console.log(`${runPath} contains no results; leaving ${historyPath} untouched.`);
    process.exit(0);
  }

  const before = await loadHistory(historyPath);
  const after = pruneHistory(appendRun(before, results), { retentionDays });
  await saveHistory(historyPath, after);

  const runCount = Object.values(after.targets).reduce(
    (sum, target) => sum + target.runs.length,
    0
  );
  const monthCount = Object.values(after.targets).reduce(
    (sum, target) => sum + target.months.length,
    0
  );
  console.log(
    `Recorded ${results.length} result(s) in ${historyPath}: ` +
      `${Object.keys(after.targets).length} target(s), ${runCount} detailed run(s) within ${retentionDays} days, ` +
      `${monthCount} monthly aggregate(s).`
  );
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.format());
    process.exit(1);
  }
  console.error(
    `Could not record history: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}
