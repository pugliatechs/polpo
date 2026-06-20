/**
 * Conversation search core — shared engine behind /api/search (dashboard)
 * and /v1/search, /v1/sessions/search, /v1/sessions, /v1/sessions/:id
 * (gateway).
 *
 * Three orthogonal capabilities, kept as pure functions so they're easy
 * to compose and to test without spinning up HTTP:
 *
 *   searchOnDisk(query, opts)         scan past sessions persisted by the
 *                                     supported agent CLIs and return
 *                                     per-message hits
 *
 *   searchInMemory(query, im, opts)   walk every live InstanceManager
 *                                     conversation and return per-message
 *                                     hits in the same shape
 *
 *   groupBySession(hits, opts)        aggregate hits per session, compute
 *                                     matchCount + recency-weighted score
 *                                     and return ranked sessions for routing
 *
 * Security defences baked in:
 *   - query is bounded (length, charset is not restricted — we lowercase
 *     and do indexOf, so injection surface is nil)
 *   - all file IO goes through realpathSync + prefix check, exactly like
 *     /api/search did before this refactor
 *   - in-memory walk uses InstanceManager.getConversation(id, limit) so
 *     callers can't request unbounded history slices
 *   - sessionId values that don't match SAFE_SESSION_ID_REGEX are rejected
 *     before any fs touch (extracted to be reusable by the gateway router)
 *   - snippet windows are fixed-size (80 + 80 chars around the match)
 *   - per-result objects only include whitelisted fields; nothing else
 *     from the source JSON leaks out
 *   - no caller content is logged anywhere in this module
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const { normalizeTimestamp } = require('./normalize-timestamp');

// ---- Defaults / bounds (whitelist style — every consumer clamps to these) ----

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_DEADLINE_MS = 10_000;
const SNIPPET_WINDOW = 80;
const MAX_IN_MEMORY_HISTORY = 500;

// Session id whitelist. Permissive enough to cover Claude UUIDs, Codex
// rollout IDs, Gemini filename-derived ids; restrictive enough to reject
// `..`, slashes, NUL, and any other path-traversal vector.
const SAFE_SESSION_ID_REGEX = /^[A-Za-z0-9._-]{1,200}$/;

// Roots of supported agent session stores. We resolve and prefix-check
// every file path against these before reading.
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS  = path.join(os.homedir(), '.codex', 'sessions');
const GEMINI_TMP      = path.join(os.homedir(), '.gemini', 'tmp');
const PI_SESSIONS     = path.join(os.homedir(), '.pi', 'agent', 'sessions');

// ---- Content extractors (lifted from api.js verbatim) ----

function extractGeminiText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join(' ') || null;
  }
  return null;
}

function extractClaudeContent(obj) {
  const msg = obj && obj.message;
  if (!msg || !msg.content) return null;
  if (typeof msg.content === 'string') {
    return { content: msg.content, role: obj.type || 'unknown' };
  }
  if (Array.isArray(msg.content)) {
    const text = msg.content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join(' ');
    return text ? { content: text, role: obj.type || 'unknown' } : null;
  }
  return null;
}

function extractCodexContent(obj) {
  const payload = (obj && obj.payload) || {};
  if (obj && obj.type === 'event_msg' && payload.type === 'user_message' && payload.message) {
    return { content: payload.message, role: 'user' };
  }
  if (obj && obj.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    const blocks = payload.content;
    if (Array.isArray(blocks)) {
      const text = blocks.filter(b => b && b.type === 'output_text' && b.text).map(b => b.text).join(' ');
      if (text) return { content: text, role: 'assistant' };
    }
  }
  return null;
}

function extractPiContent(obj) {
  if (!obj || obj.type !== 'message') return null;
  const content = obj.content;
  if (typeof content === 'string') {
    return { content, role: obj.role || 'unknown' };
  }
  if (Array.isArray(content)) {
    const text = content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join(' ');
    return text ? { content: text, role: obj.role || 'unknown' } : null;
  }
  return null;
}

// Live in-memory messages use the InstanceManager envelope: { role, content, timestamp, ... }
// content may be a string OR an array of content blocks (when assistant emitted a structured turn).
function extractLiveContent(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (typeof msg.content === 'string') {
    return { content: msg.content, role: msg.role || 'unknown' };
  }
  if (Array.isArray(msg.content)) {
    const text = msg.content
      .filter(b => b && (b.type === 'text' || b.type === 'output_text') && b.text)
      .map(b => b.text)
      .join(' ');
    return text ? { content: text, role: msg.role || 'unknown' } : null;
  }
  return null;
}

// ---- Snippet construction ----

function buildSnippet(content, idx, queryLen) {
  const start = Math.max(0, idx - SNIPPET_WINDOW);
  const end = Math.min(content.length, idx + queryLen + SNIPPET_WINDOW);
  const snippet =
    (start > 0 ? '...' : '') +
    content.slice(start, end) +
    (end < content.length ? '...' : '');
  return {
    snippet,
    matchIndex: idx - start + (start > 0 ? 3 : 0),
    matchLength: queryLen,
  };
}

// ---- Input normalisation ----

/**
 * Coerce the query string into a safe lowercase form, or null if it
 * fails the bounds check. Returning null lets callers map this to a
 * clean 400 without throwing.
 */
function prepareQuery(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return null;
  if (trimmed.length > MAX_QUERY_LENGTH) return null;
  return trimmed.toLowerCase();
}

function clampLimit(raw, max) {
  const cap = Number.isFinite(max) && max > 0 ? max : MAX_LIMIT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, cap);
}

function isValidSessionId(id) {
  return typeof id === 'string' && SAFE_SESSION_ID_REGEX.test(id);
}

// ---- File walk helpers (mirrors api.js behaviour) ----

async function findSessionFiles(dir, ext, skipDirs) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    if (skipDirs && skipDirs.includes(entry.name)) continue;
    if (entry.isSymbolicLink()) continue; // never follow symlinks
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await findSessionFiles(full, ext, skipDirs)));
    } else if (entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

function searchJsonlFile(filePath, query, maxResults, deadline, extractContent) {
  return new Promise((resolve) => {
    const results = [];
    const sessionId = path.basename(filePath, '.jsonl');
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (results.length >= maxResults || Date.now() > deadline) {
        rl.close();
        stream.destroy();
        return;
      }
      if (!line || !line.trim()) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      const extracted = extractContent(obj);
      if (!extracted) return;
      const idx = extracted.content.toLowerCase().indexOf(query);
      if (idx === -1) return;
      const snip = buildSnippet(extracted.content, idx, query.length);
      results.push({
        sessionId,
        role: extracted.role,
        snippet: snip.snippet,
        matchIndex: snip.matchIndex,
        matchLength: snip.matchLength,
        timestamp: obj.timestamp || null,
        source: 'disk',
      });
    });
    rl.on('close', () => resolve(results));
    rl.on('error', () => resolve(results));
  });
}

function searchGeminiFile(filePath, query, maxResults) {
  const results = [];
  let data;
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return results; }
  const sessionId = (data && data.sessionId) || path.basename(filePath, '.json');
  const messages = (data && data.messages) || [];
  for (const msg of messages) {
    if (results.length >= maxResults) break;
    const text = extractGeminiText(msg && msg.content);
    if (!text) continue;
    const idx = text.toLowerCase().indexOf(query);
    if (idx === -1) continue;
    const snip = buildSnippet(text, idx, query.length);
    results.push({
      sessionId,
      role: msg.type === 'user' ? 'user' : 'assistant',
      snippet: snip.snippet,
      matchIndex: snip.matchIndex,
      matchLength: snip.matchLength,
      timestamp: (msg && msg.timestamp) || null,
      source: 'disk',
    });
  }
  return results;
}

// ---- Public: searchOnDisk ----

/**
 * Walk past-session files for matches.
 *
 * @param {string} query  raw query (will be prepared and lowercased)
 * @param {object} [opts]
 * @param {number} [opts.limit] candidate pool cap (default 60, max 300)
 * @param {number} [opts.deadlineMs] (default 10 000)
 * @returns {Promise<{ results: Array, partial: boolean }>}
 */
async function searchOnDisk(query, opts) {
  const lower = prepareQuery(query);
  if (!lower) return { results: [], partial: false };
  const limit = clampLimit(opts && opts.limit, 300);
  const deadline = Date.now() + ((opts && opts.deadlineMs) || DEFAULT_DEADLINE_MS);

  const sources = [
    { dir: CLAUDE_PROJECTS, ext: '.jsonl', agent: 'claude', skip: ['subagents'] },
    { dir: CODEX_SESSIONS,  ext: '.jsonl', agent: 'codex' },
    { dir: GEMINI_TMP,      ext: '.json',  agent: 'gemini' },
    { dir: PI_SESSIONS,     ext: '.jsonl', agent: 'pi' },
  ];

  const files = [];
  for (const src of sources) {
    let realBase;
    try { realBase = fs.realpathSync(src.dir); } catch { continue; }
    for (const f of await findSessionFiles(src.dir, src.ext, src.skip)) {
      files.push({ path: f, agent: src.agent, realBase });
    }
  }
  files.sort((a, b) => {
    try { return fs.statSync(b.path).mtimeMs - fs.statSync(a.path).mtimeMs; }
    catch { return 0; }
  });

  const results = [];
  for (const file of files) {
    if (Date.now() > deadline || results.length >= limit) break;
    let resolved;
    try { resolved = fs.realpathSync(file.path); } catch { continue; }
    if (!resolved.startsWith(file.realBase + path.sep)) continue;
    const remaining = limit - results.length;
    if (file.agent === 'gemini') {
      results.push(...searchGeminiFile(file.path, lower, remaining));
    } else {
      const extractor = file.agent === 'codex' ? extractCodexContent
        : file.agent === 'pi' ? extractPiContent
        : extractClaudeContent;
      results.push(...(await searchJsonlFile(file.path, lower, remaining, deadline, extractor)));
    }
  }

  results.sort((a, b) => normalizeTimestamp(b.timestamp) - normalizeTimestamp(a.timestamp));
  return { results, partial: Date.now() > deadline };
}

// ---- Public: searchInMemory ----

/**
 * Walk live InstanceManager conversations for matches.
 *
 * @param {string} query
 * @param {object} instanceManager  must expose getAll() and getConversation(id, limit)
 * @param {object} [opts]
 * @param {number} [opts.limit] (default 60, max 300)
 * @param {number} [opts.perInstanceLimit] (default 500, max 500)
 * @returns {{ results: Array }}
 */
function searchInMemory(query, instanceManager, opts) {
  const lower = prepareQuery(query);
  if (!lower || !instanceManager) return { results: [] };
  const limit = clampLimit(opts && opts.limit, 300);
  const perInstance = Math.min(
    Math.max(parseInt((opts && opts.perInstanceLimit), 10) || MAX_IN_MEMORY_HISTORY, 1),
    MAX_IN_MEMORY_HISTORY
  );

  const results = [];
  const instances = typeof instanceManager.getAll === 'function' ? instanceManager.getAll() : [];
  for (const inst of instances) {
    if (results.length >= limit) break;
    if (!inst || !inst.id) continue;
    // Prefer the canonical sessionId when present; fall back to the
    // instance id so callers can still navigate to live-only instances.
    const sessionId = inst.sessionId || inst.id;
    if (!isValidSessionId(sessionId)) continue;
    let conv;
    try { conv = instanceManager.getConversation(inst.id, perInstance); }
    catch { continue; }
    if (!Array.isArray(conv)) continue;
    for (const msg of conv) {
      if (results.length >= limit) break;
      const extracted = extractLiveContent(msg);
      if (!extracted) continue;
      const idx = extracted.content.toLowerCase().indexOf(lower);
      if (idx === -1) continue;
      const snip = buildSnippet(extracted.content, idx, lower.length);
      results.push({
        sessionId,
        instanceId: inst.id,
        role: extracted.role,
        snippet: snip.snippet,
        matchIndex: snip.matchIndex,
        matchLength: snip.matchLength,
        timestamp: msg.timestamp || null,
        source: 'memory',
      });
    }
  }
  results.sort((a, b) => normalizeTimestamp(b.timestamp) - normalizeTimestamp(a.timestamp));
  return { results };
}

// ---- Public: groupBySession + ranking ----

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_WINDOW_DAYS = 30;
const RECENCY_BOOST_MAX = 5;
const DEFAULT_TOP_SNIPPETS = 3;
const MAX_TOP_SNIPPETS = 5;

/**
 * Score = matchCount + recencyBoost
 *
 * recencyBoost = max(0, RECENCY_WINDOW_DAYS - daysSinceLastMatch) /
 *                RECENCY_WINDOW_DAYS * RECENCY_BOOST_MAX
 *
 * Today's match: boost = 5. Boost reaches 0 at 30 days old.
 * 1 match today (~5.0) outranks 4 matches a year ago (~4.0);
 * 10 matches today (~10.0) outranks both.
 */
function rankScore(matchCount, lastMatchTs, now) {
  if (!Number.isFinite(matchCount) || matchCount <= 0) return 0;
  const ts = normalizeTimestamp(lastMatchTs);
  if (!ts) return matchCount; // no timestamp = no recency component
  const ageDays = Math.max(0, (now - ts) / DAY_MS);
  const boost = Math.max(0, (RECENCY_WINDOW_DAYS - ageDays) / RECENCY_WINDOW_DAYS) * RECENCY_BOOST_MAX;
  return matchCount + boost;
}

/**
 * Group an array of per-message hits by sessionId, compute matchCount +
 * score, and return sessions ranked newest+most-frequent first.
 *
 * @param {Array} hits  output of searchOnDisk + searchInMemory merged
 * @param {object} [opts]
 * @param {number} [opts.snippets] top snippets to keep per session
 * @param {number} [opts.now] epoch ms (injectable for tests)
 */
function groupBySession(hits, opts) {
  const snippetsPerSession = Math.min(
    Math.max(parseInt((opts && opts.snippets), 10) || DEFAULT_TOP_SNIPPETS, 0),
    MAX_TOP_SNIPPETS
  );
  const now = (opts && opts.now) || Date.now();

  const bySession = new Map();
  for (const h of hits) {
    if (!h || !h.sessionId) continue;
    let bucket = bySession.get(h.sessionId);
    if (!bucket) {
      bucket = {
        sessionId: h.sessionId,
        instanceId: h.instanceId || null,
        matchCount: 0,
        lastMatchTs: 0,
        hits: [],
      };
      bySession.set(h.sessionId, bucket);
    }
    bucket.matchCount++;
    const ts = normalizeTimestamp(h.timestamp);
    if (ts > bucket.lastMatchTs) bucket.lastMatchTs = ts;
    // Prefer the live instanceId if any hit has one
    if (!bucket.instanceId && h.instanceId) bucket.instanceId = h.instanceId;
    bucket.hits.push(h);
  }

  const sessions = [];
  for (const b of bySession.values()) {
    // Top snippets sorted newest-first, capped
    const topSnippets = b.hits
      .slice()
      .sort((x, y) => normalizeTimestamp(y.timestamp) - normalizeTimestamp(x.timestamp))
      .slice(0, snippetsPerSession)
      .map(h => ({
        snippet: h.snippet,
        role: h.role,
        timestamp: h.timestamp,
        matchIndex: h.matchIndex,
        matchLength: h.matchLength,
      }));
    sessions.push({
      sessionId: b.sessionId,
      instanceId: b.instanceId,
      matchCount: b.matchCount,
      lastMatchTs: b.lastMatchTs || null,
      score: rankScore(b.matchCount, b.lastMatchTs, now),
      topSnippets,
    });
  }

  sessions.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.lastMatchTs || 0) - (a.lastMatchTs || 0);
  });

  return sessions;
}

module.exports = {
  // Constants
  MIN_QUERY_LENGTH,
  MAX_QUERY_LENGTH,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SNIPPET_WINDOW,
  MAX_IN_MEMORY_HISTORY,
  SAFE_SESSION_ID_REGEX,

  // Helpers
  prepareQuery,
  clampLimit,
  isValidSessionId,
  buildSnippet,
  rankScore,

  // Extractors (re-exported so api.js can drop its private copies)
  extractGeminiText,
  extractClaudeContent,
  extractCodexContent,
  extractPiContent,
  extractLiveContent,

  // Search engines
  searchOnDisk,
  searchInMemory,
  groupBySession,
};
