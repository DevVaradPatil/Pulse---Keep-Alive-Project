/**
 * Shared type definitions.
 *
 * JSDoc rather than TypeScript on purpose: every workflow runs `node src/run.js`
 * against the source with zero dependencies and no build step, which is the
 * property that keeps this project free and unbreakable. `jsconfig.json` turns
 * on `checkJs`, and `npm run typecheck` enforces these types in CI.
 *
 * @module types
 */

/**
 * @typedef {'daily' | 'frequent'} Tier
 */

/**
 * A single entry from `config/targets.json`, after schema validation, secret
 * interpolation and defaults merging.
 *
 * @typedef {object} Target
 * @property {string} id
 * @property {string} name
 * @property {string} type
 * @property {Tier} tier
 * @property {boolean} enabled
 * @property {number} timeoutMs
 * @property {number} retries
 * @property {string} [platform]
 * @property {string} [publicUrl]
 * @property {string} [notes]
 * @property {string[]} [requiredSecrets]
 * @property {string} [url]
 * @property {string} [method]
 * @property {Record<string, string>} [headers]
 * @property {string | Record<string, unknown> | null} [body]
 * @property {number | number[]} [expectStatus]
 * @property {string} [expectBodyContains]
 * @property {string} [supabaseUrl]
 * @property {string} [apiKey]
 * @property {string} [table]
 * @property {string} [column]
 * @property {string} [connectionString]
 * @property {string} [dbName]
 */

/**
 * Runner-wide settings, merged from `defaults` in the config file.
 *
 * @typedef {object} RunDefaults
 * @property {number} timeoutMs
 * @property {number} retries
 * @property {number | number[]} expectStatus
 * @property {number} concurrency
 * @property {number} jitterMs
 * @property {number} backoffBaseMs
 * @property {number} backoffMaxMs
 */

/**
 * Everything a check is allowed to reach for. Passed in rather than imported so
 * tests can supply a fake `fetch` and no test ever touches the network.
 *
 * @typedef {object} CheckContext
 * @property {AbortSignal} signal Aborted when the per-attempt timeout expires.
 * @property {typeof globalThis.fetch} fetch
 * @property {string} userAgent
 * @property {number} timeoutMs
 */

/**
 * What a successful check reports back.
 *
 * @typedef {object} CheckOutcome
 * @property {number} [statusCode] HTTP status, when the protocol has one.
 * @property {string} detail One short line for the console table and history.
 */

/**
 * The contract every file in `src/checks/` implements. Adding a check type is
 * exactly: one new file exporting this shape, one entry in the registry in
 * `src/checks/index.js`, and one value in the schema's `type` enum.
 *
 * @typedef {object} Check
 * @property {string} type Matches the `type` value in the config.
 * @property {readonly string[]} fields Config fields this check owns. Validation rejects them on other types.
 * @property {(target: Target) => string} describe One-line summary for dry runs and logs.
 * @property {(target: Target, ctx: CheckContext) => Promise<CheckOutcome>} run Resolves when healthy, throws `CheckFailure` when not.
 */

/**
 * The outcome of checking one target, including retries.
 *
 * @typedef {object} RunResult
 * @property {string} id
 * @property {string} name
 * @property {string} type
 * @property {Tier} tier
 * @property {string} [platform]
 * @property {string} [publicUrl]
 * @property {string} [notes]
 * @property {boolean} ok
 * @property {number} durationMs Total wall time including retries and backoff.
 * @property {number} attempts
 * @property {number} [statusCode]
 * @property {string} [detail]
 * @property {string} [error] Trimmed failure message.
 * @property {string} checkedAt ISO 8601, UTC.
 */

export {};
