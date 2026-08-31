/**
 * Error types for Pulse.
 *
 * The distinction that matters at runtime: a `ConfigError` means *you* have to
 * fix something and no amount of retrying will help, so the runner stops before
 * sending any request. A `CheckFailure` means a target looks unhealthy right
 * now, which is retryable and must never stop the other targets from running.
 */

/** Base class so `instanceof PulseError` catches everything we throw on purpose. */
export class PulseError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown, hint?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    /** @type {string | undefined} Actionable next step, printed under the message. */
    this.hint = options.hint;
  }
}

/**
 * The configuration is wrong. Never retried, never partially tolerated: if the
 * config is broken we cannot know what we were supposed to be monitoring.
 */
export class ConfigError extends PulseError {
  /**
   * @param {string} message
   * @param {{ problems?: string[], hint?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options);
    /** @type {string[]} One line per individual problem, already human-readable. */
    this.problems = options.problems ?? [];
  }

  /** @returns {string} The full multi-line report meant for a terminal. */
  format() {
    const lines = [this.message];
    for (const problem of this.problems) lines.push(`  - ${problem}`);
    if (this.hint) lines.push('', this.hint);
    return lines.join('\n');
  }
}

/** A `${SECRET}` reference in the config had no matching environment variable. */
export class MissingSecretError extends ConfigError {}

/**
 * A target is unhealthy. Carries an optional HTTP status so the report and the
 * history can show it without the check having to invent a shape.
 */
export class CheckFailure extends PulseError {
  /**
   * @param {string} message
   * @param {{ statusCode?: number, cause?: unknown, hint?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message, options);
    /** @type {number | undefined} */
    this.statusCode = options.statusCode;
  }
}

/**
 * Trim an error down to something worth putting in a JSON history file that is
 * committed to a public branch once a day, forever.
 *
 * @param {unknown} error
 * @param {number} [maxLength]
 * @returns {string}
 */
export function trimErrorMessage(error, maxLength = 240) {
  let message;
  if (error instanceof Error) {
    message = error.message || error.name;
    // fetch() hides the interesting part (ENOTFOUND, ECONNREFUSED, cert errors)
    // one level down in `cause`. Surfacing it is the difference between
    // "fetch failed" and "getaddrinfo ENOTFOUND api.example.com".
    const cause = /** @type {{ message?: string, code?: string } | undefined} */ (
      /** @type {{ cause?: unknown }} */ (error).cause
    );
    if (cause && (cause.message || cause.code)) {
      const detail = cause.code
        ? `${cause.code}${cause.message ? `: ${cause.message}` : ''}`
        : cause.message;
      if (detail && !message.includes(detail)) message = `${message} (${detail})`;
    }
  } else {
    message = String(error);
  }
  message = message.replace(/\s+/g, ' ').trim();
  return message.length > maxLength ? `${message.slice(0, maxLength - 1)}…` : message;
}
