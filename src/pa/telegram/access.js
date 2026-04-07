/**
 * Telegram access control — allowlist check by user ID or username.
 */

/**
 * Check if a Telegram sender is allowed.
 * @param {object} from - Telegram user object (ctx.from)
 * @param {Array<number|string>} allowFrom - Allowed user IDs or usernames
 * @returns {boolean}
 */
function isSenderAllowed(from, allowFrom) {
  if (!from) return false;

  // Empty allowlist means deny all
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) return false;

  for (var i = 0; i < allowFrom.length; i++) {
    var entry = allowFrom[i];

    // Wildcard: allow everyone
    if (entry === '*') return true;

    // Numeric: match user ID
    if (typeof entry === 'number' && from.id === entry) return true;

    // String numeric: match user ID
    if (typeof entry === 'string' && /^\d+$/.test(entry) && from.id === Number(entry)) return true;

    // String: match username (case-insensitive, strip leading @)
    if (typeof entry === 'string' && from.username) {
      var normalized = entry.replace(/^@/, '').toLowerCase();
      if (from.username.toLowerCase() === normalized) return true;
    }
  }

  return false;
}

module.exports = { isSenderAllowed };
