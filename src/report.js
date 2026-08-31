/**
 * Reporting: the console table you read at 11pm, and the Markdown summary that
 * ends up on the workflow run page so you never have to open the raw log.
 */

import { appendFile } from 'node:fs/promises';

/**
 * @param {import('./types.js').RunResult[]} results
 * @returns {{ total: number, ok: number, failed: number, slowestMs: number }}
 */
export function summarise(results) {
  const ok = results.filter((result) => result.ok).length;
  return {
    total: results.length,
    ok,
    failed: results.length - ok,
    slowestMs: results.reduce((max, result) => Math.max(max, result.durationMs), 0),
  };
}

/**
 * @param {import('./types.js').RunResult[]} results
 * @param {{ colour?: boolean }} [options]
 * @returns {string}
 */
export function renderTable(results, options = {}) {
  const colour = options.colour ?? Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
  const rows = results.map((result) => [
    result.ok ? 'UP' : 'DOWN',
    result.id,
    result.tier,
    `${result.durationMs} ms`,
    String(result.attempts),
    result.ok ? (result.detail ?? '') : (result.error ?? 'failed'),
  ]);

  const header = ['STATUS', 'TARGET', 'TIER', 'TIME', 'TRIES', 'DETAIL'];
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => row[column].length))
  );
  // The detail column runs to the end of the line; padding it just adds noise.
  widths[widths.length - 1] = 0;

  const line = (/** @type {string[]} */ cells) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]))
      .join('  ')
      .trimEnd();

  const out = [line(header), line(widths.map((width) => '-'.repeat(Math.max(width, 3))))];
  for (const [index, row] of rows.entries()) {
    const rendered = line(row);
    out.push(colour ? paint(rendered, results[index].ok) : rendered);
  }
  return out.join('\n');
}

/**
 * @param {import('./types.js').RunResult[]} results
 * @param {{ tier?: string, startedAt: Date, durationMs: number, dryRun?: boolean }} meta
 * @returns {string}
 */
export function renderMarkdown(results, meta) {
  const { total, ok, failed } = summarise(results);
  const scope = meta.tier ? `\`${meta.tier}\` tier` : 'all tiers';
  const lines = [
    `## Pulse — ${failed === 0 ? 'all healthy' : `${failed} failing`}`,
    '',
    `**${ok}/${total} up** · ${scope} · started ${meta.startedAt.toISOString()} · took ${(
      meta.durationMs / 1000
    ).toFixed(1)}s${meta.dryRun ? ' · **dry run, nothing was requested**' : ''}`,
    '',
    '| | Target | Tier | Status | Time | Tries | Detail |',
    '| --- | --- | --- | --- | ---: | ---: | --- |',
  ];

  for (const result of results) {
    const cells = [
      result.ok ? '🟢' : '🔴',
      result.publicUrl ? `[${result.name}](${result.publicUrl})` : result.name,
      result.tier,
      result.ok ? 'up' : 'down',
      `${result.durationMs} ms`,
      String(result.attempts),
      escapePipes(result.ok ? (result.detail ?? '') : (result.error ?? 'failed')),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }

  if (failed > 0) {
    lines.push(
      '',
      '### Failing targets',
      '',
      ...results
        .filter((result) => !result.ok)
        .flatMap((result) => [
          `**${result.name}** (\`${result.id}\`, ${result.attempts} attempt${result.attempts === 1 ? '' : 's'})`,
          '',
          '```',
          result.error ?? 'failed',
          ...(result.detail ? [result.detail] : []),
          '```',
          '',
        ])
    );
  }

  return lines.join('\n');
}

/**
 * Append to the GitHub step summary, when running inside Actions.
 *
 * @param {string} markdown
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<boolean>} Whether anything was written.
 */
export async function writeStepSummary(markdown, env = process.env) {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return false;
  await appendFile(path, `${markdown}\n`, 'utf8');
  return true;
}

/**
 * @param {string} text
 * @param {boolean} ok
 * @returns {string}
 */
function paint(text, ok) {
  return `\u001b[${ok ? 32 : 31}m${text}\u001b[0m`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapePipes(text) {
  return text.replace(/\|/g, '\\|');
}
