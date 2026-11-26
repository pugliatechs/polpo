'use strict';

/**
 * Browser guard: polpo's decision on every Claude in Chrome tool call of a
 * session the gateway opened with `browser: {sites}`.
 *
 * Where it is enforced: the session's CLI runs with an `ask` permission
 * rule for the whole Claude in Chrome server and for each of its tools, so
 * every call reaches polpo's permission prompt tool, in every permission
 * mode (a plain `auto` run lets these tools through without asking), and
 * a tool a later extension adds does too. An `ask` rule beats an `allow`,
 * so the three tab tools reach polpo as well, which allows them at once. The CLI's
 * own rules only see the outer browser_batch call, never the actions in
 * it, so the per-action rules live here and a batch is judged item by
 * item. The strictest verdict wins: deny, then ask, then allow.
 *
 *   allow  free: reading and filling on the session's sites, navigating
 *          to them, and commits on a site whose level is "free" or that
 *          has an active grant
 *   ask    relayed to the operator as an approval
 *   deny   refused, with a message telling the agent why
 *
 * A tab's current URL comes from the "Tab Context" block that ends every
 * browser tool result (wrapped.js forwards it as browser_tabs) and from
 * the navigations polpo allowed. A URL polpo does not know is not on the
 * session's sites and is not covered by any grant.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const CHROME_PREFIX = 'mcp__claude-in-chrome__';
const GRANT_TOOL = 'mcp__polpo__polpo_request_browser_grant';

// Pre-allowed by exact name: no URL, no page content beyond tab titles.
const TAB_TOOLS = Object.freeze(['tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp']);

// Every other browser tool gets an `ask` rule, so it reaches polpo.
const GUARDED_TOOLS = Object.freeze([
  'browser_batch', 'computer', 'file_upload', 'find', 'form_input', 'get_page_text', 'gif_creator',
  'javascript_tool', 'list_connected_browsers', 'navigate', 'read_console_messages',
  'read_network_requests', 'read_page', 'resize_window', 'select_browser', 'shortcuts_execute',
  'shortcuts_list', 'switch_browser', 'upload_image',
]);

const READ_TOOLS = new Set(['read_page', 'get_page_text', 'find']);
const COMPUTER_FREE = new Set(['screenshot', 'zoom', 'scroll', 'scroll_to', 'wait', 'hover']);
const COMPUTER_COMMIT = new Set(['left_click', 'double_click', 'triple_click', 'right_click', 'left_click_drag', 'key']);

// Denied unless the host's site file unlocks them; an unlocked one is
// relayed on every call and never covered by a grant.
//   javascript_tool       runs arbitrary code in the page
//   file_upload, upload_image  send files or images to the site
//   shortcuts_*           run saved prompts in the extension
//   read_network_requests, read_console_messages  the model sees raw
//                         headers and logs, tokens included; polpo can only
//                         redact what it relays, not what the model reads
//   gif_creator           downloads a recording of the session
//   resize_window         resizes the operator's whole Chrome window
const UNLOCKABLE_TOOLS = new Set([
  'javascript_tool', 'file_upload', 'upload_image', 'shortcuts_execute', 'shortcuts_list',
  'read_network_requests', 'read_console_messages', 'gif_creator', 'resize_window',
]);
// Never: they can leave the agent's tab group, or this machine.
const NEVER_TOOLS = new Set(['select_browser', 'switch_browser', 'list_connected_browsers']);

const SITE_LEVELS = new Set(['free', 'plan', 'every-commit']);
const DEFAULT_LEVEL = 'plan';
const MAX_SITES = 20;
const MAX_BATCH_ITEMS = 50;
const MAX_TABS = 50;
const MAX_URL_CHARS = 4096;
const MAX_SUMMARY_CHARS = 200;

const DEFAULT_GRANT_MAX_MINUTES = 15;
const GRANT_MAX_MINUTES_CEILING = 60;

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BLANK_URLS = new Set(['about:blank', 'chrome://newtab/', 'chrome://new-tab-page/']);

/** A DNS host name as polpo compares it: lower case, no trailing dot. */
function normalizeHost(host) {
  if (typeof host !== 'string') return null;
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  return h || null;
}

/**
 * Whether a host name may appear in a session's sites: an ASCII DNS name
 * with at least two labels, not an IP address, not localhost. Loopback is
 * out because polpo's own dashboard listens there.
 */
function isAllowedHostName(h) {
  if (!h || h.length > 253) return false;
  if (net.isIP(h)) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return false;
  const labels = h.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => LABEL_RE.test(l))) return false;
  // A last label of digits only is an address, not a domain.
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return false;
  return true;
}

/**
 * Parse a session's `browser.sites`. An entry is a host name
 * ("portal.example.it") or "*." and a host name ("*.example.it"), which
 * matches the subdomains only, not example.it itself.
 * @returns {{ok: true, sites: string[]} | {ok: false, message: string}}
 */
function parseSites(list) {
  if (!Array.isArray(list) || !list.length) {
    return { ok: false, message: 'browser.sites must be a non-empty list of host names.' };
  }
  if (list.length > MAX_SITES) return { ok: false, message: 'browser.sites lists at most ' + MAX_SITES + ' sites.' };
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') return { ok: false, message: 'Each site is a host name string.' };
    const entry = raw.trim().toLowerCase().replace(/\.$/, '');
    const wildcard = entry.startsWith('*.');
    const host = wildcard ? entry.slice(2) : entry;
    if (!isAllowedHostName(host)) {
      return {
        ok: false,
        message: 'Invalid site ' + JSON.stringify(raw.slice(0, 100)) + ': give a host name such as portal.example.it or '
          + '*.example.it (subdomains only), with no scheme, port or path. IP addresses and localhost are not allowed.',
      };
    }
    const key = wildcard ? '*.' + host : host;
    if (!out.includes(key)) out.push(key);
  }
  return { ok: true, sites: out };
}

/** Whether a host matches a site entry ("*.x.y" matches subdomains only). */
function siteMatches(site, host) {
  if (!host) return false;
  if (site.startsWith('*.')) {
    const base = site.slice(2);
    return host.length > base.length && host.endsWith('.' + base);
  }
  return host === site;
}

function onSites(sites, host) {
  return !!host && sites.some((s) => siteMatches(s, host));
}

/**
 * Parse a URL the way the browser tools use it. `navigate` accepts one
 * without a scheme and then uses https.
 * @returns {{kind: 'web', host: string, display: string} | {kind: 'blank'} | {kind: 'other'} | null}
 */
function parseBrowserUrl(raw, opts) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > MAX_URL_CHARS) return null;
  if (BLANK_URLS.has(s)) return { kind: 'blank' };
  let candidate = s;
  if (opts && opts.defaultHttps && !/^[a-z][a-z0-9+.-]*:/i.test(s)) candidate = 'https://' + s;
  let u;
  try { u = new URL(candidate); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'other' };
  if (u.username || u.password) return { kind: 'other' };
  const host = normalizeHost(u.hostname);
  if (!host) return null;
  // Shown to the operator: origin and path only. A query string can carry
  // session tokens.
  return { kind: 'web', host, display: u.origin + u.pathname };
}

/**
 * Read and check the host's site file (POLPO_BROWSER_SITES_FILE):
 *
 *   { "sites": { "portal.example.it": "every-commit", "*.example.com": "free" },
 *     "allowTools": ["file_upload"] }
 *
 * A missing file means every site is "plan" and nothing is unlocked. A
 * file that is a symlink, not owned by polpo's user, or readable or
 * writable by anyone else, is refused.
 * @throws {Error} with a message naming the problem
 */
function loadSiteConfig(file, opts) {
  const o = opts || {};
  const empty = { levels: new Map(), allowTools: new Set() };
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return empty;
    throw new Error('browser site file ' + file + ': ' + err.message);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('browser site file ' + file + ' must be a regular file, not a link.');
  const uid = o.uid !== undefined ? o.uid : (typeof process.getuid === 'function' ? process.getuid() : null);
  if (uid !== null && st.uid !== uid) throw new Error('browser site file ' + file + ' must be owned by the user polpo runs as.');
  if ((st.mode & 0o077) !== 0) throw new Error('browser site file ' + file + ' must have mode 0600 (chmod 600 ' + file + ').');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error('browser site file ' + file + ' is not valid JSON: ' + err.message);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('browser site file ' + file + ' must be a JSON object.');
  for (const k of Object.keys(data)) {
    if (k !== 'sites' && k !== 'allowTools') throw new Error('browser site file ' + file + ': unknown key ' + JSON.stringify(k) + '.');
  }
  const levels = new Map();
  if (data.sites !== undefined) {
    if (!data.sites || typeof data.sites !== 'object' || Array.isArray(data.sites)) {
      throw new Error('browser site file ' + file + ': "sites" maps host names to a level.');
    }
    for (const [site, level] of Object.entries(data.sites)) {
      const parsed = parseSites([site]);
      if (!parsed.ok) throw new Error('browser site file ' + file + ': ' + parsed.message);
      if (!SITE_LEVELS.has(level)) {
        throw new Error('browser site file ' + file + ': level of ' + site + ' must be one of ' + [...SITE_LEVELS].join(', ') + '.');
      }
      levels.set(parsed.sites[0], level);
    }
  }
  const allowTools = new Set();
  if (data.allowTools !== undefined) {
    if (!Array.isArray(data.allowTools)) throw new Error('browser site file ' + file + ': "allowTools" is a list of tool names.');
    for (const t of data.allowTools) {
      const name = typeof t === 'string' ? t.replace(CHROME_PREFIX, '') : '';
      if (NEVER_TOOLS.has(name)) throw new Error('browser site file ' + file + ': ' + name + ' can never be allowed.');
      if (!UNLOCKABLE_TOOLS.has(name)) throw new Error('browser site file ' + file + ': ' + JSON.stringify(t) + ' is not a tool that can be allowed.');
      allowTools.add(name);
    }
  }
  return { levels, allowTools };
}

function defaultSiteFile() {
  return path.join(os.homedir(), '.config', 'polpo', 'browser-sites.json');
}

/** POLPO_BROWSER_GRANT_MAX_MINUTES, checked; a bad value stops polpo. */
function parseGrantMaxMinutes(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_GRANT_MAX_MINUTES;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > GRANT_MAX_MINUTES_CEILING) {
    throw new Error('POLPO_BROWSER_GRANT_MAX_MINUTES must be a whole number from 1 to ' + GRANT_MAX_MINUTES_CEILING + '.');
  }
  return n;
}

function verdictRank(v) {
  return v === 'deny' ? 2 : (v === 'ask' ? 1 : 0);
}

function capSummary(s) {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > MAX_SUMMARY_CHARS ? t.slice(0, MAX_SUMMARY_CHARS - 3) + '...' : t;
}

class BrowserGuard {
  /**
   * @param {object} [opts]
   * @param {number} [opts.grantMaxMinutes]
   * @param {function} [opts.loadConfig] - () => {levels, allowTools}; read
   *   when a session starts, so an edit to the site file applies to the
   *   next session without a restart
   * @param {function} [opts.now] - injectable clock, for tests
   */
  constructor(opts) {
    const o = opts || {};
    this.grantMaxMinutes = o.grantMaxMinutes || DEFAULT_GRANT_MAX_MINUTES;
    this._loadConfig = o.loadConfig || (() => ({ levels: new Map(), allowTools: new Set() }));
    this._now = o.now || Date.now;
    // instanceId -> { sites, config, tabs: Map<tabId, {host, kind, display}>, grants: Map<host, expiresAt>, plan }
    this._sessions = new Map();
  }

  /** Start guarding a session. Reads the site file now. */
  register(instanceId, sites) {
    const config = this._loadConfig();
    this._sessions.set(instanceId, { sites: sites.slice(), config, tabs: new Map(), grants: new Map(), plan: null });
  }

  has(instanceId) {
    return this._sessions.has(instanceId);
  }

  sitesOf(instanceId) {
    const s = this._sessions.get(instanceId);
    return s ? s.sites.slice() : null;
  }

  /** The tools the CLI should refuse outright for this session. */
  disallowedTools(instanceId) {
    const s = this._sessions.get(instanceId);
    const unlocked = s ? s.config.allowTools : new Set();
    return [...NEVER_TOOLS, ...[...UNLOCKABLE_TOOLS].filter((t) => !unlocked.has(t))];
  }

  forget(instanceId) {
    this._sessions.delete(instanceId);
  }

  /** End every grant of a session (abort, release). */
  revokeGrants(instanceId) {
    const s = this._sessions.get(instanceId);
    if (s) s.grants.clear();
  }

  /**
   * The tabs a tool result's "Tab Context" listed. The list is complete:
   * a tab it leaves out was closed. null: a browser tool result came back
   * without a block polpo could read, so no page is known any more.
   */
  observeTabs(instanceId, tabs) {
    const s = this._sessions.get(instanceId);
    if (!s) return false;
    if (tabs === null) {
      for (const tabId of s.tabs.keys()) s.tabs.set(tabId, { kind: 'unknown' });
      return true;
    }
    if (!Array.isArray(tabs)) return false;
    const next = new Map();
    for (const t of tabs.slice(0, MAX_TABS)) {
      if (!t || !Number.isSafeInteger(t.tabId) || typeof t.url !== 'string' || t.url.length > MAX_URL_CHARS) continue;
      const parsed = parseBrowserUrl(t.url);
      next.set(t.tabId, parsed && parsed.kind === 'web'
        ? { kind: 'web', host: parsed.host, display: parsed.display }
        : { kind: parsed && parsed.kind === 'blank' ? 'blank' : 'other', host: null, display: t.url.slice(0, 200) });
    }
    s.tabs = next;
    return true;
  }

  levelFor(instanceId, host) {
    const s = this._sessions.get(instanceId);
    if (!s || !host) return DEFAULT_LEVEL;
    if (s.config.levels.has(host)) return s.config.levels.get(host);
    for (const [site, level] of s.config.levels) {
      if (site.startsWith('*.') && siteMatches(site, host)) return level;
    }
    return DEFAULT_LEVEL;
  }

  /** Expiry of the grant covering a host, or null. Expired ones are dropped. */
  activeGrant(instanceId, host) {
    const s = this._sessions.get(instanceId);
    if (!s || !host) return null;
    const exp = s.grants.get(host);
    if (!exp) return null;
    if (exp <= this._now()) {
      s.grants.delete(host);
      return null;
    }
    return exp;
  }

  /**
   * Check a grant request before it is put to the operator.
   * @returns {{ok: true, host: string, minutes: number} | {ok: false, error: string, message: string}}
   */
  checkGrantRequest(instanceId, site, minutes) {
    const s = this._sessions.get(instanceId);
    if (!s) return { ok: false, error: 'not_a_browser_session', message: 'This session has no browser.' };
    const host = normalizeHost(site);
    if (!host || !isAllowedHostName(host) || !onSites(s.sites, host)) {
      return { ok: false, error: 'site_not_allowed', message: 'Request a grant for one of the session\'s sites: ' + s.sites.join(', ') + '.' };
    }
    const level = this.levelFor(instanceId, host);
    if (level === 'free') {
      return { ok: false, error: 'grant_not_needed', message: 'Commits on ' + host + ' need no grant on this host: go ahead.' };
    }
    if (level === 'every-commit') {
      return {
        ok: false,
        error: 'grant_not_available',
        message: 'On ' + host + ' every commit is approved on its own, so there is no grant. Go ahead: each click or key that commits will be put to the user.',
      };
    }
    if (!Number.isInteger(minutes) || minutes < 1) {
      return { ok: false, error: 'invalid_minutes', message: 'minutes must be a whole number of at least 1.' };
    }
    return { ok: true, host, minutes: Math.min(minutes, this.grantMaxMinutes) };
  }

  /** Grant commits on a host until now + minutes. */
  grant(instanceId, host, minutes) {
    const s = this._sessions.get(instanceId);
    if (!s) return null;
    const expiresAt = this._now() + Math.min(minutes, this.grantMaxMinutes) * 60_000;
    s.grants.set(host, expiresAt);
    return expiresAt;
  }

  /** The plan approval waiting on the operator, with its screenshot. */
  setPendingPlan(instanceId, plan) {
    const s = this._sessions.get(instanceId);
    if (s) s.plan = plan;
  }

  pendingPlan(instanceId) {
    const s = this._sessions.get(instanceId);
    return s ? s.plan : null;
  }

  clearPendingPlan(instanceId, toolUseId) {
    const s = this._sessions.get(instanceId);
    if (s && s.plan && (!toolUseId || s.plan.toolUseId === toolUseId)) s.plan = null;
  }

  /**
   * Decide on a browser tool call.
   *
   * @param {string} instanceId
   * @param {string} toolName - full name (mcp__claude-in-chrome__computer)
   * @param {object} input
   * @returns {{verdict: 'allow'|'ask'|'deny', message?: string, description?: string, details?: string[]}}
   */
  decide(instanceId, toolName, input) {
    const s = this._sessions.get(instanceId);
    if (!s) return { verdict: 'deny', message: 'Browser tools are not enabled for this session.' };
    const name = typeof toolName === 'string' ? toolName.replace(CHROME_PREFIX, '') : '';
    // A working copy: actions in a batch see the effect of the ones before.
    // changed: tabs a navigate or a commit earlier in the same batch acted
    // on. Their page is unknown until the result says where they are.
    const ctx = { s, tabs: s.tabs, changed: new Set(), inBatch: false, commits: [], denial: null };
    let verdict;
    if (name === 'browser_batch') {
      const actions = input && Array.isArray(input.actions) ? input.actions : null;
      if (!actions || !actions.length || actions.length > MAX_BATCH_ITEMS) {
        return { verdict: 'deny', message: 'browser_batch needs 1 to ' + MAX_BATCH_ITEMS + ' actions.' };
      }
      ctx.inBatch = true;
      verdict = 'allow';
      for (const item of actions) {
        const itemName = item && typeof item.name === 'string' ? item.name.replace(CHROME_PREFIX, '') : '';
        const v = itemName === 'browser_batch'
          ? this._deny(ctx, 'browser_batch cannot be nested.')
          : this._decideOne(ctx, instanceId, itemName, item && item.input);
        if (verdictRank(v) > verdictRank(verdict)) verdict = v;
        if (verdict === 'deny') break;
      }
    } else {
      verdict = this._decideOne(ctx, instanceId, name, input);
    }
    if (verdict === 'deny') return { verdict, message: ctx.denial || 'Refused by polpo.' };
    if (verdict === 'allow') {
      // After a navigate (which may redirect anywhere), a click or a key,
      // the page is unknown until the next tool result says where the tab is.
      for (const tabId of ctx.changed) s.tabs.set(tabId, { kind: 'unknown' });
      return { verdict };
    }
    // Put to the user: nothing has run yet, and a rejection leaves the
    // tabs where they are. On approval, committed() forgets the pages of
    // the tabs it acts on.
    const touched = new Set(ctx.changed);
    const lines = ctx.commits.map((c) => (c.summary || c.action) + ' (' + (c.url || 'page unknown') + ')');
    const firstHost = ctx.commits.length && ctx.commits[0].host ? ctx.commits[0].host : 'the browser';
    return {
      verdict,
      description: 'Browser on ' + firstHost + ': ' + (lines[0] || 'an action that needs your approval'),
      details: lines,
      touchedTabs: [...touched],
    };
  }

  /**
   * The user approved a call that was put to them: the pages of the tabs
   * it acts on are unknown until the next tool result.
   */
  committed(instanceId, tabIds) {
    const s = this._sessions.get(instanceId);
    if (!s || !Array.isArray(tabIds)) return;
    for (const tabId of tabIds) if (Number.isSafeInteger(tabId)) s.tabs.set(tabId, { kind: 'unknown' });
  }

  _deny(ctx, message) {
    if (!ctx.denial) ctx.denial = message;
    return 'deny';
  }

  _tab(ctx, input) {
    const tabId = input && Number.isSafeInteger(input.tabId) ? input.tabId : null;
    if (tabId === null) return { tabId: null, state: null };
    if (ctx.changed.has(tabId)) return { tabId, state: { kind: 'changed' } };
    return { tabId, state: ctx.tabs.get(tabId) || { kind: 'unknown' } };
  }

  /** After a navigate, click or key in the same batch: the page may be anywhere. */
  _changed(ctx, tabId, what) {
    return this._deny(ctx, what + ' follows a navigation or a click on tab ' + tabId + ' in the same browser_batch: '
      + 'polpo does not know that page yet. Send it as a separate call, after the result.');
  }

  /** Reading or filling: free on the session's sites and on a blank tab. */
  _free(ctx, input, what) {
    const { tabId, state } = this._tab(ctx, input);
    if (tabId === null) return this._deny(ctx, what + ' needs a tabId.');
    if (state.kind === 'changed') return this._changed(ctx, tabId, what);
    if (state.kind === 'blank') return 'allow';
    if (state.kind === 'web' && onSites(ctx.s.sites, state.host)) return 'allow';
    if (state.kind === 'unknown') {
      return this._deny(ctx, 'polpo does not know which page tab ' + tabId + ' shows now. Call tabs_context_mcp, then try again.');
    }
    return this._deny(ctx, 'Tab ' + tabId + ' is on ' + (state.host || 'a page') + ', which is not one of this session\'s sites ('
      + ctx.s.sites.join(', ') + '). Navigate back to one of them.');
  }

  /** A commit: needs the site's level, a grant, or the operator. */
  _commit(ctx, instanceId, input, action) {
    const { tabId, state } = this._tab(ctx, input);
    if (state && state.kind === 'changed') return this._changed(ctx, tabId, action);
    const summary = capSummary(input && input.action_summary);
    const known = state && state.kind === 'web';
    const host = known ? state.host : null;
    if (tabId !== null) ctx.changed.add(tabId);
    if (known && onSites(ctx.s.sites, host)) {
      const level = this.levelFor(instanceId, host);
      if (level === 'free') return 'allow';
      if (level === 'plan' && this.activeGrant(instanceId, host)) return 'allow';
    }
    ctx.commits.push({ action, summary, url: known ? state.display : null, host });
    return 'ask';
  }

  _decideOne(ctx, instanceId, name, input) {
    const s = ctx.s;
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
    if (TAB_TOOLS.includes(name)) return 'allow';
    if (NEVER_TOOLS.has(name)) return this._deny(ctx, name + ' is never allowed: it can leave this session\'s tab group or this machine.');
    if (UNLOCKABLE_TOOLS.has(name)) {
      if (!s.config.allowTools.has(name)) {
        return this._deny(ctx, name + ' is not allowed on this host.');
      }
      // Unlocked by the host: relayed every time, never covered by a grant.
      const { tabId, state } = this._tab(ctx, input);
      if (tabId !== null) {
        if (state.kind === 'changed') return this._changed(ctx, tabId, name);
        const ok = state.kind === 'blank' || (state.kind === 'web' && onSites(s.sites, state.host));
        if (!ok) return this._deny(ctx, name + ' only runs on this session\'s sites.');
        ctx.changed.add(tabId);
      }
      ctx.commits.push({
        action: name,
        summary: capSummary(input.action_summary),
        url: state && state.kind === 'web' ? state.display : null,
        host: state && state.kind === 'web' ? state.host : null,
      });
      return 'ask';
    }
    if (READ_TOOLS.has(name)) return this._free(ctx, input, name);
    if (name === 'form_input') return this._free(ctx, input, 'form_input');
    if (name === 'navigate') {
      const url = input.url;
      if (url === 'back' || url === 'forward') return this._commit(ctx, instanceId, input, 'navigate ' + url);
      const parsed = parseBrowserUrl(url, { defaultHttps: true });
      if (!parsed || parsed.kind !== 'web' || !onSites(s.sites, parsed.host)) {
        return this._deny(ctx, 'navigate only goes to this session\'s sites (' + s.sites.join(', ') + ').');
      }
      // A site can redirect anywhere (httpbin.org has /redirect-to): the
      // page is unknown until the navigate's own result reports it.
      if (Number.isSafeInteger(input.tabId)) ctx.changed.add(input.tabId);
      return 'allow';
    }
    if (name === 'computer') {
      const action = input.action;
      if (COMPUTER_FREE.has(action)) return this._free(ctx, input, 'computer ' + action);
      if (action === 'type') {
        const text = typeof input.text === 'string' ? input.text : '';
        // A newline submits a form or a message: that commits.
        if (/[\r\n]/.test(text)) return this._commit(ctx, instanceId, input, 'type and Enter');
        return this._free(ctx, input, 'computer type');
      }
      if (COMPUTER_COMMIT.has(action)) return this._commit(ctx, instanceId, input, action.replace(/_/g, ' '));
      return this._deny(ctx, 'computer action ' + JSON.stringify(String(action).slice(0, 40)) + ' is not known to polpo.');
    }
    return this._deny(ctx, 'Tool ' + JSON.stringify(String(name).slice(0, 60)) + ' is not known to polpo.');
  }
}

/** The CLI arguments that put a browser session under the guard. */
function browserCliArgs(disallowed) {
  return {
    allowedTools: [...TAB_TOOLS.map((t) => CHROME_PREFIX + t), GRANT_TOOL],
    // The whole server first, so tools added later are guarded too.
    askTools: [CHROME_PREFIX.replace(/__$/, ''), ...GUARDED_TOOLS.map((t) => CHROME_PREFIX + t)],
    disallowedTools: (disallowed || []).map((t) => CHROME_PREFIX + t),
  };
}

module.exports = {
  BrowserGuard,
  parseSites,
  siteMatches,
  parseBrowserUrl,
  loadSiteConfig,
  defaultSiteFile,
  parseGrantMaxMinutes,
  browserCliArgs,
  isAllowedHostName,
  CHROME_PREFIX,
  GRANT_TOOL,
  TAB_TOOLS,
  GUARDED_TOOLS,
  UNLOCKABLE_TOOLS,
  NEVER_TOOLS,
  DEFAULT_GRANT_MAX_MINUTES,
};
