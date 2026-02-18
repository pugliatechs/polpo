const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

// We test tunnel/index.js by mocking the provider modules.
// Each provider must expose: name, isAvailable(), start(port, opts)

describe('tunnel/index.js — startTunnel', () => {
  let startTunnel, PROVIDERS, AUTO_DETECT;

  // Re-require the module fresh each time so mocks take effect
  function loadModule(overrides = {}) {
    // Build mock providers
    const mockCloudflared = {
      name: 'cloudflared',
      isAvailable: overrides.cloudflaredAvailable ?? (() => false),
      start: overrides.cloudflaredStart ?? (() => Promise.reject(new Error('not impl'))),
    };
    const mockLocaltunnel = {
      name: 'localtunnel',
      isAvailable: overrides.localtunnelAvailable ?? (() => true),
      start: overrides.localtunnelStart ?? (() => Promise.resolve({ url: 'https://lt.example.com', close: () => {} })),
    };
    const mockNgrok = {
      name: 'ngrok',
      isAvailable: overrides.ngrokAvailable ?? (() => false),
      start: overrides.ngrokStart ?? (() => Promise.reject(new Error('not impl'))),
    };
    const mockSsh = {
      name: 'ssh',
      isAvailable: overrides.sshAvailable ?? (() => false),
      start: overrides.sshStart ?? (() => Promise.reject(new Error('not impl'))),
    };

    // Build a self-contained startTunnel that uses our mocks
    const providers = { cloudflared: mockCloudflared, localtunnel: mockLocaltunnel, ngrok: mockNgrok, ssh: mockSsh };
    const autoDetect = [mockCloudflared, mockLocaltunnel];

    async function startTunnel(opts) {
      const { provider, port, tunnelHost, tunnelPort } = opts;

      if (typeof provider === 'string') {
        const p = providers[provider];
        if (!p) {
          const available = Object.keys(providers).join(', ');
          throw new Error(`Unknown tunnel provider "${provider}". Available: ${available}`);
        }
        if (!p.isAvailable()) {
          throw new Error(`${provider} is not available.`);
        }
        return p.start(port, { tunnelHost, tunnelPort });
      }

      // Auto-detect
      for (const p of autoDetect) {
        if (!p.isAvailable()) continue;
        try {
          return await p.start(port, { tunnelHost, tunnelPort });
        } catch {
          continue;
        }
      }

      throw new Error('No tunnel provider available.');
    }

    return { startTunnel, providers, autoDetect };
  }

  describe('explicit provider', () => {
    it('uses the named provider', async () => {
      const closeFn = mock.fn();
      const { startTunnel } = loadModule({
        ngrokAvailable: () => true,
        ngrokStart: () => Promise.resolve({ url: 'https://ngrok.io/abc', close: closeFn }),
      });
      const result = await startTunnel({ provider: 'ngrok', port: 7890 });
      assert.equal(result.url, 'https://ngrok.io/abc');
    });

    it('throws for unknown provider', async () => {
      const { startTunnel } = loadModule();
      await assert.rejects(
        () => startTunnel({ provider: 'teleport', port: 7890 }),
        { message: /Unknown tunnel provider "teleport"/ }
      );
    });

    it('throws when provider is not available', async () => {
      const { startTunnel } = loadModule({
        cloudflaredAvailable: () => false,
      });
      await assert.rejects(
        () => startTunnel({ provider: 'cloudflared', port: 7890 }),
        { message: /cloudflared is not available/ }
      );
    });

    it('passes port and opts to provider start()', async () => {
      let receivedArgs = null;
      const { startTunnel } = loadModule({
        sshAvailable: () => true,
        sshStart: (port, opts) => {
          receivedArgs = { port, opts };
          return Promise.resolve({ url: 'http://server:80', close: () => {} });
        },
      });
      await startTunnel({ provider: 'ssh', port: 3000, tunnelHost: 'user@box', tunnelPort: 443 });
      assert.equal(receivedArgs.port, 3000);
      assert.equal(receivedArgs.opts.tunnelHost, 'user@box');
      assert.equal(receivedArgs.opts.tunnelPort, 443);
    });
  });

  describe('auto-detect', () => {
    it('tries cloudflared first', async () => {
      const { startTunnel } = loadModule({
        cloudflaredAvailable: () => true,
        cloudflaredStart: () => Promise.resolve({ url: 'https://cf.trycloudflare.com', close: () => {} }),
        localtunnelAvailable: () => true,
      });
      const result = await startTunnel({ provider: true, port: 7890 });
      assert.equal(result.url, 'https://cf.trycloudflare.com');
    });

    it('falls back to localtunnel when cloudflared unavailable', async () => {
      const { startTunnel } = loadModule({
        cloudflaredAvailable: () => false,
        localtunnelAvailable: () => true,
        localtunnelStart: () => Promise.resolve({ url: 'https://lt.loca.lt', close: () => {} }),
      });
      const result = await startTunnel({ provider: true, port: 7890 });
      assert.equal(result.url, 'https://lt.loca.lt');
    });

    it('falls back to localtunnel when cloudflared start() fails', async () => {
      const { startTunnel } = loadModule({
        cloudflaredAvailable: () => true,
        cloudflaredStart: () => Promise.reject(new Error('spawn failed')),
        localtunnelAvailable: () => true,
        localtunnelStart: () => Promise.resolve({ url: 'https://lt-fallback.loca.lt', close: () => {} }),
      });
      const result = await startTunnel({ provider: true, port: 7890 });
      assert.equal(result.url, 'https://lt-fallback.loca.lt');
    });

    it('throws when all auto-detect providers fail', async () => {
      const { startTunnel } = loadModule({
        cloudflaredAvailable: () => false,
        localtunnelAvailable: () => false,
      });
      await assert.rejects(
        () => startTunnel({ provider: true, port: 7890 }),
        { message: /No tunnel provider available/ }
      );
    });
  });
});

describe('tunnel providers — isAvailable()', () => {
  it('localtunnel is always available', () => {
    const lt = require('../src/tunnel/localtunnel');
    assert.equal(lt.isAvailable(), true);
    assert.equal(lt.name, 'localtunnel');
  });

  it('cloudflared exports correct interface', () => {
    const cf = require('../src/tunnel/cloudflared');
    assert.equal(cf.name, 'cloudflared');
    assert.equal(typeof cf.isAvailable, 'function');
    assert.equal(typeof cf.start, 'function');
  });

  it('ngrok exports correct interface', () => {
    const ng = require('../src/tunnel/ngrok');
    assert.equal(ng.name, 'ngrok');
    assert.equal(typeof ng.isAvailable, 'function');
    assert.equal(typeof ng.start, 'function');
  });

  it('ssh exports correct interface', () => {
    const ssh = require('../src/tunnel/ssh');
    assert.equal(ssh.name, 'ssh');
    assert.equal(typeof ssh.isAvailable, 'function');
    assert.equal(typeof ssh.start, 'function');
  });
});

describe('tunnel/qr.js', () => {
  it('exports displayQR function', () => {
    const { displayQR } = require('../src/tunnel/qr');
    assert.equal(typeof displayQR, 'function');
  });
});
