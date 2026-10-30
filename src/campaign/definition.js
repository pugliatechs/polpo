/**
 * The campaign file: what you approve before a campaign may run anything.
 *
 * It lives in the repository (default .polpo/campaign.json), so it is
 * versioned with the work, and the agent can edit it. What polpo runs is
 * the copy you approved, pinned by hash outside the repository; a changed
 * file pauses the campaign until you approve it again.
 *
 * See docs/campaigns.md, section 4.1.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FILE = path.join('.polpo', 'campaign.json');
const MAX_FILE_BYTES = 256 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_GATE_TIMEOUT_S = 1800;
const MAX_GATE_TIMEOUT_S = 24 * 60 * 60;
// Text a PA can forward as it is (section 4.10).
const MAX_DECISION_TEXT = 3500;

// Pinned directories are hashed file by file; a tree larger than this is
// hashed as far as the limit and marked so.
const MAX_PINNED_FILES = 2000;

const TOP_KEYS = new Set([
  'version', 'name', 'objective', 'read_first', 'constraints', 'milestones',
  'pinned_paths', 'budgets', 'stop', 'resume_after_idle_minutes',
]);
const BUDGET_KEYS = new Set(['turns_per_milestone', 'hours_per_milestone', 'same_failure_limit']);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isStr(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function strList(v, maxItems, maxLen) {
  return Array.isArray(v) && v.length <= maxItems && v.every((x) => isStr(x, maxLen));
}

/** A relative path that stays inside the repository. */
function isSafeRelPath(p) {
  if (!isStr(p, 500) || p.indexOf('\0') !== -1 || path.isAbsolute(p)) return false;
  const norm = path.normalize(p);
  return norm !== '..' && !norm.startsWith('..' + path.sep);
}

/**
 * Check a parsed campaign file.
 * @returns {{ok: true, definition: object} | {ok: false, errors: string[]}}
 */
function validateDefinition(def) {
  const errors = [];
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    return { ok: false, errors: ['the campaign file must hold a JSON object'] };
  }
  const unknown = Object.keys(def).filter((k) => !TOP_KEYS.has(k));
  if (unknown.length) errors.push('unknown keys: ' + unknown.join(', '));
  if (def.version !== 1) errors.push('version must be 1');
  if (typeof def.name !== 'string' || !ID_RE.test(def.name)) {
    errors.push('name must be lowercase letters, digits and dashes, at most 64');
  }
  if (!isStr(def.objective, 2000)) errors.push('objective is required (at most 2000 characters)');
  if (def.read_first !== undefined && !strList(def.read_first, 50, 500)) {
    errors.push('read_first must be a list of at most 50 paths');
  }
  if (def.constraints !== undefined && !strList(def.constraints, 50, 1000)) {
    errors.push('constraints must be a list of at most 50 strings');
  }
  if (def.stop !== undefined && !isStr(def.stop, 1000)) errors.push('stop must be a string');
  if (def.resume_after_idle_minutes !== undefined
    && !(Number.isInteger(def.resume_after_idle_minutes) && def.resume_after_idle_minutes > 0)) {
    errors.push('resume_after_idle_minutes must be a positive integer');
  }
  if (def.pinned_paths !== undefined) {
    if (!Array.isArray(def.pinned_paths) || def.pinned_paths.length > 50 || !def.pinned_paths.every(isSafeRelPath)) {
      errors.push('pinned_paths must be at most 50 paths inside the repository');
    }
  }
  if (def.budgets !== undefined) {
    const b = def.budgets;
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      errors.push('budgets must be an object');
    } else {
      for (const k of Object.keys(b)) {
        if (!BUDGET_KEYS.has(k)) errors.push('unknown budget: ' + k);
        else if (!(Number.isInteger(b[k]) && b[k] > 0)) errors.push('budgets.' + k + ' must be a positive integer');
      }
    }
  }
  if (!Array.isArray(def.milestones) || def.milestones.length === 0 || def.milestones.length > 100) {
    errors.push('milestones must be a list of 1 to 100 milestones');
  } else {
    const seen = new Set();
    def.milestones.forEach((m, i) => {
      const at = 'milestones[' + i + ']';
      if (!m || typeof m !== 'object' || Array.isArray(m)) { errors.push(at + ' must be an object'); return; }
      if (typeof m.id !== 'string' || !ID_RE.test(m.id)) errors.push(at + '.id must be lowercase letters, digits and dashes');
      else if (seen.has(m.id)) errors.push(at + '.id ' + m.id + ' is used twice');
      else seen.add(m.id);
      if (!isStr(m.goal, 2000)) errors.push(at + '.goal is required');
      if (!isStr(m.accept, 2000)) errors.push(at + '.accept is required');
      const g = m.gate;
      if (!g || typeof g !== 'object') { errors.push(at + '.gate is required'); return; }
      if (!Array.isArray(g.run) || g.run.length === 0 || g.run.length > 64
        || !g.run.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 4096 && a.indexOf('\0') === -1)) {
        errors.push(at + '.gate.run must be a command as a list of arguments (no shell)');
      }
      if (g.timeout_s !== undefined && !(Number.isInteger(g.timeout_s) && g.timeout_s > 0 && g.timeout_s <= MAX_GATE_TIMEOUT_S)) {
        errors.push(at + '.gate.timeout_s must be 1 to ' + MAX_GATE_TIMEOUT_S);
      }
      const extra = Object.keys(m).filter((k) => !['id', 'goal', 'gate', 'accept'].includes(k));
      if (extra.length) errors.push(at + ' has unknown keys: ' + extra.join(', '));
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, definition: def };
}

/**
 * Where the campaign file of a repository is, refusing anything outside
 * it (a symlink pointing elsewhere included).
 *
 * @returns {{ok: true, path: string} | {ok: false, error: string, message: string}}
 */
function resolveCampaignFile(cwd, file) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return { ok: false, error: 'invalid_cwd', message: 'cwd must be an absolute path.' };
  }
  let root;
  try {
    root = fs.realpathSync(cwd);
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    return { ok: false, error: 'invalid_cwd', message: 'cwd is not a directory.' };
  }
  const rel = file === undefined || file === null ? DEFAULT_FILE : file;
  if (!isSafeRelPath(rel)) {
    return { ok: false, error: 'invalid_file', message: 'file must be a path inside cwd.' };
  }
  let real;
  try {
    real = fs.realpathSync(path.join(root, rel));
  } catch {
    return { ok: false, error: 'campaign_file_not_found', message: 'No campaign file at ' + rel + '.' };
  }
  if (!real.startsWith(root + path.sep)) {
    return { ok: false, error: 'invalid_file', message: 'The campaign file resolves outside cwd.' };
  }
  return { ok: true, path: real, root, rel };
}

/**
 * Read and check a campaign file.
 * @returns {{ok: true, hash: string, raw: string, definition: object} |
 *   {ok: false, error: string, message: string, errors?: string[]}}
 */
function readDefinition(filePath) {
  let raw;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return { ok: false, error: 'campaign_file_not_found', message: 'Not a file.' };
    if (st.size > MAX_FILE_BYTES) {
      return { ok: false, error: 'invalid_definition', message: 'The campaign file is larger than 256 KB.', errors: ['file too large'] };
    }
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false, error: 'campaign_file_not_found', message: 'The campaign file cannot be read.' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: 'invalid_definition', message: 'The campaign file is not valid JSON.', errors: [String(err.message).slice(0, 200)] };
  }
  const v = validateDefinition(parsed);
  if (!v.ok) {
    return { ok: false, error: 'invalid_definition', message: 'The campaign file has errors: ' + v.errors.join('; '), errors: v.errors };
  }
  return { ok: true, hash: sha256(raw), raw, definition: v.definition };
}

function listFiles(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (out.length >= MAX_PINNED_FILES) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out);
    else if (e.isFile()) out.push(p);
  }
}

/**
 * Hash of a pinned path: a file's content, or for a directory every file
 * under it with its relative name. null when the path does not exist.
 */
function hashPinnedPath(root, rel) {
  const abs = path.join(root, rel);
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (st.isFile()) {
    try { return sha256(fs.readFileSync(abs)); } catch { return null; }
  }
  if (!st.isDirectory()) return null;
  const files = [];
  listFiles(abs, files);
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(path.relative(abs, f) + '\0');
    try { h.update(sha256(fs.readFileSync(f))); } catch { h.update('unreadable'); }
    h.update('\n');
  }
  if (files.length >= MAX_PINNED_FILES) h.update('truncated');
  return h.digest('hex');
}

/** { path: hash } for every pinned path of a definition. */
function hashPinnedPaths(root, definition) {
  const out = {};
  for (const rel of definition.pinned_paths || []) out[rel] = hashPinnedPath(root, rel);
  return out;
}

/** Pinned paths whose content differs from `pinned`. */
function changedPinnedPaths(root, pinned) {
  const changed = [];
  for (const rel of Object.keys(pinned || {})) {
    if (hashPinnedPath(root, rel) !== pinned[rel]) changed.push(rel);
  }
  return changed;
}

/** A gate command as you would type it. */
function formatArgv(argv) {
  return argv.map((a) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
}

function formatDuration(seconds) {
  if (seconds % 3600 === 0) return (seconds / 3600) + 'h';
  if (seconds % 60 === 0) return (seconds / 60) + 'm';
  return seconds + 's';
}

function gateTimeoutS(milestone) {
  return (milestone.gate && milestone.gate.timeout_s) || DEFAULT_GATE_TIMEOUT_S;
}

function formatBudgets(b) {
  if (!b) return null;
  const parts = [];
  if (b.turns_per_milestone) parts.push(b.turns_per_milestone + ' turns');
  if (b.hours_per_milestone) parts.push(b.hours_per_milestone + ' hours');
  if (b.same_failure_limit) parts.push(b.same_failure_limit + ' identical gate failures');
  return parts.length ? parts.join(', ') + ' per milestone' : null;
}

/**
 * The definition as a readable ladder: what you are asked to approve.
 * Plain text, no markup.
 */
function renderDefinition(def) {
  const lines = [];
  lines.push('Objective: ' + def.objective);
  lines.push('');
  lines.push('Milestones, in order:');
  def.milestones.forEach((m, i) => {
    lines.push((i + 1) + '. ' + m.id + ': ' + m.goal);
    lines.push('   Gate: ' + formatArgv(m.gate.run) + ' (timeout ' + formatDuration(gateTimeoutS(m)) + ')');
    lines.push('   Accept when: ' + m.accept);
  });
  if (def.constraints && def.constraints.length) {
    lines.push('');
    lines.push('Constraints:');
    for (const c of def.constraints) lines.push('- ' + c);
  }
  if (def.read_first && def.read_first.length) lines.push('', 'Read first: ' + def.read_first.join(', '));
  if (def.pinned_paths && def.pinned_paths.length) lines.push('Gate files shown on every verdict: ' + def.pinned_paths.join(', '));
  const budgets = formatBudgets(def.budgets);
  if (budgets) lines.push('Budgets: ' + budgets);
  if (def.stop) lines.push('Stop: ' + def.stop);
  return lines.join('\n');
}

/**
 * What changed between two definitions, one line per change, for the
 * decision that asks you to approve the new one.
 */
function describeChange(before, after) {
  const out = [];
  const b = new Map(before.milestones.map((m) => [m.id, m]));
  const a = new Map(after.milestones.map((m) => [m.id, m]));
  for (const [id] of b) if (!a.has(id)) out.push('Removed milestone ' + id + '.');
  for (const [id, m] of a) {
    const old = b.get(id);
    if (!old) { out.push('Added milestone ' + id + ': ' + m.goal); continue; }
    if (old.goal !== m.goal) out.push(id + ' goal: "' + old.goal + '" -> "' + m.goal + '"');
    if (formatArgv(old.gate.run) !== formatArgv(m.gate.run)) {
      out.push(id + ' gate: ' + formatArgv(old.gate.run) + ' -> ' + formatArgv(m.gate.run));
    }
    if (gateTimeoutS(old) !== gateTimeoutS(m)) {
      out.push(id + ' gate timeout: ' + formatDuration(gateTimeoutS(old)) + ' -> ' + formatDuration(gateTimeoutS(m)));
    }
    if (old.accept !== m.accept) out.push(id + ' accept: "' + old.accept + '" -> "' + m.accept + '"');
  }
  const order = (d) => d.milestones.map((m) => m.id).filter((id) => a.has(id) && b.has(id)).join(',');
  if (order(before) !== order(after)) out.push('Milestones reordered: ' + after.milestones.map((m) => m.id).join(', '));
  if (before.objective !== after.objective) out.push('Objective: "' + before.objective + '" -> "' + after.objective + '"');
  const same = (x, y) => JSON.stringify(x === undefined ? null : x) === JSON.stringify(y === undefined ? null : y);
  for (const k of ['constraints', 'read_first', 'pinned_paths', 'budgets', 'stop', 'resume_after_idle_minutes']) {
    if (!same(before[k], after[k])) out.push(k + ' changed: ' + JSON.stringify(before[k] || null) + ' -> ' + JSON.stringify(after[k] || null));
  }
  if (before.name !== after.name) out.push('name changed: ' + before.name + ' -> ' + after.name);
  return out;
}

/** Cut text to what a decision may carry, saying where the rest is. */
function capDecisionText(text, rest) {
  if (text.length <= MAX_DECISION_TEXT) return text;
  const tail = '\n... (shortened; ' + rest + ')';
  return text.slice(0, MAX_DECISION_TEXT - tail.length) + tail;
}

module.exports = {
  DEFAULT_FILE,
  ID_RE,
  DEFAULT_GATE_TIMEOUT_S,
  MAX_DECISION_TEXT,
  sha256,
  validateDefinition,
  resolveCampaignFile,
  readDefinition,
  hashPinnedPath,
  hashPinnedPaths,
  changedPinnedPaths,
  formatArgv,
  gateTimeoutS,
  renderDefinition,
  describeChange,
  capDecisionText,
};
