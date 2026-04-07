/**
 * Anthropic OAuth 2.0 with PKCE — authorize, exchange, refresh.
 *
 * Ported from moltbot/extensions/auth-renew/src/oauth.ts.
 * Used to renew Claude API tokens directly from Telegram.
 */

const crypto = require('crypto');

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const SCOPES = 'org:create_api_key user:profile user:inference';

// Detect pasted callback URLs (both old and new domains)
var CALLBACK_URL_PATTERN =
  /https:\/\/(?:console\.anthropic\.com|platform\.claude\.com)\/oauth\/code\/callback\?[^\s]*/;

// Detect raw authorization codes (20+ alphanumeric chars, optionally with #state)
var RAW_CODE_PATTERN = /^[A-Za-z0-9_-]{20,}(#[A-Za-z0-9_-]+)?$/;

function base64UrlEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Generate a PKCE verifier (32 random bytes, base64url).
 */
function generatePKCEVerifier() {
  return base64UrlEncode(crypto.randomBytes(32));
}

/**
 * Generate PKCE challenge from verifier (SHA-256, base64url).
 */
function generatePKCEChallenge(verifier) {
  var hash = crypto.createHash('sha256').update(verifier).digest();
  return base64UrlEncode(hash);
}

/**
 * Build the Anthropic OAuth authorization URL.
 * @param {string} verifier - PKCE verifier
 * @returns {string} Full authorization URL
 */
function buildAuthURL(verifier) {
  var challenge = generatePKCEChallenge(verifier);
  var url = new URL(AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', verifier);
  return url.toString();
}

/**
 * Parse a callback URL to extract code and state.
 * @param {string} text - Text that may contain a callback URL
 * @returns {{ code: string, state: string } | null}
 */
function parseCallbackURL(text) {
  var match = text.match(CALLBACK_URL_PATTERN);
  if (!match) return null;
  try {
    var url = new URL(match[0]);
    var code = url.searchParams.get('code');
    var state = url.searchParams.get('state');
    if (code && state) return { code: code, state: state };
  } catch {
    // Invalid URL
  }
  return null;
}

/**
 * Parse a raw code string that may contain state after #.
 * @param {string} text - "code" or "code#state"
 * @returns {{ code: string, state?: string }}
 */
function parseRawCode(text) {
  var hashIndex = text.indexOf('#');
  if (hashIndex === -1) return { code: text };
  return {
    code: text.substring(0, hashIndex),
    state: text.substring(hashIndex + 1),
  };
}

/**
 * Exchange an authorization code for tokens.
 * @param {string} code
 * @param {string} state
 * @param {string} verifier - PKCE verifier
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number }>}
 */
async function exchangeCode(code, state, verifier) {
  var response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: code,
      state: state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    var body = await response.text();
    throw new Error('Token exchange failed (' + response.status + '): ' + body);
  }

  var data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    // Subtract 5 min buffer so we refresh before actual expiry
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

/**
 * Refresh an access token using a refresh token.
 * @param {string} refreshToken
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number }>}
 */
async function refreshAccessToken(refreshToken) {
  var response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    var body = await response.text();
    throw new Error('Token refresh failed (' + response.status + '): ' + body);
  }

  var data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

module.exports = {
  generatePKCEVerifier,
  generatePKCEChallenge,
  buildAuthURL,
  parseCallbackURL,
  parseRawCode,
  exchangeCode,
  refreshAccessToken,
  CALLBACK_URL_PATTERN,
  RAW_CODE_PATTERN,
};
