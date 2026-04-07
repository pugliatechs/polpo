/**
 * Background token health monitor — checks Anthropic OAuth token expiry,
 * auto-refreshes when possible, sends Telegram alerts when manual renewal needed.
 *
 * Ported from moltbot/extensions/auth-renew/src/token-monitor.ts.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { refreshAccessToken, generatePKCEVerifier, buildAuthURL } = require('./oauth');
const { setPendingFlow, clearExpired } = require('./state');

var currentTokens = null;

/**
 * Store tokens in all required locations.
 * @param {{ accessToken: string, refreshToken: string, expiresAt: number }} tokens
 */
function setCurrentTokens(tokens) {
  currentTokens = tokens;

  // Update env so agent picks up the new token immediately
  process.env.ANTHROPIC_OAUTH_TOKEN = tokens.accessToken;

  // Write to Claude CLI credentials file
  try {
    var claudeDir = path.join(os.homedir(), '.claude');
    var credsPath = path.join(claudeDir, '.credentials.json');
    var creds = {
      claudeAiOauth: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: [
          'user:inference',
          'user:sessions:claude_code',
          'user:profile',
          'user:mcp_servers',
          'user:file_upload',
        ],
        subscriptionType: 'max',
      },
    };
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
  } catch {
    // Non-critical: Claude CLI may not be present
  }
}

/**
 * Get the current in-memory tokens (or null).
 */
function getCurrentTokens() {
  return currentTokens;
}

/**
 * Load tokens from Claude CLI credentials file if not in memory.
 */
function loadTokensFromDisk() {
  if (currentTokens) return currentTokens;

  try {
    var credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (fs.existsSync(credsPath)) {
      var raw = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      var oauth = raw.claudeAiOauth;
      if (oauth && oauth.accessToken && oauth.expiresAt) {
        currentTokens = {
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken || '',
          expiresAt: oauth.expiresAt,
        };
        return currentTokens;
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

function formatTimeRemaining(ms) {
  if (ms <= 0) return 'expired';
  var minutes = Math.floor(ms / 60000);
  var hours = Math.floor(minutes / 60);
  if (hours > 0) return hours + 'h ' + (minutes % 60) + 'm';
  return minutes + 'm';
}

/**
 * Token health monitor.
 *
 * @param {object} config
 * @param {number} config.checkIntervalMinutes
 * @param {number} config.expiryBufferMinutes
 * @param {boolean} config.autoRefresh
 * @param {function} config.onExpiring - Called when token needs manual renewal: (authUrl) => void
 * @param {function} config.onRefreshed - Called after successful auto-refresh: (tokens) => void
 * @param {function} config.onError - Called on errors: (err) => void
 */
class TokenMonitor {
  constructor(config) {
    this.checkIntervalMinutes = config.checkIntervalMinutes || 5;
    this.expiryBufferMinutes = config.expiryBufferMinutes || 15;
    this.autoRefresh = config.autoRefresh !== false;
    this.onExpiring = config.onExpiring || function () {};
    this.onRefreshed = config.onRefreshed || function () {};
    this.onError = config.onError || function () {};
    this._interval = null;
    this._initialTimeout = null;
  }

  start() {
    var self = this;
    var intervalMs = this.checkIntervalMinutes * 60 * 1000;

    // Initial check after 10 seconds (let services settle)
    this._initialTimeout = setTimeout(function () {
      self._check();
    }, 10000);

    // Periodic check
    this._interval = setInterval(function () {
      self._check();
    }, intervalMs);

    console.log('[pa-auth] Token monitor started (interval: ' +
      this.checkIntervalMinutes + 'm, buffer: ' + this.expiryBufferMinutes + 'm)');
  }

  stop() {
    if (this._initialTimeout) {
      clearTimeout(this._initialTimeout);
      this._initialTimeout = null;
    }
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  async _check() {
    try {
      clearExpired();

      var tokens = loadTokensFromDisk();
      if (!tokens) {
        // No token found — user hasn't authenticated yet
        return;
      }

      var now = Date.now();
      var expiresIn = tokens.expiresAt - now;
      var bufferMs = this.expiryBufferMinutes * 60 * 1000;

      // Token still healthy
      if (expiresIn > bufferMs) {
        return;
      }

      // Token expiring soon or expired — try auto-refresh
      console.log('[pa-auth] Token ' +
        (expiresIn <= 0 ? 'EXPIRED' : 'expiring in ' + formatTimeRemaining(expiresIn)));

      if (this.autoRefresh && tokens.refreshToken) {
        try {
          var newTokens = await refreshAccessToken(tokens.refreshToken);
          setCurrentTokens(newTokens);
          console.log('[pa-auth] Token refreshed, new expiry in ' +
            formatTimeRemaining(newTokens.expiresAt - Date.now()));
          this.onRefreshed(newTokens);
          return;
        } catch (err) {
          console.error('[pa-auth] Auto-refresh failed:', err.message);
        }
      }

      // Auto-refresh failed or unavailable — send renewal link
      var verifier = generatePKCEVerifier();
      var authUrl = buildAuthURL(verifier);
      setPendingFlow('service', verifier);
      this.onExpiring(authUrl);
    } catch (err) {
      this.onError(err);
    }
  }
}

module.exports = {
  TokenMonitor,
  setCurrentTokens,
  getCurrentTokens,
  loadTokensFromDisk,
  formatTimeRemaining,
};
