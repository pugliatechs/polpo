/**
 * Shared upload constants — the single source of truth for both the
 * dashboard upload (POST /api/upload) and the gateway upload
 * (POST /v1/uploads). Centralising these keeps the security
 * properties (path roots, inline-safe MIME whitelist, byte caps)
 * from drifting between surfaces.
 *
 * Boundary owners:
 *   - UPLOAD_DIR is the ONLY directory WrappedAgent will read
 *     attachments from (see src/agent/wrapped.js, _buildContent path
 *     check). Adding a second trusted directory weakens that
 *     invariant; instead, the gateway copies files from its private
 *     gateway-uploads dir INTO UPLOAD_DIR with a task-scoped name.
 *   - SAFE_INLINE_IMAGE_EXTS controls when a downloaded file may be
 *     served inline. Anything outside this set must be served as
 *     Content-Disposition: attachment with X-Content-Type-Options:
 *     nosniff to prevent stored XSS via uploaded HTML/SVG.
 */

const path = require('path');
const os = require('os');

// Where WrappedAgent reads attachments from. Do not add siblings.
const UPLOAD_DIR = path.join(os.tmpdir(), 'polpo-uploads');

// Dashboard upload byte cap (decoded). Pre-existing behaviour.
const DASHBOARD_MAX_UPLOAD_SIZE = 10 * 1024 * 1024;

// Gateway upload byte cap (decoded). Bigger than dashboard because
// machine callers may push datasets/PDFs; still bounded so the
// json-body parser stays within RAM budgets.
const GATEWAY_MAX_UPLOAD_SIZE = 25 * 1024 * 1024;

// Maximum gateway JSON body for /v1/uploads. Includes base64 +
// JSON-escape overhead (~37%) on top of the decoded size. The route
// applies this limit ONLY to itself so other routes stay tight.
const GATEWAY_UPLOAD_BODY_LIMIT = '34mb';

// Per-task aggregate caps (gateway artifacts + uploads). Enforced at
// seal time, not at upload time, since artifacts are produced by the
// agent and may be many small files.
const GATEWAY_TASK_AGGREGATE_BYTES = 100 * 1024 * 1024;
const GATEWAY_TASK_ARTIFACT_MAX_FILES = 100;
const GATEWAY_TASK_ARTIFACT_MAX_FILE_BYTES = 25 * 1024 * 1024;

// Inline-safe image extensions. Used by both surfaces so a future
// addition (e.g. .avif) updates everywhere.
const SAFE_INLINE_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

// Filename character whitelist applied after pre-rejection of `..`,
// path separators, NUL and control chars. Anything outside [A-Za-z0-9._-]
// becomes `_`.
const SAFE_FILENAME_REGEX = /[^a-zA-Z0-9._-]/g;
const SAFE_FILENAME_MAX_LENGTH = 100;

// UploadId shape: matches crypto.randomUUID() exactly, prefixed with `u-`.
// `{8}-{4}-{4}-{4}-{12}` hex groups separated by dashes.
const UPLOAD_ID_REGEX = /^u-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Artifact filename shape (caller-facing, served from sealed/).
// Distinct from SAFE_FILENAME_REGEX above: this one is APPLIED, not REPLACED.
const ARTIFACT_NAME_REGEX = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * Pre-reject filenames that contain path separators, parent refs,
 * NUL bytes, or control characters. Returns true if the name is safe
 * to proceed to the regex-replace step; false otherwise.
 *
 * This is defence-in-depth: the regex replace alone would scrub the
 * dangerous chars to `_`, but rejecting outright surfaces the abuse
 * attempt to logs and stops the caller getting a confusingly renamed
 * file back.
 */
function isUnsafeFilename(name) {
  if (typeof name !== 'string') return true;
  if (name.length === 0 || name.length > 1000) return true;
  if (name.includes('..')) return true;
  if (name.includes('/') || name.includes('\\')) return true;
  // NUL and ASCII control chars (incl. CR/LF)
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function sanitizeFilename(name) {
  return String(name).replace(SAFE_FILENAME_REGEX, '_').slice(0, SAFE_FILENAME_MAX_LENGTH);
}

module.exports = {
  UPLOAD_DIR,
  DASHBOARD_MAX_UPLOAD_SIZE,
  GATEWAY_MAX_UPLOAD_SIZE,
  GATEWAY_UPLOAD_BODY_LIMIT,
  GATEWAY_TASK_AGGREGATE_BYTES,
  GATEWAY_TASK_ARTIFACT_MAX_FILES,
  GATEWAY_TASK_ARTIFACT_MAX_FILE_BYTES,
  SAFE_INLINE_IMAGE_EXTS,
  SAFE_FILENAME_REGEX,
  SAFE_FILENAME_MAX_LENGTH,
  UPLOAD_ID_REGEX,
  ARTIFACT_NAME_REGEX,
  isUnsafeFilename,
  sanitizeFilename,
};
