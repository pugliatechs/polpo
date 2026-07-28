const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TunnelSupervisor } = require('../src/tunnel/supervisor');

// Silence the supervisor's own logging during tests.
const quietLogger = { info() {}, warn() {}, error() {} };

/**
 * Controllable clock + timer so backoff and the rolling rotation window
 * can be exercised without real waiting.
 */
function createFakeTime() {
  let now = 1_000_000;
  const pending = [];   // { at, fn }
  return {
    now: () => now,
    setTimeoutFn: (fn, delay) => {
      const entry = { at: now + delay, fn };
      pending.push(entry);
      return entry;
    },
    /** Advance the clock, firing any timers whose deadline passed. */
    async advance(ms) {
      now += ms;
      const due = pending.filter((e) => e.at <= now);
      for (const e of due) {
        pending.splice(pending.indexOf(e), 1);
        e.fn();
      }
      // Let any promise chains started by the timer settle.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    pendingCount: () => pending.length,
  };
}

/**
 * Fake provider handle factory. Each handle records whether it was
 * closed and exposes a `die()` helper that fires the onExit callback,
 * mimicking a cloudflared child process exiting.
 */
function createFakeProvider(urls) {
  const queue = Array.isArray(urls) ? urls.slice() : [];
  const handles = [];
  let failNext = 0;

  const startTunnel = async () => {
    if (failNext > 0) {
      failNext--;
      throw new Error('provider unavailable');
    }
    const url = queue.length ? queue.shift() : 'https://fallback.trycloudflare.com';
    let exitCb = null;
    const handle = {
      url,
      closed: false,
      close() { this.closed = true; },
      onExit(cb) { exitCb = cb; },
      die() { if (exitCb) exitCb(0); },
    };
    handles.push(handle);
    return handle;
  };

  return {
    startTunnel,
    handles,
    failTimes(n) { failNext = n; },
  };
}

function newSupervisor(provider, time, extra) {
  return new TunnelSupervisor(Object.assign({
    startTunnel: provider.startTunnel,
    tunnelOpts: { provider: 'cloudflared', port: 7890 },
    now: time.now,
    setTimeoutFn: time.setTimeoutFn,
    logger: quietLogger,
    initialBackoffMs: 1000,
    maxBackoffMs: 8000,
    stableAfterMs: 60000,
  }, extra || {}));
}

describe('TunnelSupervisor: startup', () => {
  it('requires a startTunnel function', () => {
    assert.throws(() => new TunnelSupervisor({}), /requires opts.startTunnel/);
    assert.throws(() => new TunnelSupervisor({ startTunnel: 'nope' }), /requires opts.startTunnel/);
  });

  it('start() resolves with the first URL and emits url', async () => {
    const time = createFakeTime();
    const provider = createFakeProvider(['https://a-b-c.trycloudflare.com']);
    const sup = newSupervisor(provider, time);
    const seen = [];
    sup.on('url', (e) => seen.push(e));

    const res = await sup.start();
    assert.equal(res.url, 'https://a-b-c.trycloudflare.com');
    assert.equal(sup.url, 'https://a-b-c.trycloudflare.com');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://a-b-c.trycloudflare.com');
    assert.equal(seen[0].supervised, true);
    sup.stop();
  });

  it('reports supervised:false when the provider has no onExit', async () => {
    const time = createFakeTime();
    const sup = newSupervisor({
      startTunnel: async () => ({ url: 'https://x-y.trycloudflare.com', close() {} }),
    }, time);
    const seen = [];
    sup.on('url', (e) => seen.push(e));
    await sup.start();
    assert.equal(seen[0].supervised, false);
    assert.equal(sup.supervised, false);
    sup.stop();
  });

  it('propagates an initial start failure to the caller', async () => {
    const time = createFakeTime();
    const provider = createFakeProvider([]);
    provider.failTimes(1);
    const sup = newSupervisor(provider, time);
    await assert.rejects(() => sup.start(), /provider unavailable/);
  });
});

describe('TunnelSupervisor: rotation on provider death', () => {
  it('restarts after the provider dies and emits the NEW url', async () => {
    const time = createFakeTime();
    const provider = createFakeProvider([
      'https://first-one-here.trycloudflare.com',
      'https://second-one-here.trycloudflare.com',
    ]);
    const sup = newSupervisor(provider, time);
    const urls = [];
    sup.on('url', (e) => urls.push(e.url));

    await sup.start();
    assert.deepEqual(urls, ['https://first-one-here.trycloudflare.com']);

    provider.handles[0].die();
    await time.advance(1000);   // first backoff

    assert.deepEqual(urls, [
      'https://first-one-here.trycloudflare.com',
      'https://second-one-here.trycloudflare.com',
    ]);
    assert.equal(sup.url, 'https://second-one-here.trycloudflare.com');
    sup.stop();
  });

  it('emits a down event carrying how long the tunnel survived', async () => {
    const time = createFakeTime();
    const provider = createFakeProvider(['https://a-b.trycloudflare.com', 'https://c-d.trycloudflare.com']);
    const sup = newSupervisor(provider, time);
    const downs = [];
    sup.on('down', (e) => downs.push(e));

    await sup.start();
    await time.advance(5000);
    provider.handles[0].die();

    assert.equal(downs.length, 1);
    assert.equal(downs[0].aliveMs, 5000);
    sup.stop();
  });

  it('escalates backoff when restarts keep failing', async () => {
    const time = createFakeTime();
    const provider = createFakeProvider(['https://a-b.trycloudflare.com']);
    const sup = newSupervisor(provider, time);
    const delays = [];
    sup.on('rotating', (e) => delays.push(e.delayMs));

    await sup.start();
    provider.failTimes(3);
    provider.handles[0].die();

    await time.advance(1000);   // attempt 1 fails -> schedules 2000
    await time.advance(2000);   // attempt 2 fails -> schedules 4000
    await time.advance(4000);   // attempt 3 fails -> schedules 8000

    assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
    sup.stop();
  });

  it('caps backoff at maxBackoffMs', async () => {
    const time = createFakeTime();
    const provider = createFakeProvider(['https://a-b.trycloudflare.com']);
    const sup = newSupervisor(provider, time, { maxBackoffMs: 2000 });
    const delays = [];
    sup.on('rotating', (e) => delays.push(e.delayMs));

    await sup.start();
    provider.failTimes(4);
    provider.handles[0].die();

    await time.advance(1000);
    await time.advance(2000);
    await time.advance(2000);
    await time.advance(2000);

    // 1000 then clamped at 2000 forever
    assert.equal(delays[0], 1000);
    assert.ok(delays.slice(1).every((d) => d === 2000), 'all later delays clamped: ' + delays.join(','));
    sup.stop();
  });

  it('resets backoff after a tunnel survives the stability window', async () => {
    const time = createFakeTime();
    const provider = createFakeProvider([
      'https://one-a.trycloudflare.com',
      'https://two-b.trycloudflare.com',
      'https://three-c.trycloudflare.com',
    ]);
    const sup = newSupervisor(provider, time, { stableAfterMs: 10000 });
    const delays = [];
    sup.on('rotating', (e) => delays.push(e.delayMs));

    await sup.start();
    provider.failTimes(1);
    provider.handles[0].die();
    await time.advance(1000);   // fails -> next delay 2000
    await time.advance(2000);   // succeeds, url #2 adopted
    assert.deepEqual(delays, [1000, 2000]);

    // Let it live past the stability threshold, then kill it.
    await time.advance(20000);
    provider.handles[provider.handles.length - 1].die();
    await time.advance(1000);

    // Backoff should be back at the initial 1000, not the escalated 4000.
    assert.equal(delays[2], 1000);
    sup.stop();
  });
});

describe('TunnelSupervisor: rotation budget', () => {
  it('gives up once rotations exceed the hourly cap', async () => {
    const time = createFakeTime();
    const provider = createFakeProvider([]);
    const sup = newSupervisor(provider, time, { maxRotationsPerHour: 3 });
    const gaveUp = [];
    sup.on('gave-up', (e) => gaveUp.push(e));

    await sup.start();
    // Each cycle: current tunnel dies, backoff elapses, new one starts.
    for (let i = 0; i < 5; i++) {
      const last = provider.handles[provider.handles.length - 1];
      if (last && !last.closed) last.die();
      await time.advance(10000);
    }

    assert.equal(gaveUp.length, 1, 'gave-up emitted exactly once');
    assert.equal(gaveUp[0].rotations, 3);
    sup.stop();
  });

  it('does not give up when rotations are spread beyond the rolling window', async () => {
    const time = createFakeTime();
    const provider = createFakeProvider([]);
    const sup = newSupervisor(provider, time, { maxRotationsPerHour: 2, stableAfterMs: 1000 });
    const gaveUp = [];
    sup.on('gave-up', (e) => gaveUp.push(e));

    await sup.start();
    for (let i = 0; i < 4; i++) {
      const last = provider.handles[provider.handles.length - 1];
      if (last && !last.closed) last.die();
      await time.advance(1000);         // restart happens
      await time.advance(61 * 60 * 1000); // age the rotation out of the window
    }

    assert.equal(gaveUp.length, 0, 'rotations aged out, never hit the cap');
    sup.stop();
  });

  it('stops restarting after gave-up', async () => {
    const time = createFakeTime();
    const provider = createFakeProvider([]);
    const sup = newSupervisor(provider, time, { maxRotationsPerHour: 1 });
    await sup.start();

    for (let i = 0; i < 4; i++) {
      const last = provider.handles[provider.handles.length - 1];
      if (last && !last.closed) last.die();
      await time.advance(10000);
    }

    const countAfterGiveUp = provider.handles.length;
    const last = provider.handles[provider.handles.length - 1];
    if (last && !last.closed) last.die();
    await time.advance(60000);
    assert.equal(provider.handles.length, countAfterGiveUp, 'no further restarts attempted');
    sup.stop();
  });
});

describe('TunnelSupervisor: teardown', () => {
  it('stop() closes the live handle', async () => {
    const time = createFakeTime();
    const provider = createFakeProvider(['https://a-b.trycloudflare.com']);
    const sup = newSupervisor(provider, time);
    await sup.start();
    sup.stop();
    assert.equal(provider.handles[0].closed, true);
  });

  it('an exit AFTER stop() does not trigger a restart', async () => {
    const time = createFakeTime();
    const provider = createFakeProvider(['https://a-b.trycloudflare.com', 'https://c-d.trycloudflare.com']);
    const sup = newSupervisor(provider, time);
    await sup.start();

    sup.stop();
    provider.handles[0].die();      // close() naturally fires exit
    await time.advance(60000);

    assert.equal(provider.handles.length, 1, 'no replacement tunnel was started');
  });

  it('stop() cancels a pending restart timer', async () => {
    const time = createFakeTime();
    const provider = createFakeProvider(['https://a-b.trycloudflare.com', 'https://c-d.trycloudflare.com']);
    const sup = newSupervisor(provider, time);
    await sup.start();

    provider.handles[0].die();      // schedules a restart
    sup.stop();                     // cancel before it fires
    await time.advance(60000);

    assert.equal(provider.handles.length, 1, 'restart timer was cancelled');
  });

  it('closes a tunnel that arrives after stop() raced in', async () => {
    const time = createFakeTime();
    let releaseStart;
    const gate = new Promise((r) => { releaseStart = r; });
    const handles = [];
    const sup = newSupervisor({
      startTunnel: async () => {
        if (handles.length > 0) await gate;   // stall the SECOND start
        const h = { url: 'https://x-y.trycloudflare.com', closed: false,
          close() { this.closed = true; }, onExit(cb) { this._cb = cb; },
          die() { if (this._cb) this._cb(0); } };
        handles.push(h);
        return h;
      },
    }, time);

    await sup.start();
    handles[0].die();
    await time.advance(1000);      // restart in flight, blocked on gate
    sup.stop();                    // stop while the new tunnel is being created
    releaseStart();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(handles.length, 2, 'the in-flight tunnel did come up');
    assert.equal(handles[1].closed, true, 'and was closed rather than leaked');
  });

  it('stop() is safe to call twice', async () => {
    const time = createFakeTime();
    const provider = createFakeProvider(['https://a-b.trycloudflare.com']);
    const sup = newSupervisor(provider, time);
    await sup.start();
    sup.stop();
    assert.doesNotThrow(() => sup.stop());
  });
});
