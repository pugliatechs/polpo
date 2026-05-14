/**
 * Gateway auth — API key management for programmatic callers.
 *
 * Distinct from the dashboard auth (auth.js):
 *   - Dashboard auth is for humans: token + optional PIN/TOTP, session cookies,
 *     burned-after-first-use tokens.
 *   - Gateway auth is for machines: a single long-lived API key, presented as
 *     a Bearer token on every request. No sessions, no MFA.
 *
 * The key is stored at ~/.config/polpo/gateway.json (mode 0o600), generated
 * on first start if missing. Callers can override by setting POLPO_GATEWAY_KEY
 * in the environment.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'polpo', 'gateway.json');

function generateKey() {
  // 256 bits, base64url so it's URL/header-safe without padding
  return crypto.randomBytes(32).toString('base64url');
}

function loadKeyFromFile(configPath) {
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return data && typeof data.key === 'string' ? data.key : null;
  } catch {
    return null;
  }
}

function saveKeyToFile(configPath, key) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = configPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ key }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, configPath);
}

/**
 * Resolve the gateway key with this precedence:
 *   1. options.key (caller override)
 *   2. POLPO_GATEWAY_KEY env var
 *   3. Existing key in configPath
 *   4. Generate, persist, and return a fresh key
 *
 * @param {object} [options]
 * @param {string} [options.key] - explicit override
 * @param {string} [options.configPath] - alternative config path (for tests)
 * @returns {{ key: string, isNew: boolean, source: 'override'|'env'|'file'|'generated' }}
 */
function loadOrCreateGatewayKey(options) {
  options = options || {};
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;

  if (options.key) {
    return { key: options.key, isNew: false, source: 'override' };
  }
  if (process.env.POLPO_GATEWAY_KEY) {
    return { key: process.env.POLPO_GATEWAY_KEY, isNew: false, source: 'env' };
  }
  const existing = loadKeyFromFile(configPath);
  if (existing) {
    return { key: existing, isNew: false, source: 'file' };
  }
  const key = generateKey();
  saveKeyToFile(configPath, key);
  return { key, isNew: true, source: 'generated' };
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function extractBearerToken(req) {
  const header = req.headers && req.headers['authorization'];
  if (typeof header !== 'string') return null;
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

/**
 * Express middleware that requires Bearer <gatewayKey> on every request.
 * @param {() => string} getKey - returns the current expected key
 * @returns {(req, res, next) => void}
 */
function createGatewayAuthMiddleware(getKey) {
  return (req, res, next) => {
    const expected = typeof getKey === 'function' ? getKey() : getKey;
    if (!expected) {
      return res.status(503).json({ error: 'gateway_not_configured' });
    }
    const provided = extractBearerToken(req);
    if (!provided || !timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  generateKey,
  loadKeyFromFile,
  saveKeyToFile,
  loadOrCreateGatewayKey,
  extractBearerToken,
  createGatewayAuthMiddleware,
  timingSafeEqual,
};
