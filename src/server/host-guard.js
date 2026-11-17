'use strict';

// Host header allow-list, the defence against DNS rebinding.
//
// The Origin check in index.js and websocket.js compares the Origin with
// the Host header. A rebinding page defeats it: the page is served from
// http://rebind.attacker.example:7890, the attacker then points that name
// at 127.0.0.1 (or at this machine's LAN address), and the browser sends
// Origin and Host for the same attacker name. They match, and the request
// reaches polpo. The browser never lets a page choose its Host header,
// so refusing every name polpo does not expect closes that path.
//
// Literal IP addresses pass on purpose: a page can only make the browser
// send Host: <ip> by talking to that address directly, and a cross-origin
// request to it is still refused by the Origin check.
//
// The names that pass:
//   - the loopback names (localhost, 127.0.0.1, ::1);
//   - this machine's host name, bare and with .local (mDNS); a public DNS
//     zone cannot hand those names to an attacker's page;
//   - the --host bind name when it is a name, not an address;
//   - POLPO_ALLOWED_HOSTS / --allowed-hosts (a Tailscale MagicDNS name,
//     a reverse proxy's domain);
//   - the current tunnel host name, set at runtime when the tunnel comes
//     up and replaced when it rotates.

const net = require('net');
const os = require('os');

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
// A DNS name is at most 253 characters; anything longer is not one.
const MAX_HOST_CHARS = 253;
const HOST_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The host name in a Host header (or a bare name), lower-cased, without
 * the port, the IPv6 brackets or a trailing dot. Null when malformed.
 */
function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string') return null;
  const h = hostHeader.trim().toLowerCase();
  if (h === '' || h.length > MAX_HOST_CHARS + 8) return null;
  const validPort = (p) => p === undefined || /^[0-9]{1,5}$/.test(p);
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end <= 1) return null;
    const rest = h.slice(end + 1);
    if (rest !== '' && !(rest.startsWith(':') && validPort(rest.slice(1)))) return null;
    const addr = h.slice(1, end);
    return net.isIPv6(addr) ? addr : null;
  }
  // A bare IPv6 address without brackets is not a valid Host header.
  if (h.split(':').length > 2) return null;
  const colon = h.indexOf(':');
  let name = colon >= 0 ? h.slice(0, colon) : h;
  if (!validPort(colon >= 0 ? h.slice(colon + 1) : undefined)) return null;
  // The FQDN form (trailing dot) names the same host.
  if (name.endsWith('.')) name = name.slice(0, -1);
  if (name === '' || name.length > MAX_HOST_CHARS) return null;
  if (net.isIP(name) !== 0) return name;
  return HOST_NAME_RE.test(name) ? name : null;
}

/**
 * True for a host name or address that only this machine can reach.
 * Takes a Host header or a bind address (a bare ::1 is valid as the
 * latter only).
 */
function isLoopbackHost(name) {
  const raw = String(name || '').trim().toLowerCase();
  const n = net.isIP(raw) !== 0 ? raw : hostnameOf(raw);
  if (!n) return false;
  if (LOOPBACK_NAMES.has(n)) return true;
  // The whole 127.0.0.0/8 block is loopback.
  return net.isIPv4(n) && n.startsWith('127.');
}

/**
 * Parse a comma-separated list of extra allowed host names
 * (POLPO_ALLOWED_HOSTS, --allowed-hosts). Throws on an entry that is not
 * a host name, so a typo is refused at startup instead of locking the
 * operator out with 421s.
 */
function parseAllowedHosts(value) {
  if (value === undefined || value === null || value === true) return [];
  const out = [];
  for (const raw of String(value).split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    const name = hostnameOf(entry);
    if (!name) throw new Error(`Invalid allowed host: ${JSON.stringify(entry)}`);
    out.push(name);
  }
  return out;
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.allowedHosts] - extra names (already parsed)
 * @param {string} [opts.bindHost] - the --host value
 * @param {string} [opts.machineName] - defaults to os.hostname()
 */
function createHostGuard(opts = {}) {
  const allowed = new Set(LOOPBACK_NAMES);
  const add = (value) => {
    const n = hostnameOf(String(value || ''));
    if (n) allowed.add(n);
  };

  const machineName = opts.machineName !== undefined ? opts.machineName : os.hostname();
  if (machineName) {
    add(machineName);
    const bare = hostnameOf(String(machineName));
    if (bare && !bare.endsWith('.local') && net.isIP(bare) === 0) add(bare + '.local');
  }
  if (opts.bindHost && net.isIP(opts.bindHost) === 0) add(opts.bindHost);
  for (const name of opts.allowedHosts || []) add(name);

  // The tunnel's public name is held apart from the fixed list: a
  // quick tunnel mints a new name on every restart, and the old one must
  // stop passing once it is no longer ours.
  let tunnelHost = null;

  function isAllowed(hostHeader) {
    const name = hostnameOf(hostHeader);
    if (!name) return false;
    if (allowed.has(name)) return true;
    if (tunnelHost && name === tunnelHost) return true;
    return net.isIP(name) !== 0;
  }

  /** Point the guard at the current tunnel URL, or clear it with null. */
  function setTunnelUrl(tunnelUrl) {
    if (!tunnelUrl) { tunnelHost = null; return; }
    try {
      tunnelHost = hostnameOf(new URL(String(tunnelUrl)).host);
    } catch {
      tunnelHost = null;
    }
  }

  // Express middleware: mounted before every route, public ones included.
  function middleware(req, res, next) {
    if (isAllowed(req.headers.host)) return next();
    res.status(421).json({ error: 'Unexpected Host header' });
  }

  // The same rule for the WebSocket upgrade, run before the upgrade is
  // accepted.
  function allowsUpgrade(req) {
    return isAllowed(req.headers.host);
  }

  return {
    isAllowed,
    middleware,
    allowsUpgrade,
    setTunnelUrl,
    allowedNames: () => [...allowed].sort(),
  };
}

module.exports = { createHostGuard, hostnameOf, isLoopbackHost, parseAllowedHosts };
