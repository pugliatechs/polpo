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

  // --- Public routes (before auth) ---

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', instances: instanceManager.getAll().length });
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

  // PIN verification
  app.post('/api/auth/verify-pin', (req, res) => {
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
  app.post('/api/auth/verify-totp', (req, res) => {
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
          console.log(`\n  🐙 Polpo server running on http://${host}:${addr.port}`);
          console.log(`     Open this URL on your phone (same network)\n`);
          resolve(addr);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (wss.scanner) wss.scanner.stop();
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
