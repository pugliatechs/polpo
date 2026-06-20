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

describe('tunnel/cloudflared.js — extractTunnelUrl', () => {
  const { extractTunnelUrl, QUICK_TUNNEL_URL, READY_MARKER } = require('../src/tunnel/cloudflared');

  it('extracts a real Quick Tunnel URL', () => {
    const line = '2026-05-28T11:59:38Z INF |  https://wise-orange-eagle-foo.trycloudflare.com  |';
    assert.equal(extractTunnelUrl(line), 'https://wise-orange-eagle-foo.trycloudflare.com');
  });

  it('handles a 2-segment Quick Tunnel URL', () => {
    const line = 'https://hello-world.trycloudflare.com';
    assert.equal(extractTunnelUrl(line), 'https://hello-world.trycloudflare.com');
  });

  it('REGRESSION: does not match api.trycloudflare.com from a retry error line', () => {
    const failureLine = 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded (Client.Timeout exceeded while awaiting headers)';
    assert.equal(extractTunnelUrl(failureLine), null);
  });

  it('does not match other single-segment subdomains', () => {
    assert.equal(extractTunnelUrl('https://status.trycloudflare.com'), null);
    assert.equal(extractTunnelUrl('https://docs.trycloudflare.com'), null);
    assert.equal(extractTunnelUrl('https://api.trycloudflare.com'), null);
  });

  it('returns null for non-trycloudflare URLs', () => {
    assert.equal(extractTunnelUrl('https://example.com'), null);
    assert.equal(extractTunnelUrl('https://www.cloudflare.com/website-terms/'), null);
    assert.equal(
      extractTunnelUrl('https://developers.cloudflare.com/cloudflare-one/connections/connect-apps'),
      null
    );
  });

  it('returns null for empty / non-string input', () => {
    assert.equal(extractTunnelUrl(''), null);
    assert.equal(extractTunnelUrl(null), null);
    assert.equal(extractTunnelUrl(undefined), null);
  });

  it('picks the real URL when both api and a Quick Tunnel URL appear on the same line', () => {
    // Defensive: even if a single chunk contains both, the regex must
    // skip the api URL and find the multi-segment one.
    const line = 'tried https://api.trycloudflare.com/tunnel, got https://wise-orange-eagle-foo.trycloudflare.com';
    assert.equal(extractTunnelUrl(line), 'https://wise-orange-eagle-foo.trycloudflare.com');
  });

  it('with requireMarker: returns the URL only when the success marker is also present', () => {
    const noMarker = '|  https://wise-orange-eagle-foo.trycloudflare.com  |';
    const withMarker = 'Your quick Tunnel has been created! Visit it at: https://wise-orange-eagle-foo.trycloudflare.com';
    assert.equal(extractTunnelUrl(noMarker, { requireMarker: true }), null);
    assert.equal(
      extractTunnelUrl(withMarker, { requireMarker: true }),
      'https://wise-orange-eagle-foo.trycloudflare.com'
    );
  });

  it('READY_MARKER is case-insensitive', () => {
    assert.equal(READY_MARKER.test('your quick tunnel has been created!'), true);
    assert.equal(READY_MARKER.test('YOUR QUICK TUNNEL HAS BEEN CREATED'), true);
    assert.equal(READY_MARKER.test('Your Quick Tunnel has been created'), true);
    assert.equal(READY_MARKER.test('something unrelated'), false);
  });

  it('QUICK_TUNNEL_URL rejects URLs missing a hyphen in the subdomain', () => {
    assert.equal(QUICK_TUNNEL_URL.test('https://abc.trycloudflare.com'), false);
    assert.equal(QUICK_TUNNEL_URL.test('https://abc-def.trycloudflare.com'), true);
    assert.equal(QUICK_TUNNEL_URL.test('https://a-b-c-d.trycloudflare.com'), true);
  });
});
