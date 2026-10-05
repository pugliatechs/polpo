/**
 * TunnelSupervisor — keeps a tunnel alive across provider deaths.
 *
 * Cloudflare Quick Tunnels (polpo's default `--tunnel` mode) have no
 * fixed expiry, but they die with the `cloudflared` process: a crash,
 * an OOM kill, or a network partition beyond cloudflared's own retry
 * budget all end the tunnel. Before this module the death was silent:
 * providers only reported `exit` during startup, so a tunnel that died
 * after coming up left polpo advertising a URL that 404s, with the
 * user's phone as the only signal.
 *
 * The supervisor watches the provider handle's `onExit` signal,
 * restarts with exponential backoff, and emits a 'url' event on every
 * new URL so callers can re-broadcast it (dashboard QR refresh + web
 * push to already-disconnected phones).
 *
 * Design notes
 *
 *   - Quick Tunnel URLs are NOT stable across restarts. Cloudflare
 *     mints a fresh three-word subdomain each time, so every rotation
 *     is a URL change the user must be told about. Named tunnels
 *     (account + domain) avoid this entirely and are the real fix for
 *     anyone running polpo as an always-on rig; this module is for the
 *     account-less quick-tunnel case.
 *
 *   - Rotation is capped per rolling hour. If Cloudflare's quick-tunnel
 *     API is degraded or rate-limiting us, unbounded restarts would
 *     churn through URLs, spam push notifications, and leave the user
 *     unable to tell which URL is current. Past the cap we give up
 *     loudly rather than flapping quietly.
 *
 *   - `stop()` sets a flag consulted by the exit handler, so an
 *     intentional teardown is never mistaken for a crash. Without this
 *     every clean shutdown would trigger a restart storm.
 *
 *   - Backoff resets only after a tunnel has survived STABLE_AFTER_MS.
 *     A tunnel that dies immediately on every attempt keeps escalating
 *     its delay instead of hammering at the initial interval.
 */

'use strict';

const EventEmitter = require('events');
const { makeLogger } = require('../util/logger');

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;
const STABLE_AFTER_MS = 60000;        // survive this long => reset backoff
const MAX_ROTATIONS_PER_HOUR = 10;
// Health watchdog, for providers that can report whether the tunnel is
// connected (cloudflared). A tunnel with no live connection for this
// long is treated as dead even though its process is still running.
const HEALTH_INTERVAL_MS = 60 * 1000;
const UNHEALTHY_AFTER_MS = 3 * 60 * 1000;
const ROTATION_WINDOW_MS = 60 * 60 * 1000;

class TunnelSupervisor extends EventEmitter {
  /**
   * @param {object} opts
   * @param {function} opts.startTunnel - async ({provider, port, ...}) => {url, close, onExit?}
   * @param {object} opts.tunnelOpts - forwarded verbatim to startTunnel
   * @param {number} [opts.maxRotationsPerHour]
   * @param {number} [opts.initialBackoffMs]
   * @param {number} [opts.maxBackoffMs]
   * @param {number} [opts.stableAfterMs]
   * @param {function} [opts.now] - injectable clock for tests
   * @param {function} [opts.setTimeoutFn] - injectable timer for tests
   * @param {number} [opts.healthIntervalMs] - how often to ask a provider
   *   whether its tunnel is connected (env POLPO_TUNNEL_HEALTH_INTERVAL_MS)
   * @param {number} [opts.unhealthyAfterMs] - how long without a live
   *   connection before restarting (env POLPO_TUNNEL_UNHEALTHY_AFTER_MS)
   */
  constructor(opts) {
    super();
    if (!opts || typeof opts.startTunnel !== 'function') {
      throw new TypeError('TunnelSupervisor requires opts.startTunnel');
    }
    this._startTunnel = opts.startTunnel;
    this._tunnelOpts = opts.tunnelOpts || {};
    this._maxRotations = opts.maxRotationsPerHour || MAX_ROTATIONS_PER_HOUR;
    this._initialBackoff = opts.initialBackoffMs || INITIAL_BACKOFF_MS;
    this._maxBackoff = opts.maxBackoffMs || MAX_BACKOFF_MS;
    this._stableAfter = opts.stableAfterMs != null ? opts.stableAfterMs : STABLE_AFTER_MS;
    this._now = opts.now || Date.now;
    this._setTimeout = opts.setTimeoutFn || setTimeout;
    this.log = opts.logger || makeLogger('tunnel-supervisor');
    this._healthInterval = positiveInt(opts.healthIntervalMs)
      || positiveInt(process.env.POLPO_TUNNEL_HEALTH_INTERVAL_MS)
      || HEALTH_INTERVAL_MS;
    this._unhealthyAfter = positiveInt(opts.unhealthyAfterMs)
      || positiveInt(process.env.POLPO_TUNNEL_UNHEALTHY_AFTER_MS)
      || UNHEALTHY_AFTER_MS;

    this._handle = null;          // current provider handle
    this._url = null;
    this._stopping = false;
    this._backoff = this._initialBackoff;
    this._startedAt = 0;
    this._rotations = [];         // timestamps of rotations, for the rolling cap
    this._retryTimer = null;
    this._gaveUp = false;
    this._lastError = null;       // why the most recent attempt failed
    this._healthTimer = null;
    this._unhealthySince = null;  // first check that found no live connection
  }

  get url() {
    return this._url;
  }

  get supervised() {
    // False when the provider didn't expose onExit — we started the
    // tunnel but can't detect its death.
    return !!(this._handle && typeof this._handle.onExit === 'function');
  }

  /**
   * Start the tunnel for the first time. Subsequent deaths are handled
   * internally.
   *
   * By default a failed first attempt rejects. With `retryOnFailure` it
   * resolves with `{url: null, retrying: true, error}` and keeps trying
   * on the usual backoff; the URL then arrives as a 'url' event. Without
   * this a transient failure at boot (network not up yet, a VPN in the
   * way) left polpo with no tunnel for its whole lifetime, because the
   * restart logic only ever covered a tunnel that had already come up.
   *
   * @param {{retryOnFailure?: boolean}} [opts]
   * @returns {Promise<{url: ?string, retrying?: boolean, error?: string}>}
   */
  async start(opts) {
    const retryOnFailure = !!(opts && opts.retryOnFailure);
    let handle;
    try {
      handle = await this._startTunnel(this._tunnelOpts);
    } catch (err) {
      if (!retryOnFailure) throw err;
      const message = (err && err.message) || 'unknown error';
      this._lastError = message;
      this.emit('start-failed', { error: message });
      this._scheduleRestart();
      return { url: null, retrying: !this._gaveUp, error: message };
    }
    this._adopt(handle);
    return { url: this._url };
  }

  /**
   * Tear down. Safe to call multiple times; never triggers a restart.
   */
  stop() {
    this._stopping = true;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._healthTimer) {
      clearTimeout(this._healthTimer);
      this._healthTimer = null;
    }
    if (this._handle && typeof this._handle.close === 'function') {
      try { this._handle.close(); } catch {}
    }
    this._handle = null;
  }

  // --- internals ---------------------------------------------------

  /**
   * Take ownership of a freshly-started provider handle: record the
   * URL, wire the death signal, and emit 'url' so callers can react.
   */
  _adopt(handle) {
    this._handle = handle;
    this._url = handle.url;
    this._startedAt = this._now();

    if (typeof handle.onExit === 'function') {
      handle.onExit(() => this._onProviderExit());
    } else {
      this.log.warn(
        'provider did not expose onExit; tunnel death will go undetected ' +
        '(URL: ' + handle.url + ')'
      );
    }
    this._watchHealth(handle);
    this.emit('url', { url: this._url, supervised: this.supervised });
  }

  /**
   * Restart a tunnel whose process is alive but which has lost its
   * connection to the provider.
   *
   * The exit watch alone missed this. Cloudflare dropped a quick tunnel
   * after 11 days; cloudflared kept running and retrying (2049 rejected
   * re-registrations) while the hostname stopped resolving, and polpo
   * went on advertising the dead URL because no process ever exited.
   *
   * Only an explicit "no live connections" counts against the tunnel.
   * A check that cannot get an answer is ignored, so a slow metrics
   * endpoint never causes a restart by itself.
   */
  _watchHealth(handle) {
    if (!handle || typeof handle.health !== 'function') return;
    this._unhealthySince = null;

    const tick = () => {
      this._healthTimer = null;
      if (this._stopping || handle !== this._handle) return;
      Promise.resolve()
        .then(() => handle.health())
        .catch(() => null)
        .then((state) => {
          if (this._stopping || handle !== this._handle) return;
          if (state && state.readyConnections === 0) {
            if (this._unhealthySince === null) this._unhealthySince = this._now();
            const downFor = this._now() - this._unhealthySince;
            if (downFor >= this._unhealthyAfter) {
              this._restartUnhealthy(handle, downFor);
              return;
            }
          } else if (state && state.readyConnections > 0) {
            this._unhealthySince = null;
          }
          this._healthTimer = this._setTimeout(tick, this._healthInterval);
        });
    };
    this._healthTimer = this._setTimeout(tick, this._healthInterval);
  }

  _restartUnhealthy(handle, downForMs) {
    this.log.warn(
      'tunnel has had no live connection for ' + Math.round(downForMs / 1000) +
      's although its process is running (URL: ' + handle.url + '); restarting it'
    );
    this.emit('unhealthy', { url: handle.url, downForMs });
    if (typeof handle.onExit === 'function' && typeof handle.close === 'function') {
      // Killing the process lands in the normal death path, which
      // restarts with backoff and announces the new URL.
      try { handle.close(); } catch {}
    } else {
      try { if (typeof handle.close === 'function') handle.close(); } catch {}
      this._onProviderExit();
    }
  }

  _onProviderExit() {
    if (this._stopping) return;      // intentional teardown, not a crash
    if (this._gaveUp) return;

    const aliveMs = this._now() - this._startedAt;
    // A tunnel that stayed up long enough is treated as healthy: reset
    // the backoff so a single mid-session death doesn't inherit the
    // penalty from an unrelated failure hours ago.
    if (aliveMs >= this._stableAfter) {
      this._backoff = this._initialBackoff;
    }

    this._handle = null;
    this._url = null;
    this.log.warn('tunnel died after ' + Math.round(aliveMs / 1000) + 's; restarting');
    this.emit('down', { aliveMs });
    this._scheduleRestart();
  }

  _scheduleRestart() {
    if (!this._withinRotationBudget()) {
      this._gaveUp = true;
      this.log.error(
        'giving up: more than ' + this._maxRotations + ' tunnel attempts in the ' +
        'last hour' + (this._lastError ? ' (last error' + errorSuffix(this._lastError) + ')' : '') +
        '. Restart polpo to try again, or switch to a named tunnel for a stable URL.'
      );
      this.emit('gave-up', { rotations: this._rotations.length, lastError: this._lastError });
      return;
    }

    const delay = this._backoff;
    this.log.info('retrying tunnel in ' + delay + 'ms');
    this.emit('rotating', { delayMs: delay });

    this._retryTimer = this._setTimeout(() => {
      this._retryTimer = null;
      if (this._stopping) return;
      this._attemptRestart();
    }, delay);

    // Escalate for the NEXT attempt.
    this._backoff = Math.min(this._backoff * 2, this._maxBackoff);
  }

  _attemptRestart() {
    this._rotations.push(this._now());
    Promise.resolve()
      .then(() => this._startTunnel(this._tunnelOpts))
      .then((handle) => {
        if (this._stopping) {
          // Raced with stop(): discard the tunnel we just brought up.
          if (handle && typeof handle.close === 'function') {
            try { handle.close(); } catch {}
          }
          return;
        }
        this._lastError = null;
        this.log.info('tunnel up: ' + handle.url);
        this._adopt(handle);
      })
      .catch((err) => {
        this._lastError = (err && err.message) || 'unknown error';
        this.log.warn('tunnel attempt failed: ' + this._lastError);
        this._scheduleRestart();
      });
  }

  /**
   * Rolling-window rate limit on rotations. Prunes timestamps outside
   * the window, then checks the remaining count against the cap.
   */
  _withinRotationBudget() {
    const cutoff = this._now() - ROTATION_WINDOW_MS;
    this._rotations = this._rotations.filter((t) => t >= cutoff);
    return this._rotations.length < this._maxRotations;
  }
}

/**
 * Coerce to a positive integer, or null, so a malformed env var falls
 * through to the default.
 */
function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * ': message' for the give-up line, kept on one line and short.
 */
function errorSuffix(message) {
  return ': ' + String(message).replace(/\s+/g, ' ').slice(0, 300);
}

module.exports = {
  TunnelSupervisor,
  HEALTH_INTERVAL_MS,
  UNHEALTHY_AFTER_MS,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  STABLE_AFTER_MS,
  MAX_ROTATIONS_PER_HOUR,
};
