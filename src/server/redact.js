/**
 * Best-effort removal of secrets from text the gateway hands to an
 * external caller.
 *
 * Coding sessions are full of credentials: an agent pastes an API key
 * into a command, prints an env file, reads a config. Shown on your own
 * dashboard that is your business; returned over the gateway it reaches
 * whatever the caller forwards it to (a chat app, a model provider).
 *
 * This catches the common shapes: private key blocks, tokens with a
 * well-known prefix, JWTs, Authorization headers, `name=value` where the
 * name says it is a secret, and long random-looking strings. It is a
 * filter, not a guarantee: a short password in plain prose gets through.
 *
 * On by default; POLPO_GATEWAY_REDACT=0 turns it off.
 */

'use strict';

const MARK = '[redacted]';

// Whole matches replaced by MARK.
const WHOLE = [
  // PEM private keys, including an unterminated block at the end.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  // Tokens with a well-known prefix.
  /(?<![A-Za-z0-9_-])(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|hf_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,})/g,
  // JSON Web Tokens.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

// "Authorization: Bearer <token>" and friends: keep the scheme.
const AUTH_HEADER = /\b(Bearer|Basic|Token)(\s+)([A-Za-z0-9._~+/=-]{16,})/g;

// name=value, name: value, "name": "value", where the name says secret.
const NAMED = /\b([A-Za-z0-9_.-]{0,40}(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|credential)[A-Za-z0-9_.-]{0,40})(["']?\s*[:=]\s*["']?)([^\s"'`,;(){}<>]{8,})/gi;

// A long run of token characters.
const LONG_RUN = /(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=-])/g;

function count(s, re) {
  const m = s.match(re);
  return m ? m.length : 0;
}

/**
 * Random-looking: at least three each of digits, upper and lower case
 * letters. Hex digests, UUIDs, paths and identifiers fail it; base64 and
 * most generated keys pass.
 */
function looksRandom(s) {
  return count(s, /[0-9]/g) >= 3 && count(s, /[A-Z]/g) >= 3 && count(s, /[a-z]/g) >= 3;
}

/** A value that names something rather than being one ($VAR, <key>, a call). */
function isReference(v) {
  return /^[$<{%]/.test(v) || !/[0-9]/.test(v) || !/[A-Za-z]/.test(v);
}

function enabled() {
  return process.env.POLPO_GATEWAY_REDACT !== '0';
}

/**
 * @param {string} text
 * @returns {{text: string, redacted: boolean}}
 */
function redactSecrets(text) {
  if (typeof text !== 'string' || !text || !enabled()) return { text, redacted: false };
  let out = text;
  for (const re of WHOLE) out = out.replace(re, MARK);
  out = out.replace(AUTH_HEADER, (m, scheme, sp, token) => (isReference(token) ? m : scheme + sp + MARK));
  out = out.replace(NAMED, (m, name, sep, value) => (isReference(value) ? m : name + sep + MARK));
  out = out.replace(LONG_RUN, (m) => (looksRandom(m) ? MARK : m));
  return { text: out, redacted: out !== text };
}

/** redactSecrets for when only the text is wanted. */
function redact(text) {
  return redactSecrets(text).text;
}

/**
 * Redact every string inside a JSON-like value (message content blocks).
 * Returns a copy; the input is not modified.
 */
function redactDeep(value, depth) {
  const d = depth || 0;
  if (typeof value === 'string') return redact(value);
  if (d > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, d + 1));
  const out = {};
  for (const k of Object.keys(value)) out[k] = redactDeep(value[k], d + 1);
  return out;
}

module.exports = { redactSecrets, redact, redactDeep, MARK };
