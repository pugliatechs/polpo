/**
 * Coerce whatever timestamp a session source recorded (ISO string,
 * epoch ms, missing, unparseable) into an epoch ms number so callers
 * can compare them uniformly. Unknown / unparseable timestamps become
 * 0 (oldest), keeping them at the bottom of newest-first orderings
 * rather than polluting the top.
 *
 * Extracted from api.js so conversation-search.js can depend on it
 * without creating a circular import.
 */
function normalizeTimestamp(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string' && ts) {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

module.exports = { normalizeTimestamp };
