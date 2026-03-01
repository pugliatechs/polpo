const http = require('http');
const express = require('express');
const path = require('path');
const InstanceManager = require('./instances');
const { createApiRouter } = require('./api');
const { setupWebSocket } = require('./websocket');
const {
  AuthState,
  createAuthMiddleware,
  createStaticAuthMiddleware,
  validateSession,
  createSession,
  setSessionCookie,
  verifyPin,
  verifyTotp,
} = require('./auth');

/**
 * Simple in-memory rate limiter.
 * @param {number} windowMs - Time window in milliseconds
 * @param {number} max      - Max requests per window per IP
 */
function rateLimit(windowMs, max) {
  const hits = new Map(); // ip -> { count, resetAt }
  // Periodic cleanup to prevent memory leak
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (now > entry.resetAt) hits.delete(ip);
    }
  }, windowMs * 2);
  cleanup.unref();

  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress;
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.set('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}

function createServer(options = {}) {
  const port = options.port || process.env.POLPO_PORT || 7890;
  const host = options.host || process.env.POLPO_HOST || '0.0.0.0';
  const verbose = options.verbose || false;

  // Auth state — can be updated after creation (e.g. after tunnel starts)
  const authState = new AuthState(options.auth || {});
  const getAuthState = () => authState;

  const app = express();
  const server = http.createServer(app);
  const instanceManager = new InstanceManager();

  app.use(express.json({ limit: '15mb' }));

  // CSRF protection: block cross-origin requests to API endpoints.
  // Browsers send Origin or Referer headers on cross-origin requests.
  // A malicious page at evil.com fetching http://localhost:7890/api/* will
  // be blocked because its Origin won't match the Host header.
  app.use('/api', (req, res, next) => {
    const origin = req.headers['origin'];
    if (origin) {
      const host = req.headers['host'];
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          return res.status(403).json({ error: 'Cross-origin request blocked' });
        }
      } catch {
        return res.status(403).json({ error: 'Invalid origin' });
      }
    }
    next();
  });

  // --- Public routes (before auth) ---

  // Health check
  app.get('/health', (req, res) => {
    const { version: pkgVersion } = require('../../package.json');
    res.json({ status: 'ok', version: pkgVersion, instances: instanceManager.getAll().length });
  });

  // Auth page and its assets (served to unauthenticated users)
  app.get('/auth.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'web', 'auth.html'));
  });
  app.get('/auth', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'web', 'auth.html'));
  });
  app.get('/logo-96.png', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'web', 'logo-96.png'));
  });
  app.get('/favicon.png', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'web', 'favicon.png'));
  });
  // PWA assets — must be served before auth middleware
  app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'web', 'manifest.json'));
  });
  app.get('/sw.js', (req, res) => {
    const { version } = require('../../package.json');
    const swPath = path.join(__dirname, '..', 'web', 'sw.js');
    const swContent = require('fs').readFileSync(swPath, 'utf8')
      .replace('__POLPO_VERSION__', version);
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(swContent);
  });
  app.get('/icon-192.png', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'web', 'icon-192.png'));
  });
  app.get('/icon-512.png', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'web', 'icon-512.png'));
  });
  app.get('/apple-touch-icon.png', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'web', 'apple-touch-icon.png'));
  });

  // Rate limit MFA verification: 10 attempts per minute
  const mfaLimiter = rateLimit(60 * 1000, 10);

  // PIN verification
  app.post('/api/auth/verify-pin', mfaLimiter, (req, res) => {
    if (!authState.mfaEnabled || authState.mode !== 'pin') {
      return res.status(400).json({ error: 'PIN auth not enabled' });
    }
    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Missing code' });
    }
    const result = verifyPin(authState, code);
    if (result.valid) {
      const sessionId = createSession(authState);
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      setSessionCookie(res, sessionId, secure);
      return res.json({ success: true });
    }
    const response = { success: false, error: 'Invalid PIN' };
    if (result.regenerated) {
      response.regenerated = true;
      response.error = 'Too many attempts. Check terminal for new PIN.';
    }
    res.status(403).json(response);
  });

  // TOTP verification
  app.post('/api/auth/verify-totp', mfaLimiter, (req, res) => {
    if (!authState.mfaEnabled || authState.mode !== 'paranoid') {
      return res.status(400).json({ error: 'TOTP auth not enabled' });
    }
    const { code } = req.body;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Missing code' });
    }
    if (verifyTotp(authState.totpSecret, code)) {
      const sessionId = createSession(authState);
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      setSessionCookie(res, sessionId, secure);
      return res.json({ success: true });
    }
    res.status(403).json({ success: false, error: 'Invalid code' });
  });

  // --- Auth middleware ---

  // Static files — redirects to auth page if MFA needed
  app.use(createStaticAuthMiddleware(getAuthState));

  // Serve mobile web UI
  app.use(express.static(path.join(__dirname, '..', 'web')));

  // API auth
  app.use('/api', createAuthMiddleware(getAuthState));

  // Rate limit session creation/resume: 10 per minute
  const sessionLimiter = rateLimit(60 * 1000, 10);
  app.post('/api/sessions/new', sessionLimiter);
  app.post('/api/sessions/:sessionId/resume', sessionLimiter);
  app.post('/api/instances/:id/takeover', sessionLimiter);

  // Rate limit uploads: 30 per minute
  app.post('/api/upload', rateLimit(60 * 1000, 30));

  // API routes
  app.use('/api', createApiRouter(instanceManager, getAuthState));

  // SPA fallback — serve index.html for non-API routes
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(__dirname, '..', 'web', 'index.html'));
    }
  });

  // WebSocket
  const wss = setupWebSocket(server, instanceManager, getAuthState);

  if (verbose) {
    instanceManager.on('instance:registered', (inst) => {
      console.log(`[polpo] Instance registered: ${inst.name} (${inst.id})`);
    });
    instanceManager.on('instance:disconnected', (inst) => {
      console.log(`[polpo] Instance disconnected: ${inst.name} (${inst.id})`);
    });
    instanceManager.on('instance:status', ({ id, status }) => {
      console.log(`[polpo] Instance ${id} -> ${status}`);
    });
  }

  return {
    start() {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          const { version: pkgVersion } = require('../../package.json');
          console.log(`\n  🐙 Polpo v${pkgVersion} running on http://${host}:${addr.port}`);
          console.log(`     Open this URL on your phone (same network)\n`);
          resolve(addr);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (wss.scanner) wss.scanner.stop();
        if (wss.geminiScanner) wss.geminiScanner.stop();
        if (wss.opencodeScanner) wss.opencodeScanner.stop();
        if (wss.piScanner) wss.piScanner.stop();
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close();
        server.close(resolve);
      });
    },
    setAuth({ token, mode, totpSecret }) {
      if (token !== undefined) authState.token = token;
      if (mode !== undefined) authState.mode = mode;
      if (totpSecret !== undefined) authState.totpSecret = totpSecret;
    },
    get authState() {
      return authState;
    },
    instanceManager,
    server,
  };
}

module.exports = { createServer };
