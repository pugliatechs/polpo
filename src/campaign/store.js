/**
 * CampaignStore: campaign state across restarts.
 *
 * One directory per campaign under ~/.config/polpo/campaigns/<id>/
 * (mode 0700): state.json, rewritten atomically like GoalStore does,
 * the ledger, and gate logs. The pin (the approved definition's hash and
 * the pinned paths' hashes) lives in state.json, outside the repository
 * the agent works in.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ID_RE } = require('./definition');
const { makeLogger } = require('../util/logger');

const log = makeLogger('campaign-store');

const DEFAULT_ROOT = path.join(os.homedir(), '.config', 'polpo', 'campaigns');

class CampaignStore {
  /** @param {object} [opts] - { root } */
  constructor(opts) {
    this.root = (opts && opts.root) || DEFAULT_ROOT;
  }

  dirFor(id) {
    if (!ID_RE.test(String(id || ''))) throw new Error('invalid campaign id');
    return path.join(this.root, id);
  }

  ledgerPath(id) { return path.join(this.dirFor(id), 'ledger.jsonl'); }

  gateLogDir(id) { return path.join(this.dirFor(id), 'gates'); }

  exists(id) {
    try { return fs.statSync(this.dirFor(id)).isDirectory(); } catch { return false; }
  }

  /** Create the campaign's directory; false when it already exists. */
  create(id) {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(this.dirFor(id), { mode: 0o700 });
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
    fs.mkdirSync(this.gateLogDir(id), { mode: 0o700 });
    return true;
  }

  /** Every stored campaign's state. */
  loadAll() {
    let names = [];
    try { names = fs.readdirSync(this.root); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (!ID_RE.test(name)) continue;
      try {
        const state = JSON.parse(fs.readFileSync(path.join(this.root, name, 'state.json'), 'utf8'));
        if (state && state.id === name) out.push(state);
      } catch (err) {
        if (err.code !== 'ENOENT') log.error('Cannot load campaign ' + name + ':', err.message);
      }
    }
    return out;
  }

  load(id) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dirFor(id), 'state.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  save(state) {
    const dir = this.dirFor(state.id);
    const file = path.join(dir, 'state.json');
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      log.error('Cannot save campaign ' + state.id + ':', err.message);
    }
  }
}

module.exports = { CampaignStore, DEFAULT_ROOT };
