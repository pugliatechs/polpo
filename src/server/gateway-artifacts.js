/**
 * GatewayArtifactStore — agent-produced output files returned to the caller.
 *
 * Layout per task:
 *   <root>/<taskId>/
 *     write/    (mode 0o700) — directory the agent writes into. Path
 *                              is injected into the prompt via the
 *                              <polpo:artifacts> system block.
 *     sealed/   (mode 0o700) — created by sealOnFinalize. Each file is
 *                              hard-linked from write/ after passing
 *                              safety checks, then chmod'd 0o400. The
 *                              caller-facing download endpoint serves
 *                              ONLY from this directory.
 *
 * Why a separate sealed/ dir (TOCTOU defence)
 * ──────────────────────────────────────────
 * After we announce an artifact list to the caller (SSE), the caller
 * may start a download seconds or minutes later. If we served from
 * write/ directly, anything with write access to write/ between
 * announce and download could swap a real file for a symlink or
 * change the contents. By the time _finalize runs the agent
 * subprocess is gone, so write/ is effectively quiescent — we
 * lstat + hard-link the survivors into sealed/ and chmod them 0o400,
 * which freezes inode + permission for the lifetime of the link.
 * Any later mutation in write/ is invisible to downloads.
 *
 * Caps enforced during seal (NEVER trusted from the directory state):
 *   - per-file size  (maxFileBytes)
 *   - aggregate size (maxBytes)
 *   - file count     (maxFiles)
 *   - regular files only (lstat → isFile)
 *   - non-recursive  (subdirs ignored, never descended)
 *   - name pattern   ARTIFACT_NAME_REGEX
 *
 * Failures during seal don't crash the task: oversized aggregate
 * truncates the list deterministically (sorted by name asc); files
 * failing safety checks are skipped and noted in stats.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  ARTIFACT_NAME_REGEX,
  SAFE_INLINE_IMAGE_EXTS,
  GATEWAY_TASK_ARTIFACT_MAX_FILES,
  GATEWAY_TASK_ARTIFACT_MAX_FILE_BYTES,
  GATEWAY_TASK_AGGREGATE_BYTES,
} = require('./upload-constants');

const DEFAULT_ROOT = path.join(os.tmpdir(), 'polpo-gateway-artifacts');

// taskId shape — matches what GatewayTaskManager generates: 'gtask-<8-hex-or-base36>'
const TASK_ID_REGEX = /^gtask-[a-z0-9-]{4,32}$/;

class ArtifactError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

class GatewayArtifactStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.root]
   * @param {number} [opts.maxFiles]
   * @param {number} [opts.maxBytes] - aggregate cap
   * @param {number} [opts.maxFileBytes] - per-file cap
   */
  constructor(opts) {
    opts = opts || {};
    this.root = opts.root || DEFAULT_ROOT;
    this.maxFiles = opts.maxFiles || GATEWAY_TASK_ARTIFACT_MAX_FILES;
    this.maxBytes = opts.maxBytes || GATEWAY_TASK_AGGREGATE_BYTES;
    this.maxFileBytes = opts.maxFileBytes || GATEWAY_TASK_ARTIFACT_MAX_FILE_BYTES;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.root, 0o700); } catch {}
  }

  /**
   * Create the write/ dir for a task. Returns the absolute path the
   * agent should write to (passed via the <polpo:artifacts> prompt
   * directive). Idempotent.
   */
  createDir(taskId) {
    this._assertTaskId(taskId);
    const writeDir = path.join(this.root, taskId, 'write');
    fs.mkdirSync(writeDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(writeDir, 0o700); } catch {}
    try { fs.chmodSync(path.join(this.root, taskId), 0o700); } catch {}
    return writeDir;
  }

  /**
   * Snapshot surviving files in <taskId>/write into <taskId>/sealed.
   * Returns the list of accepted artifact descriptors. Skipped entries
   * are reported via the `stats.skipped` array.
   *
   * @returns {{ artifacts: Array<{name,size,mediaType}>, stats: object }}
   */
  sealOnFinalize(taskId) {
    this._assertTaskId(taskId);
    const writeDir = path.join(this.root, taskId, 'write');
    const sealedDir = path.join(this.root, taskId, 'sealed');

    let entries = [];
    try { entries = fs.readdirSync(writeDir); }
    catch (err) {
      if (err.code === 'ENOENT') return { artifacts: [], stats: { skipped: [] } };
      throw new ArtifactError('artifact_scan_failed');
    }

    // Stable order so truncation by aggregate cap is deterministic.
    entries.sort();

    fs.mkdirSync(sealedDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(sealedDir, 0o700); } catch {}

    const artifacts = [];
    const skipped = [];
    let aggregateBytes = 0;

    for (const name of entries) {
      if (artifacts.length >= this.maxFiles) {
        skipped.push({ name, reason: 'max_files_reached' });
        continue;
      }
      if (!ARTIFACT_NAME_REGEX.test(name)) {
        skipped.push({ name, reason: 'invalid_name' });
        continue;
      }

      const src = path.join(writeDir, name);
      // path.resolve check (defence in depth — the regex already blocks
      // separators and ..). Catches any encoding tricks reaching the fs.
      const resolved = path.resolve(src);
      if (!resolved.startsWith(writeDir + path.sep)) {
        skipped.push({ name, reason: 'invalid_name' });
        continue;
      }

      // lstat to refuse symlinks, sockets, devices, fifos, subdirs.
      let st;
      try { st = fs.lstatSync(src); }
      catch { skipped.push({ name, reason: 'unreadable' }); continue; }
      if (!st.isFile()) {
        skipped.push({ name, reason: 'not_a_regular_file' });
        continue;
      }
      if (st.size > this.maxFileBytes) {
        skipped.push({ name, reason: 'too_large' });
        continue;
      }
      if (aggregateBytes + st.size > this.maxBytes) {
        skipped.push({ name, reason: 'aggregate_cap_reached' });
        continue;
      }

      const dst = path.join(sealedDir, name);
      // Prefer hardlink for atomic capture without copy cost. If link
      // fails (cross-device, race), fall back to copy.
      try {
        fs.linkSync(src, dst);
      } catch (linkErr) {
        try { fs.copyFileSync(src, dst); }
        catch { skipped.push({ name, reason: 'unreadable' }); continue; }
      }
      // Lock the sealed entry: read-only for owner, no one else.
      try { fs.chmodSync(dst, 0o400); } catch {}

      // Re-lstat the sealed copy to confirm it really is a regular file.
      let sealedSt;
      try { sealedSt = fs.lstatSync(dst); }
      catch { skipped.push({ name, reason: 'unreadable' }); continue; }
      if (!sealedSt.isFile()) {
        try { fs.unlinkSync(dst); } catch {}
        skipped.push({ name, reason: 'not_a_regular_file' });
        continue;
      }

      aggregateBytes += st.size;
      artifacts.push({
        name,
        size: st.size,
        mediaType: detectMediaType(name),
      });
    }

    return { artifacts, stats: { skipped, aggregateBytes } };
  }

  /**
   * Open a sealed artifact for streaming. Returns { stream, size,
   * mediaType, isInlineSafe }. Throws ArtifactError on any failure;
   * never throws fs.* raw errors to the caller.
   */
  openSealed(taskId, name) {
    this._assertTaskId(taskId);
    if (typeof name !== 'string' || !ARTIFACT_NAME_REGEX.test(name)) {
      throw new ArtifactError('invalid_artifact_name');
    }
    const sealedDir = path.join(this.root, taskId, 'sealed');
    const target = path.join(sealedDir, name);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(sealedDir + path.sep)) {
      throw new ArtifactError('invalid_artifact_name');
    }
    let st;
    try { st = fs.lstatSync(resolved); }
    catch { throw new ArtifactError('artifact_not_found'); }
    // Defence in depth: even though sealed/ files are 0o400 + hardlinked,
    // confirm we're not following a symlink.
    if (!st.isFile()) {
      throw new ArtifactError('artifact_not_found');
    }
    const stream = fs.createReadStream(resolved);
    return {
      stream,
      size: st.size,
      mediaType: detectMediaType(name),
      isInlineSafe: SAFE_INLINE_IMAGE_EXTS.includes(path.extname(name).toLowerCase()),
    };
  }

  /**
   * Remove all on-disk state for a task. Tolerant of missing dirs.
   */
  destroyTask(taskId) {
    if (!TASK_ID_REGEX.test(String(taskId))) return;
    const dir = path.join(this.root, taskId);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  _assertTaskId(taskId) {
    if (typeof taskId !== 'string' || !TASK_ID_REGEX.test(taskId)) {
      throw new ArtifactError('invalid_task_id');
    }
  }
}

// Conservative MIME detection by extension. We don't sniff magic
// bytes — the X-Content-Type-Options: nosniff header on the download
// response makes that unnecessary for security.
function detectMediaType(name) {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case '.txt': case '.log': return 'text/plain; charset=utf-8';
    case '.md':  return 'text/markdown; charset=utf-8';
    case '.json': return 'application/json';
    case '.csv': return 'text/csv; charset=utf-8';
    case '.html': case '.htm': return 'application/octet-stream'; // never inline
    case '.svg': return 'application/octet-stream'; // SVG can carry script
    case '.pdf': return 'application/pdf';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.xml': return 'application/xml';
    case '.yaml': case '.yml': return 'application/yaml';
    case '.zip': return 'application/zip';
    case '.tar': return 'application/x-tar';
    case '.gz': return 'application/gzip';
    default: return 'application/octet-stream';
  }
}

module.exports = {
  GatewayArtifactStore,
  ArtifactError,
  TASK_ID_REGEX,
  DEFAULT_ROOT,
  detectMediaType,
};
