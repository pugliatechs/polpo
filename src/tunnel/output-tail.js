/**
 * Keep the end of a tunnel process's output, and pull the line that says
 * why it failed.
 *
 * A tunnel binary that dies during startup explains itself on stderr,
 * but the error polpo reported used to be just "cloudflared exited with
 * code 1". With a VPN intercepting the connection, cloudflared had
 * printed
 *
 *   failed to request quick Tunnel: Post "https://api.trycloudflare.com/
 *   tunnel": context deadline exceeded
 *
 * which names the problem outright, and polpo discarded it. The ssh
 * provider already appended its last stderr line; this is that idea
 * shared by every provider, with a bounded buffer (ssh's grew for as
 * long as the tunnel stayed up) and a preference for the line that
 * actually reports the error rather than whatever came last.
 */

'use strict';

const DEFAULT_MAX_CHARS = 4096;
const MAX_HINT_CHARS = 300;

// Lines that report a failure, as opposed to progress chatter.
const FAILURE_LINE = /\b(ERR|ERROR|FATAL|failed|failure|error|denied|refused|unauthori[sz]ed|forbidden|timed? ?out|deadline exceeded|unreachable|not found|no such)\b/i;

// Leading timestamp some tools print, e.g. cloudflared's
// "2026-09-24T13:14:11Z ".
const LEADING_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s+/;

/**
 * Make one line safe and short enough for a console message: no ANSI
 * escapes or control characters, no leading timestamp, capped length.
 */
function cleanLine(line) {
  return String(line)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(LEADING_TIMESTAMP, '')
    .trim()
    .slice(0, MAX_HINT_CHARS);
}

/**
 * Render a JSON log line (ngrok logs this way) as "msg: err", or return
 * null if the line is not a JSON object.
 */
function fromJsonLine(line) {
  if (line[0] !== '{') return null;
  try {
    const o = JSON.parse(line);
    if (!o || typeof o !== 'object') return null;
    const parts = [o.msg, o.err].filter((v) => typeof v === 'string' && v);
    return parts.length ? parts.join(': ') : null;
  } catch {
    return null;
  }
}

/**
 * The most useful single line from a chunk of tool output: the last line
 * that reports a failure, else simply the last line.
 *
 * @param {string} text
 * @returns {string} '' when there is nothing to report
 */
function failureLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => fromJsonLine(l) || l)
    .map(cleanLine)
    .filter(Boolean);
  if (lines.length === 0) return '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FAILURE_LINE.test(lines[i])) return lines[i];
  }
  return lines[lines.length - 1];
}

/**
 * A bounded tail of a process's output.
 *
 * @param {number} [maxChars]
 * @returns {{push: function((Buffer|string)): void, hint: function(): string}}
 *   hint() returns ': <line>' ready to append to an error message, or ''.
 */
function createOutputTail(maxChars) {
  const limit = maxChars || DEFAULT_MAX_CHARS;
  let buf = '';
  return {
    push(chunk) {
      buf = (buf + String(chunk)).slice(-limit);
    },
    hint() {
      const line = failureLine(buf);
      return line ? ': ' + line : '';
    },
  };
}

module.exports = { createOutputTail, failureLine, cleanLine };
