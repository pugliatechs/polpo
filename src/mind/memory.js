/**
 * Memory — long-term goal history for the Alien Mind.
 *
 * Stores completed goals as JSONL entries at ~/.config/polpo/mind-memory.jsonl.
 * Keyword-based retrieval surfaces relevant past goals when planning new ones.
 *
 * Non-goals for this phase:
 *  - Embeddings/vector search (keyword overlap is good enough at single-user scale)
 *  - Fact extraction (mind distilling reusable facts from conversations)
 *  - Automatic pruning (user deletes the file if it grows too large)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { makeLogger } = require('../util/logger');

const log = makeLogger('mind-memory');

var DEFAULT_MEMORY_PATH = path.join(os.homedir(), '.config', 'polpo', 'mind-memory.jsonl');
var MAX_SUMMARY_LENGTH = 500;
var MAX_ENTRY_BYTES = 10 * 1024; // Cap each JSON line at 10KB so corruption stays bounded
var MAX_RETURN = 50; // Hard ceiling on how many entries any search returns

// Common English stopwords filtered from keyword tokens
var STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were',
  'will', 'with', 'i', 'we', 'you', 'they', 'this', 'these', 'those', 'there',
  'if', 'but', 'or', 'not', 'do', 'does', 'did', 'can', 'could', 'should',
  'would', 'have', 'had', 'been', 'being', 'about', 'all', 'any', 'into',
  'our', 'your', 'my', 'their', 'so', 'than', 'then', 'what', 'when', 'where',
  'how', 'who', 'which', 'why', 'just', 'some', 'me', 'us', 'him', 'her',
]);

/**
 * Tokenize a string into lowercase keyword tokens (strip punctuation,
 * drop stopwords and 1-char tokens).
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenize(text) {
  var set = new Set();
  if (typeof text !== 'string' || !text) return set;
  var parts = text.toLowerCase().replace(/[^a-z0-9\s\-_]/g, ' ').split(/\s+/);
  for (var i = 0; i < parts.length; i++) {
    var tok = parts[i];
    if (tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    set.add(tok);
  }
  return set;
}

/**
 * Jaccard similarity between two token sets: |A∩B| / |A∪B|.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} value in [0, 1]
 */
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  var inter = 0;
  for (var tok of a) if (b.has(tok)) inter++;
  var union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

class Memory {
  /**
   * @param {object} [opts]
   * @param {string} [opts.path] - Path to the JSONL file (default: ~/.config/polpo/mind-memory.jsonl)
   */
  constructor(opts) {
    if (!opts) opts = {};
    this.filePath = opts.path || DEFAULT_MEMORY_PATH;
    this._entries = []; // In-memory cache, populated by load()
  }

  /**
   * Load all entries from disk. Safe to call repeatedly (replaces cache).
   * Ignores malformed lines individually so one bad entry doesn't block loading.
   */
  load() {
    this._entries = [];
    try {
      if (!fs.existsSync(this.filePath)) return;
      var raw = fs.readFileSync(this.filePath, 'utf8');
      var lines = raw.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        try {
          var entry = JSON.parse(line);
          if (this._isValidEntry(entry)) {
            this._entries.push(entry);
          }
        } catch {
          // Skip malformed line
        }
      }
    } catch {
      // Unreadable file — start fresh
      this._entries = [];
    }
  }

  _isValidEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.id !== 'string') return false;
    if (typeof entry.createdAt !== 'number') return false;
    if (entry.type !== 'goal' && entry.type !== 'fact') return false;
    return true;
  }

  /**
   * Append an entry to the store (and persist to disk).
   * @param {object} entry - Pre-filled with type-specific fields
   * @returns {object} The persisted entry (with id/createdAt populated if missing)
   */
  save(entry) {
    if (!entry || typeof entry !== 'object') throw new Error('Entry must be an object');
    var now = Date.now();
    var full = Object.assign({}, entry, {
      id: entry.id || 'mem-' + crypto.randomBytes(4).toString('hex'),
      createdAt: entry.createdAt || now,
      type: entry.type || 'goal',
    });

    // Truncate large string fields to keep entries bounded
    full = this._truncateEntry(full);

    var json = JSON.stringify(full);
    if (Buffer.byteLength(json, 'utf8') > MAX_ENTRY_BYTES) {
      // If still too large after truncation, drop optional fields
      if (full.taskSummaries) full.taskSummaries = full.taskSummaries.slice(0, 3);
      json = JSON.stringify(full);
    }

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, json + '\n', { mode: 0o600 });
    } catch (err) {
      // Non-fatal: keep in-memory cache updated even if disk write fails
      log.error('Failed to persist entry:', err.message);
    }

    this._entries.push(full);
    return full;
  }

  /**
   * Truncate long string fields on an entry to prevent unbounded growth.
   */
  _truncateEntry(entry) {
    var clone = Object.assign({}, entry);
    if (typeof clone.goalPrompt === 'string' && clone.goalPrompt.length > MAX_SUMMARY_LENGTH) {
      clone.goalPrompt = clone.goalPrompt.slice(0, MAX_SUMMARY_LENGTH) + '...';
    }
    if (Array.isArray(clone.taskSummaries)) {
      clone.taskSummaries = clone.taskSummaries.map(function (s) {
        if (typeof s !== 'string') return '';
        return s.length > MAX_SUMMARY_LENGTH ? s.slice(0, MAX_SUMMARY_LENGTH) + '...' : s;
      });
    }
    if (typeof clone.fact === 'string' && clone.fact.length > MAX_SUMMARY_LENGTH) {
      clone.fact = clone.fact.slice(0, MAX_SUMMARY_LENGTH) + '...';
    }
    return clone;
  }

  /**
   * Search entries by keyword overlap with the query. Returns top-K most
   * relevant entries with their similarity scores.
   *
   * @param {string} query
   * @param {number} [k=5] - Max number of results
   * @returns {Array<{ entry: object, score: number }>}
   */
  search(query, k) {
    if (!query || typeof query !== 'string') return [];
    var limit = Math.min(Math.max(1, k || 5), MAX_RETURN);

    var queryTokens = tokenize(query);
    if (queryTokens.size === 0) return [];

    var scored = [];
    for (var i = 0; i < this._entries.length; i++) {
      var entry = this._entries[i];
      var entryText = this._entryText(entry);
      var entryTokens = tokenize(entryText);
      var score = jaccard(queryTokens, entryTokens);
      if (score > 0) {
        scored.push({ entry: entry, score: score });
      }
    }

    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit);
  }

  /**
   * Return the text used for keyword matching on an entry.
   */
  _entryText(entry) {
    var parts = [];
    if (entry.goalPrompt) parts.push(entry.goalPrompt);
    if (Array.isArray(entry.taskSummaries)) parts.push(entry.taskSummaries.join(' '));
    if (entry.fact) parts.push(entry.fact);
    return parts.join(' ');
  }

  /**
   * Return the N most recent entries.
   * @param {number} [n=10]
   * @returns {Array<object>}
   */
  getRecent(n) {
    var limit = Math.min(Math.max(1, n || 10), MAX_RETURN);
    return this._entries.slice(-limit).reverse();
  }

  /**
   * Get the total number of entries in the store.
   */
  size() {
    return this._entries.length;
  }

  /**
   * Format an array of search results as a human-readable text block for
   * injection into the reasoner's prompt.
   */
  formatForContext(results) {
    if (!results || results.length === 0) return '';
    var lines = ['Relevant past work (from memory):'];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var e = r.entry;
      if (e.type === 'goal') {
        var outcome = e.outcome || 'unknown';
        var dateStr = e.createdAt ? new Date(e.createdAt).toISOString().slice(0, 10) : '';
        lines.push('');
        lines.push('- [' + outcome + ', ' + dateStr + '] ' + (e.goalPrompt || ''));
        if (Array.isArray(e.taskSummaries) && e.taskSummaries.length > 0) {
          for (var j = 0; j < Math.min(e.taskSummaries.length, 3); j++) {
            lines.push('  * ' + e.taskSummaries[j]);
          }
        }
      } else if (e.type === 'fact' && e.fact) {
        lines.push('- ' + e.fact);
      }
    }
    return lines.join('\n');
  }
}

module.exports = { Memory, tokenize, jaccard };
