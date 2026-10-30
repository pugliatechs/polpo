/**
 * The steering record: every intervention in a campaign, in order.
 *
 * One JSON object per line in ledger.jsonl (mode 0600). Each entry
 * carries `prev`, the sha256 of the line before it, so a removed or
 * edited entry breaks the chain where it happened. Text goes through the
 * same secret filter as the gateway before it is written.
 *
 * See docs/campaigns.md, section 4.6.
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { redactDeep } = require('../server/redact');

// A field longer than this is cut: the ledger records decisions, not logs.
const MAX_FIELD_CHARS = 8000;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function capStrings(value, depth) {
  const d = depth || 0;
  if (typeof value === 'string') {
    return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) + ' ...(cut)' : value;
  }
  if (d > 10 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => capStrings(v, d + 1));
  const out = {};
  for (const k of Object.keys(value)) out[k] = capStrings(value[k], d + 1);
  return out;
}

/**
 * Read a ledger file and check its chain.
 *
 * @returns {{entries: object[], ok: boolean, brokenAt: ?number, lastHash: ?string, lastSeq: number}}
 *   `brokenAt` is the seq (or line number for an unparseable line) where
 *   the chain first fails to match.
 */
function readLedger(filePath) {
  let text = '';
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { /* none yet */ }
  const lines = text.split('\n').filter((l) => l.length > 0);
  const entries = [];
  let prev = null;
  let brokenAt = null;
  let lastSeq = 0;
  lines.forEach((line, i) => {
    let e;
    try { e = JSON.parse(line); } catch {
      if (brokenAt === null) brokenAt = i + 1;
      prev = sha256(line);
      return;
    }
    if (brokenAt === null && ((e.prev || null) !== prev || e.seq !== lastSeq + 1)) {
      brokenAt = typeof e.seq === 'number' ? e.seq : i + 1;
    }
    if (typeof e.seq === 'number') lastSeq = e.seq;
    entries.push(e);
    prev = sha256(line);
  });
  return { entries, ok: brokenAt === null, brokenAt, lastHash: prev, lastSeq };
}

class Ledger {
  /**
   * @param {string} filePath
   * @param {object} [opts] - { now: () => Date }
   */
  constructor(filePath, opts) {
    this.path = filePath;
    this._now = (opts && opts.now) || (() => new Date());
    const r = readLedger(filePath);
    this.lastSeq = r.lastSeq;
    this.lastHash = r.lastHash;
    this.ok = r.ok;
    this.brokenAt = r.brokenAt;
  }

  /**
   * Append an entry.
   * @param {string} kind
   * @param {string} channel - desk, dashboard, gateway:<client>, polpo, cli
   * @param {object} [fields]
   * @returns {object} the entry as written
   */
  append(kind, channel, fields) {
    const clean = capStrings(redactDeep(fields || {}));
    // These keys are the ledger's own; a field cannot overwrite them.
    for (const k of ['seq', 'at', 'kind', 'channel', 'prev']) delete clean[k];
    const entry = Object.assign(
      { seq: this.lastSeq + 1, at: this._now().toISOString(), kind, channel },
      clean,
      { prev: this.lastHash || null },
    );
    const line = JSON.stringify(entry);
    fs.appendFileSync(this.path, line + '\n', { mode: 0o600 });
    this.lastSeq = entry.seq;
    this.lastHash = sha256(line);
    return entry;
  }

  /** Entries after `since`, at most `limit`. */
  since(since, limit) {
    const all = readLedger(this.path).entries;
    const newer = all.filter((e) => typeof e.seq === 'number' && e.seq > (since || 0));
    const max = limit || 200;
    return { entries: newer.slice(0, max), hasMore: newer.length > max, lastSeq: this.lastSeq };
  }

  all() {
    return readLedger(this.path).entries;
  }

  verify() {
    return readLedger(this.path);
  }
}

module.exports = { Ledger, readLedger };
