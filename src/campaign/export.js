/**
 * `polpo campaign export <id>`: the two things a hand-curated steering
 * record lacks, generated from the ledger.
 *
 *   manifest.json  per milestone, every gate run with commit, result and
 *                  log hash, and every verdict with its channel:
 *                  machine-readable pass/fail
 *   STEERING.md    the chronology of interventions
 *
 * Both are read from ~/.config/polpo/campaigns/<id>/ and need no running
 * server.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readLedger } = require('./ledger');
const { CampaignStore } = require('./store');

function oneLine(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 3) + '...' : t;
}

/** One ledger entry as a line of the chronology. */
function describeEntry(e) {
  const by = e.decidedBy === 'agent' ? ' (decided by the assistant)' : '';
  const words = e.userMessage ? ' Your words: "' + oneLine(e.userMessage, 200) + '"' : '';
  switch (e.kind) {
    case 'campaign_created': return 'Campaign proposed from ' + e.file + '.';
    case 'campaign_approved': return 'Campaign file approved (' + String(e.hash).slice(0, 12) + ')' + by + '.' + words;
    case 'definition_rejected': return 'Campaign file rejected: ' + oneLine(e.reason, 300) + by + '.' + words;
    case 'campaign_changed': return e.invalid
      ? 'The campaign file became unusable (' + e.error + '); paused.'
      : 'The campaign file changed; paused for approval.' + (e.changes && e.changes.length ? ' ' + oneLine(e.changes.join(' '), 400) : '');
    case 'prompt': return 'Prompt: ' + oneLine(e.text, 400);
    case 'approval': return 'Approved ' + (e.tool || 'a tool call') + by + '.' + words;
    case 'denial': return 'Denied ' + (e.tool || 'a tool call') + (e.reason ? ': ' + oneLine(e.reason, 300) : '') + by + '.' + words;
    case 'approval_expired': return 'Approval for ' + (e.tool || 'a tool call') + ' lapsed (' + e.reason + ').';
    case 'gate_run':
      if (e.interrupted) return 'Gate of ' + e.milestone + ' interrupted by a restart.';
      return 'Gate of ' + e.milestone + (e.passed ? ' PASSED' : ' FAILED')
        + ' (exit ' + e.exit + (e.timedOut ? ', timed out' : '') + ', ' + Math.round((e.durationMs || 0) / 1000) + 's'
        + (e.commit ? ', commit ' + String(e.commit).slice(0, 10) + (e.dirty ? ' + uncommitted changes' : '') : '') + ').'
        + (e.pinnedChanged && e.pinnedChanged.length ? ' Gate files changed: ' + e.pinnedChanged.join(', ') + '.' : '');
    case 'verdict': return 'Verdict on ' + e.milestone + ': ' + e.verdict + (e.reason ? ': ' + oneLine(e.reason, 300) : '') + by + '.' + words;
    case 'pause': return 'Paused' + (e.reason ? ' (' + oneLine(e.reason, 200) + ')' : '') + '.';
    case 'resume': return 'Resumed.' + words;
    case 'handback': return 'Session handed back' + (e.heldBy ? ' to ' + e.heldBy : ' (picked up at the desk)') + '.';
    case 'stop': return 'Campaign stopped' + (e.reason ? ': ' + oneLine(e.reason, 300) : '') + '.' + words;
    default: return e.kind + '.';
  }
}

/**
 * Build the manifest from a campaign's state and ledger.
 */
function buildManifest(state, ledger) {
  const shown = state.definition || null;
  const milestones = (shown ? shown.milestones : []).map((m) => ({ id: m.id, goal: m.goal, accept: m.accept, gateRuns: [], verdicts: [] }));
  const byId = new Map(milestones.map((m) => [m.id, m]));
  const definitions = [];
  for (const e of ledger.entries) {
    if (e.kind === 'campaign_approved') definitions.push({ at: e.at, hash: e.hash, channel: e.channel, decidedBy: e.decidedBy || 'user' });
    const m = byId.get(e.milestone);
    if (!m) continue;
    if (e.kind === 'gate_run' && !e.interrupted) {
      m.gateRuns.push({
        seq: e.seq, at: e.at, runId: e.runId, gate: e.gate, commit: e.commit, dirty: !!e.dirty, treeHash: e.treeHash || null,
        exit: e.exit, timedOut: !!e.timedOut, passed: !!e.passed, durationMs: e.durationMs, logSha256: e.logSha256,
        pinnedChanged: e.pinnedChanged || [], channel: e.channel, definitionHash: e.definitionHash || null,
      });
    } else if (e.kind === 'verdict') {
      m.verdicts.push({ seq: e.seq, at: e.at, verdict: e.verdict, reason: e.reason || null, channel: e.channel, decidedBy: e.decidedBy || 'user' });
    }
  }
  return {
    format: 'polpo-campaign-manifest/1',
    campaign: {
      id: state.id, objective: shown ? shown.objective : null, status: state.status,
      cwd: state.cwd, file: state.file, sessionId: state.sessionId || null,
      createdAt: state.createdAt, definitionHash: state.definitionHash || null,
    },
    definitions,
    milestones,
    ledger: { entries: ledger.entries.length, lastSeq: ledger.lastSeq, lastHash: ledger.lastHash, chainOk: ledger.ok, brokenAt: ledger.brokenAt },
    exportedAt: new Date().toISOString(),
  };
}

function buildSteering(state, ledger) {
  const lines = ['# Steering record: ' + state.id, ''];
  const shown = state.definition;
  if (shown) lines.push('Objective: ' + shown.objective, '');
  lines.push('Generated by polpo from the campaign ledger (' + ledger.entries.length + ' entries, chain '
    + (ledger.ok ? 'intact' : 'BROKEN at ' + ledger.brokenAt) + ').', '');
  let day = null;
  for (const e of ledger.entries) {
    const d = String(e.at || '').slice(0, 10);
    if (d !== day) {
      day = d;
      lines.push('## ' + d, '');
    }
    lines.push('- ' + String(e.at || '').slice(11, 16) + ' [' + e.channel + '] ' + describeEntry(e));
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Write manifest.json and STEERING.md for a campaign.
 * @returns {{manifest: string, steering: string, chainOk: boolean}}
 */
function exportCampaign(id, outDir, opts) {
  const store = (opts && opts.store) || new CampaignStore();
  const state = store.load(id);
  if (!state) throw new Error('No campaign ' + id + ' in ' + store.root);
  const ledger = readLedger(store.ledgerPath(id));
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = path.join(outDir, 'manifest.json');
  const steering = path.join(outDir, 'STEERING.md');
  fs.writeFileSync(manifest, JSON.stringify(buildManifest(state, ledger), null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(steering, buildSteering(state, ledger), { mode: 0o600 });
  return { manifest, steering, chainOk: ledger.ok, brokenAt: ledger.brokenAt };
}

module.exports = { exportCampaign, buildManifest, buildSteering, describeEntry };
