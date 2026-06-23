const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { createApiRouter } = require('../src/server/api');

// Minimal mock InstanceManager — the qr-codes endpoint doesn't touch it
// but createApiRouter requires one.
function noopInstanceManager() {
  return {
    on: () => {}, register: () => ({}), unregister: () => {},
    get: () => null, getAll: () => [], updateStatus: () => {},
    addMessage: () => {}, sendToAgent: () => false, getConversation: () => [],
  };
}

function mountApi({ authState, tunnelInfo }) {
  const app = express();
  // The route uses Express's req.ip / req.connection.remoteAddress, both
  // of which surface 127.0.0.1 for in-process supertest-style calls.
  app.set('trust proxy', false);
  app.use('/api', createApiRouter(
    noopInstanceManager(),
    () => authState,
    null,
    null,
    () => tunnelInfo,
  ));
  return app;
}

function startListening(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      resolve({ srv, port: srv.address().port });
    });
  });
}

function getJson(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port, path: '/api/qr-codes',
      headers: headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
  });
}

describe('GET /api/qr-codes', () => {
  it('returns { available: false, qrs: [] } when trust-localhost is OFF', async () => {
    const app = mountApi({
      authState: {
        trustLocalhost: false,
        token: 'tok',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        mfaEnabled: true,
      },
      tunnelInfo: { url: 'https://x-y-z.trycloudflare.com', provider: 'cloudflared' },
    });
    const { srv, port } = await startListening(app);
    try {
      const { status, body } = await getJson(port);
      assert.equal(status, 200);
      assert.equal(body.available, false);
      assert.deepEqual(body.qrs, []);
    } finally {
      srv.close();
    }
  });

  it('returns nothing when trust-localhost is ON but no QRs are available', async () => {
    const app = mountApi({
      authState: { trustLocalhost: true, token: 'tok' },
      tunnelInfo: null,
    });
    const { srv, port } = await startListening(app);
    try {
      const { status, body } = await getJson(port);
      assert.equal(status, 200);
      assert.equal(body.available, false);
      assert.deepEqual(body.qrs, []);
    } finally {
      srv.close();
    }
  });

  it('returns the TOTP QR when trust-localhost ON + TOTP enabled + paranoid mode', async () => {
    const app = mountApi({
      authState: {
        trustLocalhost: true,
        token: 'tok',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        mfaEnabled: true,
      },
      tunnelInfo: null,
    });
    const { srv, port } = await startListening(app);
    try {
      const { status, body } = await getJson(port);
      assert.equal(status, 200);
      assert.equal(body.available, true);
      assert.equal(body.qrs.length, 1);
      assert.equal(body.qrs[0].kind, 'totp');
      assert.equal(body.qrs[0].label, 'Authenticator');
      assert.match(body.qrs[0].svg, /^<svg/);
    } finally {
      srv.close();
    }
  });

  it('returns the tunnel QR when trust-localhost ON + tunnel active', async () => {
    const app = mountApi({
      authState: { trustLocalhost: true, token: 'tok-xyz' },
      tunnelInfo: { url: 'https://wise-orange-eagle.trycloudflare.com', provider: 'cloudflared' },
    });
    const { srv, port } = await startListening(app);
    try {
      const { status, body } = await getJson(port);
      assert.equal(status, 200);
      assert.equal(body.available, true);
      assert.equal(body.qrs.length, 1);
      assert.equal(body.qrs[0].kind, 'tunnel');
      assert.equal(body.qrs[0].provider, 'cloudflared');
      // URL should be the tunnel URL with token appended
      assert.match(body.qrs[0].url, /^https:\/\/wise-orange-eagle\.trycloudflare\.com\?token=tok-xyz$/);
      assert.match(body.qrs[0].svg, /^<svg/);
    } finally {
      srv.close();
    }
  });

  it('returns BOTH QRs in stable order when both are available', async () => {
    const app = mountApi({
      authState: {
        trustLocalhost: true,
        token: 'tok',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        mfaEnabled: true,
      },
      tunnelInfo: { url: 'https://x.trycloudflare.com', provider: 'cloudflared' },
    });
    const { srv, port } = await startListening(app);
    try {
      const { status, body } = await getJson(port);
      assert.equal(status, 200);
      assert.equal(body.qrs.length, 2);
      // TOTP first (so the user sets it up before scanning the tunnel)
      assert.equal(body.qrs[0].kind, 'totp');
      assert.equal(body.qrs[1].kind, 'tunnel');
    } finally {
      srv.close();
    }
  });

  it('omits the tunnel QR if tunnelInfo.url is falsy (cleared)', async () => {
    const app = mountApi({
      authState: { trustLocalhost: true, token: 'tok' },
      tunnelInfo: { url: '', provider: null },
    });
    const { srv, port } = await startListening(app);
    try {
      const { body } = await getJson(port);
      assert.equal(body.available, false);
      assert.deepEqual(body.qrs, []);
    } finally {
      srv.close();
    }
  });

  it('omits the tunnel QR token when authState.token is null', async () => {
    const app = mountApi({
      authState: { trustLocalhost: true, token: null },
      tunnelInfo: { url: 'https://x.trycloudflare.com' },
    });
    const { srv, port } = await startListening(app);
    try {
      const { body } = await getJson(port);
      const tunnel = body.qrs.find((q) => q.kind === 'tunnel');
      assert.ok(tunnel);
      // No '?token=' appended when there's no token
      assert.equal(tunnel.url, 'https://x.trycloudflare.com');
    } finally {
      srv.close();
    }
  });
});
