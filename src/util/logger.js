/**
 * Shared structured logger.
 *
 * Every polpo log line MUST carry a timestamp so operators can
 * correlate events across processes (server, wrapped agents, gateway
 * spawns, mind arms). The agent processes have always had this via
 * `logPrefix(tag)`; this module is the equivalent for the rest of the
 * codebase, so the server-side `[component]` prefixes get the same
 * `[<tag> YYYY-MM-DD HH:MM:SS.ffffff]` treatment.
 *
 * Why a factory and not free functions:
 *   - Pinning a tag at construction time avoids repeating it at every
 *     call site, which is where the discipline tends to drift.
 *   - One logger per module makes it cheap to bump verbosity for a
 *     single subsystem during debugging without grepping the codebase.
 *
 * Output stream choice:
 *   - info  -> stdout (operator-visible, expected events)
 *   - warn  -> stderr (recoverable issues)
 *   - error -> stderr (failures, must investigate)
 * This matches Node's defaults for console.log/warn/error so existing
 * shell redirection (2>err.log) keeps working unchanged.
 */

'use strict';

const { logPrefix } = require('../agent/log-prefix');

/**
 * Build a logger pinned to a tag (e.g. 'gateway', 'mind', 'api').
 *
 * @param {string} tag - short identifier shown inside [tag ...] prefix
 * @returns {{ info: Function, warn: Function, error: Function }}
 */
function makeLogger(tag) {
  if (!tag || typeof tag !== 'string') {
    throw new TypeError('makeLogger(tag) requires a non-empty string');
  }
  const safe = tag.replace(/\s+/g, '-');
  return {
    info(msg, ...args) {
      console.log(`${logPrefix(safe)} ${msg}`, ...args);
    },
    warn(msg, ...args) {
      console.warn(`${logPrefix(safe)} ${msg}`, ...args);
    },
    error(msg, ...args) {
      console.error(`${logPrefix(safe)} ${msg}`, ...args);
    },
  };
}

module.exports = { makeLogger };
