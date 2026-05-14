/**
 * GatewayUploadStore — caller-pushed file inputs for gateway tasks.
 *
 * Storage layout:
 *   <root>/u-<uuid>/
 *     data        (mode 0o600) — the raw file bytes
 *     meta.json   (mode 0o600) — { filename, mediaType, size, sha256,
 *                                   createdAt, expiresAt,
 *                                   tokenFingerprint }
 *
 * Lifecycle: uploads are independent of any task. Default TTL = 1 hour.
 * A periodic GC removes expired uploads. When a task references an
 * uploadId, the store records the binding so an in-flight task isn't
 * collected mid-use. Once finalize releases the binding, GC may
 * reclaim normally.
 *
 * Security:
 *   - dirs 0o700, files 0o600 (created with explicit mode)
 *   - filename pre-rejected for `..`, separators, NUL, control chars
 *     BEFORE the regex replace (see upload-constants.isUnsafeFilename)
 *   - uploadId format strictly UUID v4 with `u-` prefix
 *   - tokenFingerprint = sha256(bearer token); recorded at put-time,
 *     re-checked at get-time so a future second key can't read another
 *     key's uploads
 *   - sha256 of payload returned to caller (audit) and stored in meta
 *   - never log filenames in errors (caller-controlled); log size+sha256
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const {
  isUnsafeFilename,
  sanitizeFilename,
  UPLOAD_ID_REGEX,
  GATEWAY_MAX_UPLOAD_SIZE,
} = require('./upload-constants');

const DEFAULT_ROOT = path.join(os.tmpdir(), 'polpo-gateway-uploads');
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_GC_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const GC_GRACE_MS = 30 * 1000; // 30s extra retention to tolerate in-flight reads

class UploadError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.code = code;
    if (extra && typeof extra === 'object') Object.assign(this, extra);
  }
}

class GatewayUploadStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.root] - storage root (default: tmpdir/polpo-gateway-uploads)
   * @param {number} [opts.ttlMs] - upload TTL in ms (default 1h)
   * @param {number} [opts.maxBytes] - per-upload byte cap
   * @param {number} [opts.gcIntervalMs] - GC sweep cadence
   * @param {boolean} [opts.autoStartGc=false] - start the periodic GC timer
   *        on construction. Tests leave this false and call gcExpired()
   *        synchronously so they don't leak timers.
   */
  constructor(opts) {
    opts = opts || {};
    this.root = opts.root || DEFAULT_ROOT;
    this.ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
    this.maxBytes = opts.maxBytes || GATEWAY_MAX_UPLOAD_SIZE;
    this.gcIntervalMs = opts.gcIntervalMs || DEFAULT_GC_INTERVAL_MS;
    this._pinned = new Map(); // uploadId -> Set<taskId>
    this._gcTimer = null;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    // Tighten root permissions in case it pre-existed with looser mode.
    try { fs.chmodSync(this.root, 0o700); } catch {}
    if (opts.autoStartGc) this.startGc();
  }

  /**
   * Persist a base64-decoded buffer to the store.
   * @param {object} input
   * @param {Buffer} input.buffer
   * @param {string} input.filename - caller-supplied filename (sanitized)
   * @param {string} [input.mediaType]
   * @param {string} input.tokenFingerprint - sha256 hex of the bearer
   *   token used to authenticate the upload request
   * @returns {{ uploadId, filename, mediaType, size, sha256, expiresAt }}
   */
  put(input) {
    if (!input || !Buffer.isBuffer(input.buffer)) {
      throw new UploadError('invalid_upload', 'buffer is required');
    }
    if (input.buffer.length > this.maxBytes) {
      throw new UploadError('upload_too_large', undefined, {
        limit: this.maxBytes,
        actual: input.buffer.length,
      });
    }
    if (isUnsafeFilename(input.filename)) {
      throw new UploadError('invalid_filename');
    }
    if (typeof input.tokenFingerprint !== 'string' || input.tokenFingerprint.length !== 64) {
      // sha256 hex = 64 chars; reject anything else so the field can't
      // be spoofed empty by a caller bypassing the route handler.
      throw new UploadError('invalid_token_fingerprint');
    }

    const safeName = sanitizeFilename(input.filename);
    const uploadId = 'u-' + crypto.randomUUID();
    const dir = path.join(this.root, uploadId);
    const dataPath = path.join(dir, 'data');
    const metaPath = path.join(dir, 'meta.json');

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}

    // Hash + write atomically (write to data.tmp, then rename) so a
    // partial write can't be observed.
    const sha = crypto.createHash('sha256').update(input.buffer).digest('hex');
    const tmpData = dataPath + '.tmp';
    fs.writeFileSync(tmpData, input.buffer, { mode: 0o600 });
    fs.renameSync(tmpData, dataPath);

    const now = Date.now();
    const expiresAt = now + this.ttlMs;
    const meta = {
      uploadId,
      filename: safeName,
      mediaType: typeof input.mediaType === 'string' ? input.mediaType.slice(0, 200) : 'application/octet-stream',
      size: input.buffer.length,
      sha256: sha,
      createdAt: now,
      expiresAt,
      tokenFingerprint: input.tokenFingerprint,
    };
    const tmpMeta = metaPath + '.tmp';
    fs.writeFileSync(tmpMeta, JSON.stringify(meta, null, 2), { mode: 0o600 });
    fs.renameSync(tmpMeta, metaPath);

    return {
      uploadId,
      filename: safeName,
      mediaType: meta.mediaType,
      size: meta.size,
      sha256: meta.sha256,
      expiresAt,
    };
  }

  /**
   * Resolve an uploadId to its on-disk file and metadata.
   * Enforces:
   *   - regex shape on uploadId (no path traversal)
   *   - not expired
   *   - tokenFingerprint matches the requesting caller
   *
   * @returns {{ dataPath, meta }} on success
   * @throws UploadError with code 'upload_not_found' |
   *   'upload_expired' | 'upload_forbidden' | 'invalid_upload_id'
   */
  get(uploadId, tokenFingerprint) {
    if (typeof uploadId !== 'string' || !UPLOAD_ID_REGEX.test(uploadId)) {
      throw new UploadError('invalid_upload_id');
    }
    const dir = path.join(this.root, uploadId);
    // path.resolve guard — even though the regex makes traversal impossible,
    // this is defence in depth in case the regex is ever relaxed.
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(this.root + path.sep) && resolved !== this.root) {
      throw new UploadError('invalid_upload_id');
    }
    const metaPath = path.join(dir, 'meta.json');
    const dataPath = path.join(dir, 'data');

    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') throw new UploadError('upload_not_found');
      throw new UploadError('upload_read_failed');
    }

    if (typeof meta.expiresAt === 'number' && Date.now() > meta.expiresAt) {
      // Eagerly clean up the expired entry so we don't repeatedly serve
      // stale 'upload_expired' for the same id.
      this._removeDir(dir).catch(() => {});
      throw new UploadError('upload_expired');
    }

    // Token-scoping: only the caller who uploaded may bind/read.
    if (typeof tokenFingerprint === 'string'
        && typeof meta.tokenFingerprint === 'string'
        && meta.tokenFingerprint !== tokenFingerprint) {
      throw new UploadError('upload_forbidden');
    }

    // Verify the data file is still a regular file (defence vs symlink swap)
    let st;
    try { st = fs.lstatSync(dataPath); } catch { throw new UploadError('upload_not_found'); }
    if (!st.isFile()) throw new UploadError('upload_not_found');

    return { dataPath, meta };
  }

  /**
   * Pin an upload to a task so GC won't collect it while in use.
   * Idempotent — pinning the same (uploadId, taskId) twice is a no-op.
   */
  pinToTask(uploadId, taskId) {
    if (!UPLOAD_ID_REGEX.test(uploadId)) {
      throw new UploadError('invalid_upload_id');
    }
    let set = this._pinned.get(uploadId);
    if (!set) { set = new Set(); this._pinned.set(uploadId, set); }
    set.add(taskId);
  }

  releaseFromTask(uploadId, taskId) {
    const set = this._pinned.get(uploadId);
    if (!set) return;
    set.delete(taskId);
    if (set.size === 0) this._pinned.delete(uploadId);
  }

  /**
   * Remove any uploads whose expiresAt is in the past AND that aren't
   * currently pinned to any task. Honours GC_GRACE_MS so an in-flight
   * download has a moment to finish.
   * @returns {number} count of uploads removed
   */
  gcExpired() {
    let removed = 0;
    let entries;
    try { entries = fs.readdirSync(this.root); } catch { return 0; }
    const now = Date.now();
    for (const name of entries) {
      if (!UPLOAD_ID_REGEX.test(name)) continue; // skip junk
      if (this._pinned.has(name)) continue;
      const dir = path.join(this.root, name);
      const metaPath = path.join(dir, 'meta.json');
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
      if (!meta || typeof meta.expiresAt !== 'number') {
        // Orphaned dir (no meta) — wait for the grace window then clean
        let st;
        try { st = fs.statSync(dir); } catch { continue; }
        if (now - st.mtimeMs > GC_GRACE_MS) {
          try { this._removeDirSync(dir); removed++; } catch {}
        }
        continue;
      }
      if (now > meta.expiresAt + GC_GRACE_MS) {
        try { this._removeDirSync(dir); removed++; } catch {}
      }
    }
    return removed;
  }

  startGc() {
    if (this._gcTimer) return;
    this._gcTimer = setInterval(() => {
      try { this.gcExpired(); } catch {}
    }, this.gcIntervalMs);
    if (typeof this._gcTimer.unref === 'function') this._gcTimer.unref();
  }

  stopGc() {
    if (this._gcTimer) {
      clearInterval(this._gcTimer);
      this._gcTimer = null;
    }
  }

  destroy() {
    this.stopGc();
    this._pinned.clear();
  }

  _removeDirSync(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  async _removeDir(dir) {
    try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  GatewayUploadStore,
  UploadError,
  DEFAULT_ROOT,
  DEFAULT_TTL_MS,
  GC_GRACE_MS,
};
