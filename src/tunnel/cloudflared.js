const { spawn, execFileSync } = require('child_process');

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

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill('SIGTERM');
        reject(new Error('cloudflared: timed out waiting for tunnel URL (30s)'));
      }
    }, 30000);

    function onData(data) {
      const line = data.toString();
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
        reject(new Error(`cloudflared exited with code ${code}`));
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
  extractTunnelUrl,
  QUICK_TUNNEL_URL,
  READY_MARKER,
};
