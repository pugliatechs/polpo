'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHostGuard, hostnameOf, isLoopbackHost, parseAllowedHosts } = require('../src/server/host-guard');

const guard = (opts = {}) => createHostGuard(opts);

describe('hostnameOf', () => {
  it('strips the port, the IPv6 brackets and a trailing dot', () => {
    assert.equal(hostnameOf('localhost:7890'), 'localhost');
    assert.equal(hostnameOf('LOCALHOST'), 'localhost');
    assert.equal(hostnameOf('[::1]:7890'), '::1');
    assert.equal(hostnameOf('example.com.:7890'), 'example.com');
  });

  it('refuses malformed values', () => {
    for (const bad of ['', '   ', undefined, null, 42, '::1', '[::1', '[nothex]:80', 'host:port',
      'a b', 'evil.example/x', 'under_score.example', 'host:123456', 'x'.repeat(300)]) {
      assert.equal(hostnameOf(bad), null, String(bad));
    }
  });
});

describe('isLoopbackHost', () => {
  it('accepts the loopback names and the 127.0.0.0/8 block', () => {
    for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '::1', 'localhost:7890', '[::1]:7890']) {
      assert.equal(isLoopbackHost(h), true, h);
    }
  });

  it('refuses network addresses and other names', () => {
    for (const h of ['0.0.0.0', '::', '192.168.1.20', '100.64.0.5', 'devbox', 'localhost.attacker.example', '', undefined]) {
      assert.equal(isLoopbackHost(h), false, String(h));
    }
  });
});

describe('createHostGuard', () => {
  it('lets loopback names and literal addresses through', () => {
    const g = guard();
    for (const h of ['localhost:7890', '127.0.0.1:7890', '[::1]:7890', '192.168.1.20:7890', '100.101.102.103:7890']) {
      assert.equal(g.isAllowed(h), true, h);
    }
  });

  it('refuses a rebinding name even when the Origin would match it', () => {
    const g = guard();
    for (const h of ['rebind.attacker.example:7890', '7f000001.rbndr.us:7890', 'localhost.attacker.example', 'localhost.:7890x']) {
      assert.equal(g.isAllowed(h), false, h);
    }
  });

  it('refuses a missing or malformed Host', () => {
    const g = guard();
    assert.equal(g.isAllowed(undefined), false);
    assert.equal(g.isAllowed(''), false);
    assert.equal(g.isAllowed('[::1'), false);
  });

  it("refuses this machine's name unless the operator lists it (mDNS and LLMNR can be spoofed)", () => {
    const os = require('os');
    const name = os.hostname().toLowerCase();
    const g = guard();
    assert.equal(g.isAllowed(`${name}:7890`), false);
    assert.equal(g.isAllowed(`${name}.local:7890`), false);
    const listed = guard({ allowedHosts: [name, `${name}.local`] });
    assert.equal(listed.isAllowed(`${name}:7890`), true);
    assert.equal(listed.isAllowed(`${name}.local:7890`), true);
  });

  it('lets a --host name and the configured names through', () => {
    const g = guard({ bindHost: 'mybox.tail1234.ts.net', allowedHosts: ['polpo.example.org'] });
    assert.equal(g.isAllowed('mybox.tail1234.ts.net:7890'), true);
    assert.equal(g.isAllowed('polpo.example.org'), true);
    assert.equal(g.isAllowed('other.tail1234.ts.net'), false);
  });

  it('follows the current tunnel name and drops the old one when it rotates', () => {
    const g = guard();
    assert.equal(g.isAllowed('random-words.trycloudflare.com'), false);
    g.setTunnelUrl('https://random-words.trycloudflare.com');
    assert.equal(g.isAllowed('random-words.trycloudflare.com'), true);
    assert.equal(g.isAllowed('other-words.trycloudflare.com'), false);
    g.setTunnelUrl('https://other-words.trycloudflare.com');
    assert.equal(g.isAllowed('random-words.trycloudflare.com'), false);
    assert.equal(g.isAllowed('other-words.trycloudflare.com'), true);
    g.setTunnelUrl(null);
    assert.equal(g.isAllowed('other-words.trycloudflare.com'), false);
    g.setTunnelUrl('not a url');
    assert.equal(g.isAllowed('other-words.trycloudflare.com'), false);
  });

  it('answers 421 to a foreign Host and calls next otherwise', () => {
    const g = guard();
    let status = null;
    let nextCalled = false;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    g.middleware({ headers: { host: 'rebind.attacker.example:7890' } }, res, () => { nextCalled = true; });
    assert.equal(status, 421);
    assert.equal(nextCalled, false);
    g.middleware({ headers: { host: 'localhost:7890' } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  it('applies the same rule to a WebSocket upgrade', () => {
    const g = guard();
    assert.equal(g.allowsUpgrade({ headers: { host: 'localhost:7890' } }), true);
    assert.equal(g.allowsUpgrade({ headers: { host: 'rebind.attacker.example:7890' } }), false);
  });
});

describe('parseAllowedHosts', () => {
  it('reads a comma-separated list and skips blanks', () => {
    assert.deepEqual(parseAllowedHosts(' a.example , B.example:8080,, '), ['a.example', 'b.example']);
    assert.deepEqual(parseAllowedHosts(undefined), []);
    assert.deepEqual(parseAllowedHosts(''), []);
    assert.deepEqual(parseAllowedHosts(true), []);
  });

  it('refuses an entry that is not a host name, so a typo fails at startup', () => {
    assert.throws(() => parseAllowedHosts('good.example,bad name'), /Invalid allowed host/);
    assert.throws(() => parseAllowedHosts('*.ts.net'), /Invalid allowed host/);
  });
});
