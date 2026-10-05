const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOutputTail, failureLine, cleanLine } = require('../src/tunnel/output-tail');

/**
 * Why a tunnel failed to start.
 *
 * A tunnel binary that dies during startup explains itself on its output,
 * and polpo used to throw that away. With a VPN intercepting the
 * connection, all the log said was "cloudflared exited with code 1".
 */

// What cloudflared actually printed when a VPN blocked its API call.
const CLOUDFLARED_VPN_OUTPUT = [
  '2026-09-24T13:14:11Z INF Thank you for trying Cloudflare Tunnel.',
  '2026-09-24T13:14:11Z INF Requesting new quick Tunnel on trycloudflare.com...',
  'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
].join('\n');

describe('failureLine', () => {
  it('picks the line that reports the failure', () => {
    assert.match(failureLine(CLOUDFLARED_VPN_OUTPUT), /^failed to request quick Tunnel: .*context deadline exceeded/);
  });

  it('prefers the last failure over later chatter', () => {
    const out = 'INF starting\nERR connection refused\nINF shutting down\n';
    assert.equal(failureLine(out), 'ERR connection refused');
  });

  it('falls back to the last line when nothing says "failed"', () => {
    assert.equal(failureLine('one\ntwo\nthree\n'), 'three');
  });

  it('strips a leading timestamp', () => {
    assert.equal(failureLine('2026-09-24T13:14:11Z ERR boom'), 'ERR boom');
  });

  it('renders a JSON log line as "msg: err"', () => {
    const ngrok = JSON.stringify({ lvl: 'eror', msg: 'session closed', err: 'authentication failed: invalid authtoken' });
    assert.equal(failureLine(ngrok), 'session closed: authentication failed: invalid authtoken');
  });

  it('returns nothing for empty output', () => {
    assert.equal(failureLine(''), '');
    assert.equal(failureLine('\n\n'), '');
  });

  it('removes terminal escapes and control characters', () => {
    assert.equal(cleanLine('\x1b[31mERR\x1b[0m bad\x07'), 'ERR bad');
  });

  it('caps a very long line', () => {
    assert.ok(cleanLine('x'.repeat(5000)).length <= 300);
  });
});

describe('createOutputTail', () => {
  it('formats the hint to append to an error message', () => {
    const t = createOutputTail();
    t.push(Buffer.from(CLOUDFLARED_VPN_OUTPUT));
    assert.match(t.hint(), /^: failed to request quick Tunnel/);
  });

  it('gives an empty hint when nothing was printed', () => {
    assert.equal(createOutputTail().hint(), '');
  });

  it('keeps only the end of a long output', () => {
    const t = createOutputTail(100);
    t.push('ERR early failure\n' + 'filler line\n'.repeat(50) + 'last line');
    assert.equal(t.hint(), ': last line', 'the early line has been dropped');
  });
});

// Real provider code, driven by fake binaries on PATH, so the tests cover
// what actually reaches the error message rather than the helper alone.
describe('providers report why they failed to start', () => {
  let binDir;
  const savedPath = process.env.PATH;

  function fakeBinary(name, script) {
    const p = path.join(binDir, name);
    fs.writeFileSync(p, '#!/bin/sh\n' + script + '\n', { mode: 0o755 });
  }

  before(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-fake-bin-'));
    process.env.PATH = binDir + path.delimiter + savedPath;
  });

  after(() => {
    process.env.PATH = savedPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it('cloudflared', async () => {
    const out = path.join(binDir, 'cloudflared.out');
    fs.writeFileSync(out, CLOUDFLARED_VPN_OUTPUT + '\n');
    fakeBinary('cloudflared', `cat "${out}" >&2; exit 1`);
    const { start } = require('../src/tunnel/cloudflared');
    await assert.rejects(
      () => start(1),
      /cloudflared exited with code 1: failed to request quick Tunnel: .*context deadline exceeded/
    );
  });

  it('ngrok', async () => {
    fakeBinary('ngrok',
      `echo '{"lvl":"eror","msg":"session closed","err":"authentication failed: invalid authtoken"}'; exit 1`);
    const { start } = require('../src/tunnel/ngrok');
    await assert.rejects(
      () => start(1),
      /ngrok exited with code 1: session closed: authentication failed: invalid authtoken/
    );
  });

  it('ssh', async () => {
    fakeBinary('ssh', `echo "ssh: connect to host example.invalid port 22: Connection refused" >&2; exit 255`);
    const { start } = require('../src/tunnel/ssh');
    await assert.rejects(
      () => start(1, { tunnelHost: 'user@example.invalid' }),
      /ssh exited with code 255: ssh: connect to host example\.invalid port 22: Connection refused/
    );
  });
});

describe('cloudflared health check', () => {
  const http = require('http');
  const { checkReady } = require('../src/tunnel/cloudflared');

  // A stand-in for cloudflared's metrics server.
  function metricsServer(status, body) {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        srv.hits = (srv.hits || 0) + 1;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body);
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
  }
  const addr = (srv) => '127.0.0.1:' + srv.address().port;

  it('reads a connected tunnel', async () => {
    const srv = await metricsServer(200, '{"status":200,"readyConnections":2}');
    try { assert.deepEqual(await checkReady(addr(srv)), { readyConnections: 2 }); }
    finally { srv.close(); }
  });

  it('reads a disconnected tunnel from the 503 cloudflared returns', async () => {
    const srv = await metricsServer(503, '{"status":503,"readyConnections":0}');
    try { assert.deepEqual(await checkReady(addr(srv)), { readyConnections: 0 }); }
    finally { srv.close(); }
  });

  it('reports unknown, not disconnected, for anything it cannot read', async () => {
    for (const body of ['not json', '{}', '{"readyConnections":-1}', '{"readyConnections":"1"}']) {
      const srv = await metricsServer(200, body);
      try { assert.equal(await checkReady(addr(srv)), null, body); }
      finally { srv.close(); }
    }
    assert.equal(await checkReady('127.0.0.1:1'), null, 'nothing listening');
    assert.equal(await checkReady(null), null, 'no address known');
  });

  describe('through the real provider', () => {
    let binDir;
    const savedPath = process.env.PATH;
    before(() => {
      binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-fake-cf-'));
      process.env.PATH = binDir + path.delimiter + savedPath;
    });
    after(() => {
      process.env.PATH = savedPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    });

    function fakeCloudflared(metricsLine) {
      fs.writeFileSync(path.join(binDir, 'cloudflared'), [
        '#!/bin/sh',
        `echo '${metricsLine}' >&2`,
        `echo 'INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |' >&2`,
        `echo 'INF |  https://fake-health-check.trycloudflare.com  |' >&2`,
        'exec sleep 30',
      ].join('\n') + '\n', { mode: 0o755 });
    }

    it('finds the metrics server from cloudflared\'s own output', async () => {
      const srv = await metricsServer(503, '{"readyConnections":0}');
      fakeCloudflared('2026-10-05T20:57:58Z INF Starting metrics server on ' + addr(srv) + '/metrics');
      const { start } = require('../src/tunnel/cloudflared');
      const handle = await start(1);
      try {
        assert.equal(handle.url, 'https://fake-health-check.trycloudflare.com');
        assert.deepEqual(await handle.health(), { readyConnections: 0 });
      } finally {
        handle.close();
        srv.close();
      }
    });

    it('never queries a metrics address that is not loopback', async () => {
      const srv = await metricsServer(200, '{"readyConnections":1}');
      fakeCloudflared('INF Starting metrics server on 10.20.30.40:' + srv.address().port + '/metrics');
      const { start } = require('../src/tunnel/cloudflared');
      const handle = await start(1);
      try {
        assert.equal(await handle.health(), null);
        assert.equal(srv.hits || 0, 0);
      } finally {
        handle.close();
        srv.close();
      }
    });
  });
});
