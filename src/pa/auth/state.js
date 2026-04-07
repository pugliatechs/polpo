/**
 * Pending OAuth flow state — in-memory store with 10-minute expiry.
 *
 * Ported from moltbot/extensions/auth-renew/src/state.ts.
 * Tracks PKCE verifiers for ongoing OAuth flows, keyed by sender ID.
 */

var EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

var pendingFlows = new Map();

/**
 * Store a pending OAuth flow.
 * @param {string} key - Sender ID, or "service" for timer-initiated flows
 * @param {string} verifier - PKCE verifier
 */
function setPendingFlow(key, verifier) {
  pendingFlows.set(key, { verifier: verifier, timestamp: Date.now() });
}

/**
 * Look up and consume a verifier by state value.
 * The state param in the OAuth callback equals the verifier.
 * @param {string} state
 * @returns {string|null} The verifier, or null if not found/expired
 */
function getPendingVerifier(state) {
  for (var entry of pendingFlows) {
    var key = entry[0];
    var flow = entry[1];
    if (flow.verifier === state) {
      if (Date.now() - flow.timestamp > EXPIRY_MS) {
        pendingFlows.delete(key);
        return null;
      }
      pendingFlows.delete(key);
      return flow.verifier;
    }
  }
  return null;
}

/**
 * Get the most recent pending flow's verifier.
 * Used when the user pastes just the code (no state in URL).
 * @returns {string|null}
 */
function getMostRecentVerifier() {
  clearExpired();

  var mostRecent = null;
  var mostRecentKey = null;

  for (var entry of pendingFlows) {
    var key = entry[0];
    var flow = entry[1];
    if (!mostRecent || flow.timestamp > mostRecent.timestamp) {
      mostRecent = flow;
      mostRecentKey = key;
    }
  }

  if (mostRecent && mostRecentKey) {
    pendingFlows.delete(mostRecentKey);
    return mostRecent.verifier;
  }

  return null;
}

/**
 * Remove all expired pending flows.
 */
function clearExpired() {
  var now = Date.now();
  for (var entry of pendingFlows) {
    if (now - entry[1].timestamp > EXPIRY_MS) {
      pendingFlows.delete(entry[0]);
    }
  }
}

/**
 * Get the number of pending flows (for testing).
 */
function size() {
  return pendingFlows.size;
}

/**
 * Clear all pending flows (for testing).
 */
function clear() {
  pendingFlows.clear();
}

module.exports = {
  setPendingFlow,
  getPendingVerifier,
  getMostRecentVerifier,
  clearExpired,
  size,
  clear,
  EXPIRY_MS,
};
