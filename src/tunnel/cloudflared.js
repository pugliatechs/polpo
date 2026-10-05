const { spawn, execFileSync } = require('child_process');
const http = require('http');
const { createOutputTail } = require('./output-tail');

const name = 'cloudflared';

// Quick Tunnel URLs always have a multi-word hyphenated subdomain
// (e.g. wise-orange-eagle-foo.trycloudflare.com). Requiring at least one
// hyphen here is the load-bearing guard: it prevents us from latching onto
// internal Cloudflare endpoints like https://api.trycloudflare.com that
// cloudflared logs when the account-less quick-tunnel API is degraded and
// the request is retried — those URLs would otherwise satisfy the old
// pattern /https:\/\/[a-z0-9-]+\.trycloudflare\.com/ and get sent to the
// phone as if they were the real tunnel.
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/;

// Marker line cloudflared prints right before announcing the real URL.
// Used as a defence-in-depth gate: even if a future regex change re-admits
// a single-segment subdomain, we won't accept any URL until we've seen
// the success line. If cloudflared ever changes this wording, the
// tightened regex above still keeps us correct on its own.
const READY_MARKER = /your quick tunnel has been created/i;

// cloudflared announces its local metrics server at startup, e.g.
// "INF Starting metrics server on 127.0.0.1:20241/metrics". Its /ready
// endpoint reports how many live connections the tunnel has to
// Cloudflare's edge.
const METRICS_LINE = /Starting metrics server on ((?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5})/;

/**
 * Ask cloudflared whether the tunnel is actually connected.
 *
 * The process staying alive proves nothing: when Cloudflare drops a quick
 * tunnel, cloudflared keeps running and retrying forever while the
 * hostname no longer resolves. Seen after 11 days, with 2049 rejected
 * re-registrations and polpo still advertising the dead URL.
 *
 * Only ever queries a loopback address parsed from cloudflared's own
 * output.
 *
 * @param {?string} addr - host:port of the metrics server
 * @returns {Promise<?{readyConnections: number}>} null when unknown
 */
function checkReady(addr) {
  if (!addr) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get('http://' + addr + '/ready', { timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => {
        try {
          const n = JSON.parse(body).readyConnections;
          resolve(Number.isInteger(n) && n >= 0 ? { readyConnections: n } : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function extractTunnelUrl(text, opts) {
  const requireMarker = !!(opts && opts.requireMarker);
  if (requireMarker && !READY_MARKER.test(text)) return null;
  const m = String(text).match(QUICK_TUNNEL_URL);
  return m ? m[0] : null;
}

function isAvailable() {
  try {
    execFileSync('which', ['cloudflared'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function start(port) {
  return new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    let markerSeen = false;
    let metricsAddr = null;
    // What cloudflared said, so a startup failure can report why.
    const tail = createOutputTail();

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill('SIGTERM');
        reject(new Error('cloudflared: timed out waiting for tunnel URL (30s)' + tail.hint()));
      }
    }, 30000);

    function onData(data) {
      const line = data.toString();
      if (!resolved) tail.push(line);
      if (!metricsAddr) {
        const m = line.match(METRICS_LINE);
        if (m) metricsAddr = m[1];
      }
      if (!markerSeen && READY_MARKER.test(line)) {
        markerSeen = true;
      }
      // Only consider URLs once we've seen the success marker. The marker
      // and the URL may arrive in the same chunk or in adjacent ones —
      // either is fine because we test the marker BEFORE the URL match.
      if (!markerSeen) return;
      const url = extractTunnelUrl(line);
      if (url && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          url: url,
          close: () => killChild(child),
          // Post-startup liveness signal consumed by TunnelSupervisor.
          // Quick Tunnels have no fixed lifetime but they die with the
          // cloudflared process (crash, OOM, network collapse beyond
          // cloudflared's own retries). Without this the tunnel goes
          // silently dead and the dashboard keeps advertising a URL
          // that 404s.
          onExit: (cb) => child.once('exit', cb),
          // Whether the tunnel is connected, as opposed to merely running.
          // Consumed by TunnelSupervisor's health watchdog.
          health: () => checkReady(metricsAddr),
        });
      }
    }

    // cloudflared logs the URL to stderr
    child.stderr.on('data', onData);
    child.stdout.on('data', onData);

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared: ${err.message}`));
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited with code ${code}${tail.hint()}`));
      }
    });
  });
}

function killChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 5000);
}

module.exports = {
  name,
  isAvailable,
  start,
  // Exported for tests:
  checkReady,
  extractTunnelUrl,
  QUICK_TUNNEL_URL,
  READY_MARKER,
};
