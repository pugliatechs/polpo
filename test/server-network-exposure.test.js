'use strict';

// End to end: who can reach a running polpo server, and under which Host.
// HOME points at an empty directory so the server's scanners and config
// files never touch the developer's own ~/.claude or ~/.config/polpo.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-net-test-'));
process.env.HOME = sandboxHome;
delete process.env.POLPO_HOST;
delete process.env.POLPO_ALLOWED_HOSTS;
delete process.env.POLPO_MIND;

const WebSocket = require('ws');
const { createServer } = require('../src/server/index');

const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};

function request(port, { path: urlPath = '/health', host, address = '127.0.0.1', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: address, port, path: urlPath, method: 'GET',
      headers: { ...(host !== undefined ? { host } : {}), ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Resolves with 'open' or the HTTP status that refused the upgrade.
function upgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?role=dashboard`, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (req, res) => { resolve(res.statusCode); req.destroy(); });
    ws.on('error', (err) => { if (!/Unexpected server response/.test(err.message)) reject(err); });
  });
}

after(() => {
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

describe('bind address and authentication', () => {
  // A created server starts its session scanners even before listening.
  const created = [];
  const make = (opts) => { const srv = createServer(opts); created.push(srv); return srv; };
  after(async () => { await Promise.all(created.map((srv) => srv.stop())); });

  it('listens on loopback by default', () => {
    assert.equal(make({ port: 0 }).host, '127.0.0.1');
  });

  it('refuses a network address without authentication', () => {
    assert.throws(() => createServer({ port: 0, host: '0.0.0.0' }), /Refusing to listen on 0\.0\.0\.0 without authentication/);
    assert.throws(() => createServer({ port: 0, host: '192.168.1.20' }), /Refusing to listen/);
  });

  it('accepts a network address with auth, or with an explicit --auth none', () => {
    assert.doesNotThrow(() => make({ port: 0, host: '0.0.0.0', auth: { token: 'tok' } }));
    assert.doesNotThrow(() => make({ port: 0, host: '0.0.0.0', allowUnauthenticatedNetwork: true }));
  });
});

describe('Host check on a running server', () => {
  let srv;
  let port;

  before(async () => {
    srv = createServer({ port: 0 });
    port = (await quiet(() => srv.start())).port;
  });
  after(async () => { await srv.stop(); });

  it('serves loopback names and literal addresses', async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `192.168.1.20:${port}`]) {
      assert.equal((await request(port, { host })).status, 200, host);
    }
  });

  it('answers 421 to a rebinding name, public routes and the API alike', async () => {
    for (const urlPath of ['/health', '/api/instances', '/', '/auth']) {
      const res = await request(port, { path: urlPath, host: `rebind.attacker.example:${port}` });
      assert.equal(res.status, 421, urlPath);
    }
  });

  it('refuses a WebSocket upgrade under a rebinding name before accepting it', async () => {
    assert.equal(await upgrade(port, { Host: `rebind.attacker.example:${port}` }), 421);
  });

  it('refuses a cross-origin WebSocket upgrade before accepting it', async () => {
    assert.equal(await upgrade(port, { Origin: 'https://evil.example' }), 403);
    assert.equal(await upgrade(port, { Origin: 'not a url' }), 403);
  });

  it('accepts a same-origin WebSocket upgrade and one with no Origin', async () => {
    assert.equal(await upgrade(port, { Origin: `http://127.0.0.1:${port}` }), 'open');
    assert.equal(await upgrade(port, {}), 'open');
  });

  it('lets only the current tunnel name through', async () => {
    const name = 'random-words.trycloudflare.com';
    assert.equal((await request(port, { host: name })).status, 421);
    srv.setTunnelInfo({ url: `https://${name}`, provider: 'cloudflared' });
    assert.equal((await request(port, { host: name })).status, 200);
    srv.setTunnelInfo({ url: 'https://other-words.trycloudflare.com', provider: 'cloudflared' });
    assert.equal((await request(port, { host: name })).status, 421);
    srv.setTunnelInfo(null);
    assert.equal((await request(port, { host: 'other-words.trycloudflare.com' })).status, 421);
  });
});

describe('--trust-localhost under DNS rebinding', () => {
  let srv;
  let port;

  before(async () => {
    srv = createServer({ port: 0, auth: { token: 'secret-token', trustLocalhost: true } });
    port = (await quiet(() => srv.start())).port;
  });
  after(async () => { await srv.stop(); });

  it('still opens the API for the desktop browser at localhost', async () => {
    assert.equal((await request(port, { path: '/api/instances', host: `localhost:${port}` })).status, 200);
  });

  it('does not count a loopback connection under a LAN address as the desk', async () => {
    assert.equal((await request(port, { path: '/api/instances', host: `192.168.1.20:${port}` })).status, 401);
  });

  it('gives a rebinding page neither the API nor the WebSocket', async () => {
    assert.equal((await request(port, { path: '/api/instances', host: `rebind.attacker.example:${port}` })).status, 421);
    assert.equal(await upgrade(port, { Host: `rebind.attacker.example:${port}` }), 421);
  });
});

describe('a single network address also listens on loopback', () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .find((n) => n && n.family === 'IPv4' && !n.internal);

  it('serves polpo\'s own sessions on 127.0.0.1 beside the LAN address', { skip: !lan && 'no LAN interface on this host' }, async () => {
    const srv = createServer({ port: 0, host: lan.address, auth: { token: 'tok' } });
    const { port } = await quiet(() => srv.start());
    try {
      assert.equal((await request(port, { address: lan.address })).status, 200);
      assert.equal((await request(port, { address: '127.0.0.1' })).status, 200);
    } finally {
      await srv.stop();
    }
  });
});

describe('polpo server command line', () => {
  const bin = path.join(__dirname, '..', 'bin', 'polpo.js');
  const run = (...args) => spawnSync(process.execPath, [bin, 'server', ...args], {
    env: { ...process.env, HOME: sandboxHome },
    encoding: 'utf8',
    timeout: 15000,
  });

  it('refuses --trust-localhost with the ssh tunnel', () => {
    const res = run('--tunnel', 'ssh', '--tunnel-host', 'user@example.invalid', '--trust-localhost');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--trust-localhost cannot be used with --tunnel ssh/);
  });

  it('refuses a network address without --auth', () => {
    const res = run('--host', '0.0.0.0', '--port', '0');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Refusing to listen on 0\.0\.0\.0 without authentication/);
  });

  it('refuses a malformed --allowed-hosts entry', () => {
    const res = run('--allowed-hosts', 'good.example,bad name', '--port', '0');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Invalid allowed host/);
  });
});
