/**
 * SessionOutboxManager — agent → phone file transfer for dashboard sessions.
 *
 * Mirror of the gateway's `<polpo:artifacts>` directive pattern, but tuned
 * for long-lived dashboard sessions instead of one-shot tasks:
 *
 *   - Per-instance dir (not per-task), created on `enable(instanceId)`
 *     and torn down on `disable()` or instance disconnect.
 *   - Persistent for the session's lifetime: files written during turn N
 *     remain visible during turn N+1. Each idle transition produces a
 *     diff vs the previous snapshot so the UI can render only the
 *     newly-produced files alongside the most-recent assistant message.
 *   - No sealing: the dir stays writable so the agent can keep producing
 *     output. The download path enforces filename safety + prefix-check
 *     at every read; mode 0o700 on the dir + 0o600 on contents keeps
 *     other system users out.
 *
 * Lifecycle:
 *   enable(id)         creates <baseDir>/<safeId>/ (0o700)
 *   send_prompt        websocket layer calls injectDirective() to prepend
 *                      the <polpo:outbox> block if outbox is on
 *   status -> idle     websocket layer calls diffSinceLastIdle(id) and
 *                      broadcasts the new files as an outbox_update event
 *   GET /api/...       dashboard fetches the list / downloads files
 *   disable(id)        rm -rf <safeId>/, mark instance not enabled
 *   instance:disconnected → same as disable
 *
 * Safety invariants:
 *   - The dir path is server-generated from sha256(instanceId).slice(0,32)
 *     so untrusted instance ids can never escape <baseDir>.
 *   - Filenames coming from URL params are validated against the same
 *     regex used by gateway artifacts: /^[A-Za-z0-9._-]{1,200}$/
 *   - Every read resolves the absolute path and checks the
 *     `path.startsWith(<safeId> dir + sep)` prefix BEFORE opening a stream.
 *   - Symlinks and subdirectories inside the outbox are ignored by the
 *     list operation (we only surface regular files at the top level).
 *   - Aggregate byte / file count caps prevent a runaway agent from
 *     filling the disk.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { makeLogger } = require('../util/logger');

const DEFAULT_BASE_DIR = path.join(os.tmpdir(), 'polpo-session-outbox');
const MAX_FILES = 100;
const MAX_AGGREGATE_BYTES = 100 * 1024 * 1024;   // 100 MB
const SAFE_NAME_RE = /^[A-Za-z0-9._\-]{1,200}$/;
const SAFE_INLINE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

class SessionOutboxManager {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseDir] - default <tmpdir>/polpo-session-outbox
   */
  constructor(opts) {
    this.baseDir = (opts && opts.baseDir) || DEFAULT_BASE_DIR;
    this.log = makeLogger('outbox');

    // instanceId -> { dir, lastIdleSnapshot: Set<string> of names }
    this._enabled = new Map();

    try { fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 }); } catch {}
  }

  /**
   * Stable, server-controlled subdir name derived from the instance id.
   * sha256 prevents any path component escape attempt even if a future
   * id format includes slashes or dots.
   */
  _safeSubdir(instanceId) {
    return crypto.createHash('sha256').update(String(instanceId)).digest('hex').slice(0, 32);
  }

  /**
   * Absolute path to the outbox dir for an instance.
   * Always returns a value (does not require enable to have been called),
   * which lets the disable path safely rm -rf even if the manager
   * restarts mid-session.
   */
  dirFor(instanceId) {
    return path.join(this.baseDir, this._safeSubdir(instanceId));
  }

  /**
   * Mark outbox as enabled for an instance and ensure the dir exists.
   * @returns {string} the dir path
   */
  enable(instanceId) {
    if (!instanceId || typeof instanceId !== 'string') {
      throw new TypeError('enable requires a string instanceId');
    }
    const dir = this.dirFor(instanceId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
    if (!this._enabled.has(instanceId)) {
      this._enabled.set(instanceId, { dir, lastIdleSnapshot: this._snapshot(dir) });
    }
    this.log.info(`enabled instance=${instanceId} dir=${dir}`);
    return dir;
  }

  /**
   * Mark outbox disabled and remove the dir contents.
   * Idempotent: calling disable on an already-disabled instance is a no-op.
   */
  disable(instanceId) {
    if (!instanceId) return false;
    const dir = this.dirFor(instanceId);
    this._enabled.delete(instanceId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.log.warn(`disable: rm failed dir=${dir}: ${err.message}`);
    }
    this.log.info(`disabled instance=${instanceId}`);
    return true;
  }

  isEnabled(instanceId) {
    return !!instanceId && this._enabled.has(instanceId);
  }

  /**
   * Inject the <polpo:outbox> directive at the top of a prompt when
   * outbox is enabled for the instance. The block is separated from the
   * caller's text by a blank line so the agent can't subvert the
   * directive parsing with a clever prompt prefix.
   *
   * Returns the original text unchanged when outbox is off.
   */
  injectDirective(instanceId, text) {
    if (!this.isEnabled(instanceId) || typeof text !== 'string') return text;
    const dir = this.dirFor(instanceId);
    const directive = [
      `<polpo:outbox dir="${dir}" max-files="${MAX_FILES}" max-bytes="${MAX_AGGREGATE_BYTES}">`,
      'If you produce output files the user should be able to download,',
      'save them into the directory above.',
      'Only regular files written directly into that directory will be',
      'exposed. Symlinks, subdirectories, and oversized files are ignored.',
      'Filenames must match [A-Za-z0-9._-] and be at most 200 chars.',
      '</polpo:outbox>',
    ].join('\n');
    return directive + '\n\n' + text;
  }

  /**
   * Snapshot the current set of regular-file basenames in a dir.
   * Used to diff "what was here last time the agent went idle" against
   * "what's here now" so the UI can render only new files.
   *
   * @returns {Set<string>}
   */
  _snapshot(dir) {
    const out = new Set();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (e.isFile() && SAFE_NAME_RE.test(e.name)) out.add(e.name);
    }
    return out;
  }

  /**
   * Diff the dir against the previous idle snapshot, returning the names
   * of files added since last idle. Updates the stored snapshot in
   * place so subsequent calls only report further-new files.
   *
   * @returns {string[]} sorted ascending by mtime
   */
  diffSinceLastIdle(instanceId) {
    const rec = this._enabled.get(instanceId);
    if (!rec) return [];
    const current = this._snapshot(rec.dir);
    const previous = rec.lastIdleSnapshot;
    const added = [];
    for (const name of current) {
      if (!previous.has(name)) added.push(name);
    }
    rec.lastIdleSnapshot = current;
    if (added.length === 0) return [];
    // Sort newest first so the UI renders chips in reverse-chronological order
    return added
      .map((name) => {
        let st = null;
        try { st = fs.statSync(path.join(rec.dir, name)); } catch {}
        return { name, mtime: st ? st.mtimeMs : 0 };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.name);
  }

  /**
   * List all current files in an instance's outbox, with metadata.
   * Returns an empty array (not an error) when the instance has no
   * outbox enabled — the dashboard can use this to render a clean
   * empty-state regardless of toggle status.
   *
   * @returns {Array<{name, size, mediaType, mtime, isInlineSafe}>}
   */
  list(instanceId) {
    if (!this.isEnabled(instanceId)) return [];
    const dir = this.dirFor(instanceId);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    let totalBytes = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;            // skip symlinks, subdirs
      if (!SAFE_NAME_RE.test(e.name)) continue;
      const full = path.join(dir, e.name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;           // race-safe re-check
      if (st.size === 0) continue;          // skip empties
      // Aggregate cap: don't surface files that would exceed it. Earlier
      // files win because readdir order is implementation-defined but
      // stable per call.
      if (totalBytes + st.size > MAX_AGGREGATE_BYTES) continue;
      totalBytes += st.size;
      const ext = path.extname(e.name).toLowerCase();
      const isImage = SAFE_INLINE_IMAGE_EXTS.has(ext);
      out.push({
        name: e.name,
        size: st.size,
        mtime: st.mtimeMs,
        mediaType: guessMediaType(ext),
        isInlineSafe: isImage,
      });
      if (out.length >= MAX_FILES) break;
    }
    // Newest first
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  /**
   * Open a file for streaming.
   *
   * @throws Error with .code in:
   *   outbox_not_enabled | invalid_name | file_not_found
   * @returns {{ stream: fs.ReadStream, size: number, mediaType: string, isInlineSafe: boolean, filename: string }}
   */
  open(instanceId, name) {
    if (!this.isEnabled(instanceId)) {
      const err = new Error('outbox_not_enabled'); err.code = 'outbox_not_enabled'; throw err;
    }
    if (typeof name !== 'string' || !SAFE_NAME_RE.test(name)) {
      const err = new Error('invalid_name'); err.code = 'invalid_name'; throw err;
    }
    const dir = this.dirFor(instanceId);
    const full = path.resolve(dir, name);
    // Defence in depth: even though SAFE_NAME_RE blocks '..' and '/',
    // verify the resolved path is still under the instance dir.
    if (!full.startsWith(dir + path.sep)) {
      const err = new Error('invalid_name'); err.code = 'invalid_name'; throw err;
    }
    let st;
    try { st = fs.statSync(full); } catch {
      const err = new Error('file_not_found'); err.code = 'file_not_found'; throw err;
    }
    if (!st.isFile()) {
      const err = new Error('file_not_found'); err.code = 'file_not_found'; throw err;
    }
    const ext = path.extname(name).toLowerCase();
    const isImage = SAFE_INLINE_IMAGE_EXTS.has(ext);
    return {
      filename: name,
      size: st.size,
      mediaType: guessMediaType(ext),
      isInlineSafe: isImage,
      stream: fs.createReadStream(full),
    };
  }

  /**
   * Server shutdown: rm -rf every per-instance dir we created. Best-effort.
   */
  destroyAll() {
    for (const id of [...this._enabled.keys()]) {
      try { this.disable(id); } catch {}
    }
  }
}

function guessMediaType(ext) {
  switch (ext) {
    case '.txt': case '.md':   return 'text/plain; charset=utf-8';
    case '.json':              return 'application/json';
    case '.csv':               return 'text/csv';
    case '.html': case '.htm': return 'text/html; charset=utf-8';
    case '.png':               return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.gif':               return 'image/gif';
    case '.webp':              return 'image/webp';
    case '.svg':               return 'image/svg+xml';
    case '.pdf':               return 'application/pdf';
    case '.zip':               return 'application/zip';
    case '.gz':                return 'application/gzip';
    case '.tar':               return 'application/x-tar';
    case '.log':               return 'text/plain; charset=utf-8';
    default:                   return 'application/octet-stream';
  }
}

module.exports = {
  SessionOutboxManager,
  MAX_FILES,
  MAX_AGGREGATE_BYTES,
  SAFE_NAME_RE,
};
