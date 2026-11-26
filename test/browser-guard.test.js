'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  BrowserGuard, parseSites, siteMatches, parseBrowserUrl, loadSiteConfig, parseGrantMaxMinutes,
  browserCliArgs, CHROME_PREFIX, TAB_TOOLS, GUARDED_TOOLS,
} = require('../src/server/browser-guard');

const C = (name) => CHROME_PREFIX + name;
const ID = 'inst-1';

function guard(config, opts) {
  const cfg = config || {};
  let now = 1_000_000;
  const g = new BrowserGuard(Object.assign({
    grantMaxMinutes: 15,
    now: () => now,
    loadConfig: () => ({
      levels: new Map(Object.entries(cfg.levels || {})),
      allowTools: new Set(cfg.allowTools || []),
    }),
  }, opts || {}));
  g.register(ID, cfg.sites || ['portal.example.it', 'httpbin.org']);
  g.advance = (ms) => { now += ms; };
  return g;
}

function onPage(g, tabId, url) {
  g.observeTabs(ID, [{ tabId, url }]);
}

describe('parseSites', () => {
  it('accepts host names and the *. subdomain form', () => {
    assert.deepEqual(parseSites(['Portal.Example.IT', '*.example.com', 'httpbin.org.']).sites,
      ['portal.example.it', '*.example.com', 'httpbin.org']);
  });

  it('refuses schemes, ports, paths, wildcards elsewhere, IPs, localhost and single labels', () => {
    for (const bad of ['https://portal.example.it', 'portal.example.it:8443', 'portal.example.it/x', 'a.*.example.it',
      '*example.it', '*', '127.0.0.1', '10.0.0.8', '[::1]', 'localhost', 'polpo.localhost', 'intranet', 'a b.it',
      '-bad.example.it', 'x'.repeat(64) + '.it', 'example.123', '']) {
      assert.equal(parseSites([bad]).ok, false, bad);
    }
    assert.equal(parseSites([]).ok, false);
    assert.equal(parseSites('portal.example.it').ok, false);
    assert.equal(parseSites([42]).ok, false);
    assert.equal(parseSites(new Array(21).fill(0).map((_, i) => 's' + i + '.example.it')).ok, false);
  });

  it('matches *. entries on subdomains only', () => {
    assert.equal(siteMatches('*.example.it', 'a.example.it'), true);
    assert.equal(siteMatches('*.example.it', 'a.b.example.it'), true);
    assert.equal(siteMatches('*.example.it', 'example.it'), false);
    assert.equal(siteMatches('*.example.it', 'badexample.it'), false);
    assert.equal(siteMatches('portal.example.it', 'evil.portal.example.it'), false);
  });
});

describe('parseBrowserUrl', () => {
  it('keeps origin and path for display, never the query', () => {
    assert.deepEqual(parseBrowserUrl('https://Portal.example.it/form?token=s3cret#x'),
      { kind: 'web', host: 'portal.example.it', display: 'https://portal.example.it/form' });
  });

  it('defaults a bare host to https only for navigate', () => {
    assert.equal(parseBrowserUrl('httpbin.org/forms/post', { defaultHttps: true }).host, 'httpbin.org');
    assert.equal(parseBrowserUrl('httpbin.org/forms/post'), null);
  });

  it('treats other schemes and URLs with credentials as not web', () => {
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'chrome://settings', 'https://u:p@portal.example.it/']) {
      assert.equal(parseBrowserUrl(u, { defaultHttps: true }).kind, 'other', u);
    }
    assert.equal(parseBrowserUrl('about:blank').kind, 'blank');
    assert.equal(parseBrowserUrl('chrome://newtab/').kind, 'blank');
  });
});

describe('BrowserGuard: free actions', () => {
  it('allows reading and filling on the session sites and on a blank tab', () => {
    const g = guard();
    onPage(g, 1, 'https://portal.example.it/form');
    for (const [tool, input] of [
      ['read_page', { tabId: 1 }], ['get_page_text', { tabId: 1 }], ['find', { tabId: 1, query: 'x' }],
      ['form_input', { tabId: 1, ref: 'ref_1', value: 'Polpo' }],
      ['computer', { tabId: 1, action: 'screenshot' }], ['computer', { tabId: 1, action: 'zoom', region: [0, 0, 1, 1] }],
      ['computer', { tabId: 1, action: 'scroll' }], ['computer', { tabId: 1, action: 'scroll_to', ref: 'r' }],
      ['computer', { tabId: 1, action: 'wait', duration: 1 }], ['computer', { tabId: 1, action: 'hover' }],
      ['computer', { tabId: 1, action: 'type', text: 'Mario Rossi' }],
    ]) {
      assert.equal(g.decide(ID, C(tool), input).verdict, 'allow', tool + ' ' + JSON.stringify(input));
    }
    onPage(g, 2, 'chrome://newtab/');
    assert.equal(g.decide(ID, C('computer'), { tabId: 2, action: 'screenshot' }).verdict, 'allow');
  });

  it('allows the tab tools always', () => {
    const g = guard();
    for (const t of TAB_TOOLS) assert.equal(g.decide(ID, C(t), {}).verdict, 'allow');
  });

  it('refuses reading a tab on another site, or one with no tabId', () => {
    const g = guard();
    onPage(g, 1, 'https://mail.example.org/inbox');
    const r = g.decide(ID, C('get_page_text'), { tabId: 1 });
    assert.equal(r.verdict, 'deny');
    assert.match(r.message, /mail\.example\.org.*not one of this session's sites/);
    assert.equal(g.decide(ID, C('read_page'), {}).verdict, 'deny');
  });

  it('refuses reading a tab it does not know, and tells the agent to refresh', () => {
    const g = guard();
    const r = g.decide(ID, C('read_page'), { tabId: 99 });
    assert.equal(r.verdict, 'deny');
    assert.match(r.message, /tabs_context_mcp/);
  });

  it('navigates only to the session sites, over http or https, without credentials', () => {
    const g = guard();
    assert.equal(g.decide(ID, C('navigate'), { url: 'https://portal.example.it/a', tabId: 1 }).verdict, 'allow');
    assert.equal(g.decide(ID, C('navigate'), { url: 'httpbin.org/forms/post', tabId: 1 }).verdict, 'allow');
    for (const url of ['https://example.com', 'https://portal.example.it.evil.com/', 'javascript:alert(1)',
      'https://user:pw@portal.example.it/', 'http://127.0.0.1:7890/', 'file:///etc/passwd', '']) {
      assert.equal(g.decide(ID, C('navigate'), { url, tabId: 1 }).verdict, 'deny', url);
    }
  });
});

describe('BrowserGuard: commits', () => {
  const click = { tabId: 1, action: 'left_click', ref: 'ref_7', action_summary: 'Submits the order form' };

  it('relays a commit with its summary and the page, never the query string', () => {
    const g = guard();
    onPage(g, 1, 'https://portal.example.it/order?session=abc123');
    const r = g.decide(ID, C('computer'), click);
    assert.equal(r.verdict, 'ask');
    assert.equal(r.description, 'Browser on portal.example.it: Submits the order form (https://portal.example.it/order)');
    assert.doesNotMatch(r.description, /abc123/);
  });

  it('counts clicks, keys, drags and a typed newline as commits', () => {
    for (const input of [
      { action: 'double_click' }, { action: 'triple_click' }, { action: 'right_click' }, { action: 'left_click_drag' },
      { action: 'key', text: 'Return' }, { action: 'type', text: 'hello\n' }, { action: 'type', text: 'a\rb' },
    ]) {
      const g = guard();
      onPage(g, 1, 'https://portal.example.it/');
      assert.equal(g.decide(ID, C('computer'), Object.assign({ tabId: 1 }, input)).verdict, 'ask', JSON.stringify(input));
    }
  });

  it('treats back and forward as commits: the target is unknown', () => {
    const g = guard();
    onPage(g, 1, 'https://portal.example.it/');
    assert.equal(g.decide(ID, C('navigate'), { url: 'back', tabId: 1 }).verdict, 'ask');
  });

  it('lets commits through inside an active grant, and relays them again once it expires', () => {
    const g = guard();
    onPage(g, 1, 'https://portal.example.it/');
    g.grant(ID, 'portal.example.it', 5);
    assert.equal(g.decide(ID, C('computer'), click).verdict, 'allow');
    onPage(g, 1, 'https://portal.example.it/');
    g.advance(5 * 60_000 - 1);
    assert.equal(g.decide(ID, C('computer'), click).verdict, 'allow');
    onPage(g, 1, 'https://portal.example.it/');
    g.advance(2);
    assert.equal(g.decide(ID, C('computer'), click).verdict, 'ask');
  });

  it('caps a grant at the host maximum', () => {
    const g = guard();
    onPage(g, 1, 'https://portal.example.it/');
    g.grant(ID, 'portal.example.it', 600);
    g.advance(15 * 60_000 + 1);
    assert.equal(g.decide(ID, C('computer'), click).verdict, 'ask');
  });

  it('scopes a grant to its host only', () => {
    const g = guard();
    g.grant(ID, 'portal.example.it', 10);
    onPage(g, 1, 'https://httpbin.org/forms/post');
    assert.equal(g.decide(ID, C('computer'), click).verdict, 'ask');
  });

  it('ends grants on revoke (abort, release)', () => {
    const g = guard();
    onPage(g, 1, 'https://portal.example.it/');
    g.grant(ID, 'portal.example.it', 10);
    g.revokeGrants(ID);
    assert.equal(g.decide(ID, C('computer'), click).verdict, 'ask');
  });

  it('applies the site levels: free lets commits through, every-commit asks even with a grant', () => {
    const g = guard({ levels: { 'portal.example.it': 'every-commit', 'httpbin.org': 'free' } });
    onPage(g, 1, 'https://portal.example.it/');
    g.grant(ID, 'portal.example.it', 10);
    assert.equal(g.decide(ID, C('computer'), click).verdict, 'ask');
    onPage(g, 1, 'https://httpbin.org/forms/post');
    assert.equal(g.decide(ID, C('computer'), click).verdict, 'allow');
  });

  it('matches *. levels from the site file', () => {
    const g = guard({ sites: ['*.example.it'], levels: { '*.example.it': 'free' } });
    onPage(g, 1, 'https://portal.example.it/');
    assert.equal(g.decide(ID, C('computer'), click).verdict, 'allow');
  });

  it('relays a commit on a tab off the session sites, which no grant covers', () => {
    const g = guard();
    g.grant(ID, 'portal.example.it', 10);
    onPage(g, 1, 'https://login.idp.example.org/');
    assert.equal(g.decide(ID, C('computer'), click).verdict, 'ask');
  });
});

describe('BrowserGuard: following the URL', () => {
  const click = { tabId: 1, action: 'left_click', ref: 'ref_7', action_summary: 'Submits' };

  it('forgets the page after a commit until a result says where the tab is', () => {
    const g = guard();
    onPage(g, 1, 'https://portal.example.it/form');
    g.grant(ID, 'portal.example.it', 10);
    assert.equal(g.decide(ID, C('computer'), click).verdict, 'allow');
    // No result yet: the page is unknown.
    assert.equal(g.decide(ID, C('read_page'), { tabId: 1 }).verdict, 'deny');
    assert.equal(g.decide(ID, C('computer'), click).verdict, 'ask');
  });

  it('keeps the page known when a commit put to the user is rejected, forgets it when approved', () => {
    const g = guard();
    onPage(g, 1, 'https://portal.example.it/form');
    const r = g.decide(ID, C('computer'), click);
    assert.equal(r.verdict, 'ask');
    assert.deepEqual(r.touchedTabs, [1]);
    // Rejected: nothing ran, the page is where it was.
    assert.equal(g.decide(ID, C('computer'), { tabId: 1, action: 'screenshot' }).verdict, 'allow');
    // Approved: the click ran, the page is unknown until the next result.
    g.committed(ID, r.touchedTabs);
    assert.equal(g.decide(ID, C('computer'), { tabId: 1, action: 'screenshot' }).verdict, 'deny');
  });

  it('follows a redirect off the sites, then back on', () => {
    const g = guard();
    g.grant(ID, 'portal.example.it', 10);
    onPage(g, 1, 'https://portal.example.it/start');
    assert.equal(g.decide(ID, C('computer'), click).verdict, 'allow');
    // The click redirected to an identity provider.
    onPage(g, 1, 'https://login.idp.example.org/authorize');
    assert.equal(g.decide(ID, C('get_page_text'), { tabId: 1 }).verdict, 'deny');
    assert.equal(g.decide(ID, C('computer'), click).verdict, 'ask');
    // And back to the portal.
    onPage(g, 1, 'https://portal.example.it/home');
    assert.equal(g.decide(ID, C('get_page_text'), { tabId: 1 }).verdict, 'allow');
    assert.equal(g.decide(ID, C('computer'), click).verdict, 'allow');
  });

  it('does not trust a navigate\'s target: a site can redirect anywhere', () => {
    const g = guard();
    g.grant(ID, 'httpbin.org', 10);
    assert.equal(g.decide(ID, C('navigate'), { url: 'https://httpbin.org/redirect-to?url=https://mail.example.org/', tabId: 3 }).verdict, 'allow');
    // Until the navigate's result says where the tab is, nothing is free.
    assert.equal(g.decide(ID, C('find'), { tabId: 3, query: 'name' }).verdict, 'deny');
    // The open redirect took it off the sites.
    onPage(g, 3, 'https://mail.example.org/inbox');
    assert.equal(g.decide(ID, C('get_page_text'), { tabId: 3 }).verdict, 'deny');
    assert.equal(g.decide(ID, C('computer'), { tabId: 3, action: 'left_click', ref: 'r', action_summary: 'x' }).verdict, 'ask');
  });

  it('knows no page after a browser result it could not read', () => {
    const g = guard();
    onPage(g, 1, 'https://httpbin.org/forms/post');
    g.observeTabs(ID, null);
    assert.equal(g.decide(ID, C('read_page'), { tabId: 1 }).verdict, 'deny');
  });

  it('drops closed tabs and ignores malformed entries', () => {
    const g = guard();
    g.observeTabs(ID, [{ tabId: 1, url: 'https://portal.example.it/' }, { tabId: 'x', url: 'https://portal.example.it/' }, { tabId: 2 }]);
    assert.equal(g.decide(ID, C('read_page'), { tabId: 1 }).verdict, 'allow');
    g.observeTabs(ID, []);
    assert.equal(g.decide(ID, C('read_page'), { tabId: 1 }).verdict, 'deny');
  });
});

describe('BrowserGuard: browser_batch', () => {
  it('allows a batch of free actions', () => {
    const g = guard();
    onPage(g, 1, 'https://httpbin.org/forms/post');
    const r = g.decide(ID, C('browser_batch'), { actions: [
      { name: 'find', input: { tabId: 1, query: 'name' } },
      { name: 'form_input', input: { tabId: 1, ref: 'ref_3', value: 'Polpo' } },
      { name: 'computer', input: { tabId: 1, action: 'screenshot' } },
    ] });
    assert.equal(r.verdict, 'allow');
  });

  it('judges each item: one denied item denies the batch', () => {
    const g = guard();
    onPage(g, 1, 'https://httpbin.org/forms/post');
    const r = g.decide(ID, C('browser_batch'), { actions: [
      { name: 'computer', input: { tabId: 1, action: 'screenshot' } },
      { name: 'javascript_tool', input: { tabId: 1, action: 'javascript_exec', text: 'document.cookie' } },
    ] });
    assert.equal(r.verdict, 'deny');
    assert.match(r.message, /javascript_tool is not allowed/);
  });

  it('accepts full tool names in items, and refuses unknown or nested ones', () => {
    const g = guard();
    onPage(g, 1, 'https://httpbin.org/');
    assert.equal(g.decide(ID, C('browser_batch'), { actions: [{ name: C('switch_browser'), input: {} }] }).verdict, 'deny');
    assert.equal(g.decide(ID, C('browser_batch'), { actions: [{ name: 'browser_batch', input: { actions: [] } }] }).verdict, 'deny');
    assert.equal(g.decide(ID, C('browser_batch'), { actions: [{ name: 'evaluate', input: {} }] }).verdict, 'deny');
    assert.equal(g.decide(ID, C('browser_batch'), { actions: [] }).verdict, 'deny');
    assert.equal(g.decide(ID, C('browser_batch'), {}).verdict, 'deny');
  });

  it('relays the whole batch when a commit in it needs approval, listing each commit', () => {
    const g = guard();
    onPage(g, 1, 'https://httpbin.org/forms/post');
    const r = g.decide(ID, C('browser_batch'), { actions: [
      { name: 'form_input', input: { tabId: 1, ref: 'ref_3', value: 'Polpo' } },
      { name: 'computer', input: { tabId: 1, action: 'left_click', ref: 'ref_9', action_summary: 'Submits the order' } },
    ] });
    assert.equal(r.verdict, 'ask');
    assert.deepEqual(r.details, ['Submits the order (https://httpbin.org/forms/post)']);
  });

  it('refuses actions on a tab after a click on it in the same batch, grant or not', () => {
    const g = guard();
    onPage(g, 1, 'https://httpbin.org/forms/post');
    g.grant(ID, 'httpbin.org', 10);
    const r = g.decide(ID, C('browser_batch'), { actions: [
      { name: 'computer', input: { tabId: 1, action: 'left_click', ref: 'ref_9', action_summary: 'Submits' } },
      { name: 'computer', input: { tabId: 1, action: 'screenshot' } },
    ] });
    assert.equal(r.verdict, 'deny');
    assert.match(r.message, /separate call/);
    const r2 = g.decide(ID, C('browser_batch'), { actions: [
      { name: 'computer', input: { tabId: 1, action: 'left_click', ref: 'ref_9', action_summary: 'Submits' } },
      { name: 'computer', input: { tabId: 1, action: 'left_click', ref: 'ref_10', action_summary: 'Confirms' } },
    ] });
    assert.equal(r2.verdict, 'deny');
    // A refused batch changes nothing: the page is still known.
    assert.equal(g.decide(ID, C('computer'), { tabId: 1, action: 'screenshot' }).verdict, 'allow');
  });

  it('refuses reads after a navigate in the same batch: it may have redirected anywhere', () => {
    const g = guard();
    const r = g.decide(ID, C('browser_batch'), { actions: [
      { name: 'navigate', input: { tabId: 4, url: 'https://httpbin.org/redirect-to?url=https://mail.example.org/' } },
      { name: 'get_page_text', input: { tabId: 4 } },
    ] });
    assert.equal(r.verdict, 'deny');
  });

  it('still allows free actions on another tab after a click in the batch', () => {
    const g = guard();
    onPage(g, 1, 'https://httpbin.org/forms/post');
    g.observeTabs(ID, [{ tabId: 1, url: 'https://httpbin.org/forms/post' }, { tabId: 2, url: 'https://httpbin.org/' }]);
    g.grant(ID, 'httpbin.org', 10);
    const r = g.decide(ID, C('browser_batch'), { actions: [
      { name: 'computer', input: { tabId: 1, action: 'left_click', ref: 'ref_9', action_summary: 'Submits' } },
      { name: 'get_page_text', input: { tabId: 2 } },
    ] });
    assert.equal(r.verdict, 'allow');
  });

  it('denies a batch that navigates off the sites, even after free items', () => {
    const g = guard();
    onPage(g, 1, 'https://httpbin.org/');
    const r = g.decide(ID, C('browser_batch'), { actions: [
      { name: 'computer', input: { tabId: 1, action: 'screenshot' } },
      { name: 'navigate', input: { tabId: 1, url: 'https://mail.google.com/' } },
    ] });
    assert.equal(r.verdict, 'deny');
  });
});

describe('BrowserGuard: tools denied by default', () => {
  it('denies the unlockable tools unless the site file allows them', () => {
    const g = guard();
    onPage(g, 1, 'https://httpbin.org/');
    for (const t of ['javascript_tool', 'file_upload', 'upload_image', 'shortcuts_execute', 'shortcuts_list',
      'read_network_requests', 'read_console_messages', 'gif_creator', 'resize_window']) {
      assert.equal(g.decide(ID, C(t), { tabId: 1 }).verdict, 'deny', t);
    }
  });

  it('never allows switching browsers', () => {
    const g = guard({ allowTools: [] });
    for (const t of ['select_browser', 'switch_browser', 'list_connected_browsers']) {
      assert.equal(g.decide(ID, C(t), {}).verdict, 'deny', t);
    }
  });

  it('relays an unlocked tool every time, grant or not, and only on the sites', () => {
    const g = guard({ allowTools: ['file_upload'] });
    onPage(g, 1, 'https://httpbin.org/forms/post');
    g.grant(ID, 'httpbin.org', 10);
    assert.equal(g.decide(ID, C('file_upload'), { tabId: 1, paths: ['/x'], ref: 'r' }).verdict, 'ask');
    onPage(g, 1, 'https://mail.example.org/');
    assert.equal(g.decide(ID, C('file_upload'), { tabId: 1, paths: ['/x'], ref: 'r' }).verdict, 'deny');
  });

  it('refuses everything for a session that is not a browser session', () => {
    const g = guard();
    assert.equal(g.decide('other', C('read_page'), { tabId: 1 }).verdict, 'deny');
  });
});

describe('BrowserGuard: grant requests', () => {
  it('accepts a plan on a session site, capped at the host maximum', () => {
    const g = guard();
    assert.deepEqual(g.checkGrantRequest(ID, 'Portal.Example.it', 120), { ok: true, host: 'portal.example.it', minutes: 15 });
  });

  it('refuses another site, bad minutes, and says when no grant is needed or possible', () => {
    const g = guard({ levels: { 'httpbin.org': 'free', 'portal.example.it': 'every-commit' } });
    assert.equal(g.checkGrantRequest(ID, 'mail.example.org', 5).error, 'site_not_allowed');
    assert.equal(g.checkGrantRequest(ID, 'httpbin.org', 5).error, 'grant_not_needed');
    assert.equal(g.checkGrantRequest(ID, 'portal.example.it', 5).error, 'grant_not_available');
    const g2 = guard();
    assert.equal(g2.checkGrantRequest(ID, 'httpbin.org', 0).error, 'invalid_minutes');
    assert.equal(g2.checkGrantRequest(ID, 'httpbin.org', 2.5).error, 'invalid_minutes');
    assert.equal(g2.checkGrantRequest('other', 'httpbin.org', 5).error, 'not_a_browser_session');
  });
});

describe('browser CLI arguments', () => {
  it('asks for the whole browser server and each tool; pre-allows only by exact name', () => {
    const a = browserCliArgs(['javascript_tool']);
    assert.deepEqual(a.allowedTools, [...TAB_TOOLS.map(C), 'mcp__polpo__polpo_request_browser_grant']);
    assert.equal(a.askTools[0], 'mcp__claude-in-chrome', 'a tool a later extension adds is guarded too');
    assert.equal(a.askTools.length, GUARDED_TOOLS.length + 1);
    assert.ok(a.askTools.includes(C('browser_batch')));
    assert.ok(!a.allowedTools.includes('mcp__claude-in-chrome'), 'never allow the whole server');
    assert.deepEqual(a.disallowedTools, [C('javascript_tool')]);
  });

  it('names all 22 tools between the two lists', () => {
    const a = browserCliArgs([]);
    assert.equal(a.askTools.length - 1 + TAB_TOOLS.length, 22);
  });

  it('refuses at the CLI the tools the host did not unlock', () => {
    const g = guard({ allowTools: ['file_upload'] });
    const d = g.disallowedTools(ID);
    assert.ok(d.includes('javascript_tool'));
    assert.ok(d.includes('switch_browser'));
    assert.ok(!d.includes('file_upload'));
  });
});

describe('loadSiteConfig', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-sites-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const write = (name, data, mode) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
    fs.chmodSync(p, mode === undefined ? 0o600 : mode);
    return p;
  };

  it('reads levels and unlocked tools', () => {
    const c = loadSiteConfig(write('s.json', { sites: { 'portal.example.it': 'every-commit', '*.example.com': 'free' }, allowTools: ['file_upload'] }));
    assert.equal(c.levels.get('portal.example.it'), 'every-commit');
    assert.equal(c.levels.get('*.example.com'), 'free');
    assert.ok(c.allowTools.has('file_upload'));
  });

  it('treats a missing file as no settings', () => {
    const c = loadSiteConfig(path.join(dir, 'none.json'));
    assert.equal(c.levels.size, 0);
    assert.equal(c.allowTools.size, 0);
  });

  it('refuses a file others can read or write, a link, bad JSON, unknown keys, levels and tools', () => {
    assert.throws(() => loadSiteConfig(write('a.json', {}, 0o644)), /mode 0600/);
    const target = write('t.json', {});
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(target, link);
    assert.throws(() => loadSiteConfig(link), /not a link/);
    assert.throws(() => loadSiteConfig(write('b.json', '{')), /not valid JSON/);
    assert.throws(() => loadSiteConfig(write('c.json', { site: {} })), /unknown key/);
    assert.throws(() => loadSiteConfig(write('d.json', { sites: { 'portal.example.it': 'yolo' } })), /level of/);
    assert.throws(() => loadSiteConfig(write('e.json', { sites: { '127.0.0.1': 'free' } })), /Invalid site/);
    assert.throws(() => loadSiteConfig(write('f.json', { allowTools: ['switch_browser'] })), /never be allowed/);
    assert.throws(() => loadSiteConfig(write('g.json', { allowTools: ['computer'] })), /not a tool that can be allowed/);
  });

  it('refuses a file owned by another user', () => {
    const p = write('o.json', {});
    assert.throws(() => loadSiteConfig(p, { uid: process.getuid() + 1 }), /owned by the user/);
  });
});

describe('parseGrantMaxMinutes', () => {
  it('defaults to 15 and accepts 1 to 60', () => {
    assert.equal(parseGrantMaxMinutes(undefined), 15);
    assert.equal(parseGrantMaxMinutes('60'), 60);
    for (const bad of ['0', '61', '2.5', 'ten']) assert.throws(() => parseGrantMaxMinutes(bad), /1 to 60/);
  });
});
