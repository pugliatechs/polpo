/**
 * Campaigns: long-running work by one held session against milestones
 * and gates you define (Human-Directed Agentic Engineering).
 *
 * This is phase 1 of docs/campaigns.md: the campaign file and its pin,
 * binding to a session, gates run on demand, the ledger, pending
 * decisions on every surface, and tool approvals that wait for you. The
 * inner loop (the driver, budgets, verdicts) is phase 2.
 *
 * Statuses:
 *
 *   awaiting_definition  nothing runs until you approve the campaign file
 *                        (a new campaign, or a changed file)
 *   active               polpo holds the session as campaign:<id>
 *   paused               paused by you, by a restart, or the session ended
 *   paused_desk          the session was picked up elsewhere (VSCode, a
 *                        terminal, another holder)
 *   stopped              ended; only you can do this
 */

'use strict';

const EventEmitter = require('events');
const path = require('path');
const def = require('./definition');
const { Ledger } = require('./ledger');
const { CampaignStore } = require('./store');
const gateRunner = require('./gate-runner');
const decisions = require('./decisions');
const { redact, redactDeep } = require('../server/redact');
const { makeLogger } = require('../util/logger');

const log = makeLogger('campaign');

const MAX_GATE_RUNS_KEPT = 50;
const MAX_CLOSED_DECISIONS_KEPT = 50;
const MAX_PROMPT_CHARS = 50000;
const SESSION_ID_RE = /^[a-zA-Z0-9._-]{1,200}$/;

function fail(error, message, extra) {
  return Object.assign({ ok: false, error, message }, extra || {});
}

/** Where a message in the session came from, as a ledger channel. */
function channelOfSource(source) {
  if (source === 'mobile') return 'dashboard';
  if (typeof source === 'string' && source.indexOf('gateway:') === 0) return source;
  if (source === 'polpo') return 'polpo';
  return null;
}

/** The message source a prompt from `channel` is logged with. */
function sourceOfChannel(channel) {
  if (channel === 'dashboard') return 'mobile';
  return channel || 'polpo';
}

/** The model the session reported when it started, if any. */
function modelOf(inst) {
  const conv = inst && Array.isArray(inst.conversation) ? inst.conversation : [];
  for (let i = conv.length - 1; i >= 0; i--) {
    const m = conv[i];
    if (m.role !== 'system' || typeof m.content !== 'string' || m.content.indexOf('"init"') === -1) continue;
    try {
      const c = JSON.parse(m.content);
      if (c && c.subtype === 'init' && typeof c.model === 'string') return c.model;
    } catch {}
  }
  return null;
}

// Fields of a decision's details that identify things polpo matches on;
// a long random-looking id would otherwise be taken for a secret.
const DETAIL_IDS = new Set(['hash', 'previousHash', 'instanceId', 'toolUseId']);

/** Decision details as the gateway shows them: filtered like the text. */
function filterDetails(details) {
  const out = {};
  for (const k of Object.keys(details)) {
    out[k] = DETAIL_IDS.has(k) ? details[k] : redactDeep(details[k]);
  }
  return out;
}

class CampaignManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.instanceManager
   * @param {object} opts.sessionController
   * @param {object} opts.approvals - PendingApprovals
   * @param {object} [opts.store] - CampaignStore
   * @param {Set<string>} [opts.agentMay] - decision kinds a PA may decide
   * @param {function} [opts.runGate] - injectable for tests
   * @param {function} [opts.gitState] - injectable for tests
   */
  constructor(opts) {
    super();
    this.instanceManager = opts.instanceManager;
    this.sessionController = opts.sessionController;
    this.approvals = opts.approvals;
    this.store = opts.store || new CampaignStore();
    this.agentMay = opts.agentMay || new Set();
    this._runGate = opts.runGate || gateRunner.runGate;
    this._gitState = opts.gitState || gateRunner.gitState;
    this.campaigns = new Map();
    this._ledgers = new Map();
    this._gates = new Map();
    this._binding = new Set();
    this._lastSeq = 0;

    this._listeners = {
      'instance:control': (e) => this._onControl(e),
      'instance:disconnected': (inst) => this._onDisconnected(inst),
      'instance:session_info': (e) => this._onSessionInfo(e),
      'instance:message': (e) => this._onMessage(e),
      'instance:status': (e) => this._onStatus(e),
    };
    for (const [ev, fn] of Object.entries(this._listeners)) this.instanceManager.on(ev, fn);
    this._onSettled = (e) => this._onApprovalSettled(e);
    if (this.approvals) this.approvals.on('settled', this._onSettled);
  }

  // ------------------------------------------------------------------
  // Loading and saving
  // ------------------------------------------------------------------

  /**
   * Load stored campaigns. A campaign that was running comes back paused:
   * its session's process is gone, and resuming it is your call.
   */
  load() {
    for (const c of this.store.loadAll()) {
      this.campaigns.set(c.id, c);
      for (const d of c.decisions || []) {
        this._lastSeq = Math.max(this._lastSeq, d.seq || 0, d.closedSeq || 0);
      }
      const ledger = this._ledger(c);
      if (!ledger.ok) log.warn('Campaign ' + c.id + ': the ledger chain breaks at ' + ledger.brokenAt);
      c.instanceId = null;
      if (c.gateRunning) {
        this._record(c, 'gate_run', 'polpo', { milestone: c.gateRunning.milestone, runId: c.gateRunning.runId, interrupted: true });
        c.gateRunning = null;
      }
      for (const d of c.decisions || []) {
        if (d.status === 'pending' && d.kind === 'approval') {
          this._supersede(c, d, 'restart');
          this._record(c, 'approval_expired', 'polpo', { decisionId: d.decisionId, tool: d.details.tool, reason: 'restart' });
        }
      }
      if (c.status === 'active' || c.status === 'paused_desk') {
        c.status = 'paused';
        c.statusReason = 'polpo restarted';
        this._record(c, 'pause', 'polpo', { reason: 'restart' });
      }
      this.store.save(c);
    }
    return this.campaigns.size;
  }

  _ledger(c) {
    let l = this._ledgers.get(c.id);
    if (!l) {
      l = new Ledger(this.store.ledgerPath(c.id));
      this._ledgers.set(c.id, l);
    }
    return l;
  }

  _record(c, kind, channel, fields) {
    try {
      const entry = this._ledger(c).append(kind, channel, fields);
      this.emit('ledger', { campaignId: c.id, entry });
      return entry;
    } catch (err) {
      log.error('Campaign ' + c.id + ': cannot write the ledger:', err.message);
      return null;
    }
  }

  _save(c) {
    c.updatedAt = new Date().toISOString();
    this.store.save(c);
    this.emit('campaign', this.describe(c));
  }

  _nextSeq() {
    this._lastSeq = Math.max(Date.now(), this._lastSeq + 1);
    return this._lastSeq;
  }

  // ------------------------------------------------------------------
  // Reading
  // ------------------------------------------------------------------

  get(id) {
    return this.campaigns.get(id) || null;
  }

  list() {
    return Array.from(this.campaigns.values())
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((c) => this.describe(c));
  }

  /** The campaign holding an instance's session, if one does and runs. */
  campaignForInstance(instanceId) {
    const inst = this.instanceManager.get(instanceId);
    if (!inst || typeof inst.heldBy !== 'string' || inst.heldBy.indexOf('campaign:') !== 0) return null;
    const c = this.campaigns.get(inst.heldBy.slice('campaign:'.length));
    return c && c.status !== 'stopped' && c.instanceId === instanceId ? c.id : null;
  }

  _byInstance(instanceId) {
    for (const c of this.campaigns.values()) {
      if (c.instanceId === instanceId && c.status !== 'stopped') return c;
    }
    return null;
  }

  _heldBy(c) {
    return 'campaign:' + c.id;
  }

  _pending(c, kind) {
    return (c.decisions || []).filter((d) => d.status === 'pending' && (!kind || d.kind === kind));
  }

  /** The definition shown for a campaign: the approved one, else the proposed one. */
  _shownDefinition(c) {
    if (c.definition) return c.definition;
    const d = this._pending(c, 'definition')[0];
    return d ? d.details.definition : null;
  }

  /**
   * A campaign as the dashboard and the gateway show it.
   * @param {object} c
   * @param {{full?: boolean}} [opts] - full adds the definition and gate runs
   */
  describe(c, opts) {
    const shown = this._shownDefinition(c);
    const lastRunOf = (mid) => {
      const runs = (c.gateRuns || []).filter((r) => r.milestone === mid);
      if (!runs.length) return null;
      const r = runs[runs.length - 1];
      return { runId: r.runId, at: r.finishedAt, passed: r.passed, exit: r.exit, commit: r.commit, durationMs: r.durationMs };
    };
    const ledger = this._ledger(c);
    const out = {
      campaignId: c.id,
      status: c.status,
      statusReason: c.statusReason || null,
      cwd: c.cwd,
      file: c.file,
      agentType: c.agentType,
      sessionId: c.sessionId || null,
      instanceId: c.instanceId || null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      approvedAt: c.approvedAt || null,
      definitionHash: c.definitionHash || null,
      objective: shown ? shown.objective : null,
      activeMilestone: c.activeMilestone || null,
      milestones: shown ? shown.milestones.map((m) => ({
        id: m.id,
        goal: m.goal,
        gate: def.formatArgv(m.gate.run),
        timeoutS: def.gateTimeoutS(m),
        accept: m.accept,
        active: m.id === c.activeMilestone,
        lastRun: lastRunOf(m.id),
      })) : [],
      gateRunning: c.gateRunning || null,
      pendingDecisions: this._pending(c).map(decisions.publicDecision),
      ledger: { lastSeq: ledger.lastSeq, chainOk: ledger.ok },
    };
    if (opts && opts.full) {
      out.definition = c.definition ? redactDeep(c.definition) : null;
      out.proposedDefinition = c.definition ? null : shown;
      out.pinnedPaths = Object.keys(c.pinned || {});
      out.gateRuns = (c.gateRuns || []).slice(-20);
    }
    return out;
  }

  /**
   * Pending decisions across campaigns, for polling.
   *
   * @param {number} since - the cursor from the last call (0 for all pending)
   * @returns {{decisions: object[], closed: object[], cursor: number}}
   *   `closed` lists decisions answered or superseded since the cursor,
   *   so a PA can tell you one was settled elsewhere.
   */
  decisionsSince(since) {
    const s = since || 0;
    const open = [];
    const closed = [];
    let cursor = s;
    for (const c of this.campaigns.values()) {
      for (const d of c.decisions || []) {
        cursor = Math.max(cursor, d.seq || 0, d.closedSeq || 0);
        if (d.status === 'pending' && d.seq > s) open.push(decisions.publicDecision(d));
        else if (d.status !== 'pending' && s > 0 && d.closedSeq > s) closed.push(decisions.publicDecision(d));
      }
    }
    open.sort((a, b) => a.seq - b.seq);
    return { decisions: open, closed, cursor };
  }

  /** One decision, pending or not, or null. */
  getDecision(id, decisionId) {
    const c = this.campaigns.get(id);
    if (!c) return null;
    const d = (c.decisions || []).find((x) => x.decisionId === decisionId);
    return d ? decisions.publicDecision(d) : null;
  }

  ledgerSince(id, since, limit) {
    const c = this.campaigns.get(id);
    if (!c) return null;
    return this._ledger(c).since(since, limit);
  }

  // ------------------------------------------------------------------
  // Decisions
  // ------------------------------------------------------------------

  _raise(c, kind, fields) {
    const d = {
      decisionId: decisions.newDecisionId(),
      campaignId: c.id,
      kind,
      milestone: fields.milestone || c.activeMilestone || null,
      createdAt: new Date().toISOString(),
      seq: this._nextSeq(),
      status: 'pending',
      text: def.capDecisionText(redact(fields.text), fields.rest || 'GET /v1/campaigns/' + c.id + ' has the rest'),
      options: fields.options,
      needsText: fields.needsText || {},
      details: filterDetails(fields.details || {}),
    };
    c.decisions = c.decisions || [];
    c.decisions.push(d);
    this._pruneDecisions(c);
    this._save(c);
    this.emit('decision', decisions.publicDecision(d));
    return d;
  }

  _pruneDecisions(c) {
    const closed = c.decisions.filter((d) => d.status !== 'pending');
    if (closed.length <= MAX_CLOSED_DECISIONS_KEPT) return;
    const drop = new Set(closed.slice(0, closed.length - MAX_CLOSED_DECISIONS_KEPT));
    c.decisions = c.decisions.filter((d) => !drop.has(d));
  }

  _close(c, d, how) {
    d.status = 'closed';
    d.answer = how.answer;
    d.answerText = how.text || null;
    d.channel = how.channel;
    d.decidedBy = how.decidedBy || 'user';
    d.closedAt = new Date().toISOString();
    d.closedSeq = this._nextSeq();
    this._save(c);
    this.emit('decision_closed', decisions.publicDecision(d));
  }

  _supersede(c, d, reason) {
    d.status = 'superseded';
    d.supersededBy = reason;
    d.closedAt = new Date().toISOString();
    d.closedSeq = this._nextSeq();
    this.emit('decision_closed', decisions.publicDecision(d));
  }

  /**
   * Answer a pending decision. The first valid answer wins.
   *
   * @param {string} id
   * @param {string} decisionId
   * @param {object} a - { answer, text, hash, channel, decidedBy, userMessage }
   */
  async answer(id, decisionId, a) {
    const c = this.campaigns.get(id);
    if (!c) return fail('campaign_not_found', 'No such campaign.');
    const d = (c.decisions || []).find((x) => x.decisionId === decisionId);
    if (!d) return fail('decision_not_found', 'No such decision.');
    const check = decisions.checkAnswer(d, a, this.agentMay);
    if (!check.ok) return check;
    const how = {
      answer: a.answer,
      text: typeof a.text === 'string' ? a.text.trim() : '',
      channel: a.channel || 'dashboard',
      decidedBy: a.decidedBy || 'user',
      userMessage: a.userMessage || null,
    };
    if (d.kind === 'definition') return this._answerDefinition(c, d, how);
    if (d.kind === 'approval') return this._answerApproval(c, d, how);
    return fail('not_supported', 'This kind of decision is not answered here yet.');
  }

  async _answerDefinition(c, d, how) {
    const file = def.resolveCampaignFile(c.cwd, c.file);
    const read = file.ok ? def.readDefinition(file.path) : file;
    if (!read.ok || read.hash !== d.details.hash) {
      // The file moved on since you were asked: ask about what is there now.
      this._supersede(c, d, 'definition_changed');
      this._save(c);
      this._checkDefinition(c);
      return fail('decision_superseded', 'The campaign file changed since this decision was raised.', { reason: 'definition_changed' });
    }
    if (how.answer === 'reject') {
      this._close(c, d, how);
      c.lastRejectedHash = d.details.hash;
      c.statusReason = 'campaign file rejected: ' + how.text;
      this._record(c, 'definition_rejected', how.channel, {
        decisionId: d.decisionId, hash: d.details.hash, reason: how.text,
        decidedBy: how.decidedBy, userMessage: how.userMessage,
      });
      this._save(c);
      return { ok: true, decision: decisions.publicDecision(d), campaign: this.describe(c) };
    }

    this._close(c, d, how);
    const previousHash = c.definitionHash || null;
    c.definition = read.definition;
    c.definitionHash = read.hash;
    c.pinned = def.hashPinnedPaths(c.cwd, read.definition);
    c.approvedAt = new Date().toISOString();
    c.lastRejectedHash = null;
    if (!read.definition.milestones.some((m) => m.id === c.activeMilestone)) {
      c.activeMilestone = read.definition.milestones[0].id;
    }
    this._record(c, 'campaign_approved', how.channel, {
      decisionId: d.decisionId, hash: read.hash, previousHash,
      pinned: c.pinned, decidedBy: how.decidedBy, userMessage: how.userMessage,
    });
    const back = c.statusBeforeDefinition || null;
    c.statusBeforeDefinition = null;
    if (back === 'paused' || back === 'paused_desk') {
      c.status = back;
      c.statusReason = 'campaign file approved; still ' + (back === 'paused' ? 'paused' : 'handed back');
      this._save(c);
    } else {
      await this._activate(c, previousHash ? 'changed' : 'start');
    }
    return { ok: true, decision: decisions.publicDecision(d), campaign: this.describe(c) };
  }

  _answerApproval(c, d, how) {
    const inst = d.details.instanceId;
    const current = this.approvals.current(inst);
    if (!current || (d.details.toolUseId && current.toolUseId !== d.details.toolUseId)) {
      this._supersede(c, d, 'approval_gone');
      this._save(c);
      return fail('decision_superseded', 'The agent is no longer waiting on this approval.', { reason: 'approval_gone' });
    }
    const meta = Object.assign({ decisionId: d.decisionId }, how);
    let ok;
    if (how.answer === 'allow' || how.answer === 'approve') {
      ok = this.approvals.approve(inst, meta);
    } else if (how.answer === 'answer') {
      const answers = {};
      for (const q of d.details.questions || []) {
        if (q && typeof q.question === 'string') answers[q.question] = how.text;
      }
      ok = this.approvals.answer(inst, answers, meta);
    } else {
      ok = this.approvals.reject(inst, how.text ? 'Denied: ' + how.text : 'Denied', meta);
    }
    if (!ok) return fail('decision_superseded', 'The agent is no longer waiting on this approval.');
    return { ok: true, decision: decisions.publicDecision(d), campaign: this.describe(c) };
  }

  /**
   * An approval the agent of a campaign session waits on: it becomes an
   * `approval` decision and waits for an answer, however long it takes.
   */
  approvalRequested(campaignId, instanceId, info) {
    const c = this.campaigns.get(campaignId);
    if (!c) return null;
    const type = info.approvalType || 'tool';
    let options = ['allow', 'deny'];
    let needsText = {};
    const lines = ['The agent in campaign ' + c.id + ' is waiting for your approval.'];
    if (type === 'plan') {
      options = ['approve', 'reject'];
      lines.push('Plan for review:', String(info.command || info.description || ''));
    } else if (type === 'question') {
      options = ['answer', 'deny'];
      needsText = { answer: 'your answer' };
      lines.push('It asks:');
      for (const q of info.questions || []) {
        const opts = Array.isArray(q.options) ? q.options.map((o) => o && o.label).filter(Boolean) : [];
        lines.push('- ' + q.question + (opts.length ? ' (' + opts.join(' / ') + ')' : ''));
      }
    } else {
      lines.push('Tool: ' + (info.tool || 'unknown'));
      if (info.description) lines.push(info.description);
      if (info.toolInput !== undefined && info.tool !== 'Bash') {
        const raw = typeof info.toolInput === 'string' ? info.toolInput : JSON.stringify(info.toolInput);
        lines.push('Input: ' + (raw.length > 1500 ? raw.slice(0, 1500) + ' ...' : raw));
      } else if (info.command) {
        lines.push('Command: ' + info.command);
      }
    }
    return this._raise(c, 'approval', {
      text: lines.join('\n'),
      options,
      needsText,
      details: {
        instanceId,
        toolUseId: info.toolUseId || null,
        tool: info.tool || null,
        approvalType: type,
        questions: type === 'question' ? (info.questions || []) : undefined,
      },
    });
  }

  _onApprovalSettled(e) {
    const c = this._byInstance(e.instanceId);
    if (!c) return;
    const d = this._pending(c, 'approval').find((x) => x.details.instanceId === e.instanceId
      && (!e.toolUseId || !x.details.toolUseId || x.details.toolUseId === e.toolUseId));
    if (!d) return;
    const meta = e.meta || {};
    if (meta.via) {
      this._supersede(c, d, meta.via);
      this._save(c);
      this._record(c, 'approval_expired', 'polpo', { decisionId: d.decisionId, tool: d.details.tool, reason: meta.via });
      return;
    }
    const allowed = e.decision && e.decision.behavior === 'allow';
    const how = {
      answer: meta.answer || (allowed ? d.options[0] : d.options[d.options.length - 1]),
      text: meta.text || null,
      channel: meta.channel || 'dashboard',
      decidedBy: meta.decidedBy || 'user',
    };
    this._close(c, d, how);
    this._record(c, allowed ? 'approval' : 'denial', how.channel, {
      decisionId: d.decisionId,
      tool: d.details.tool,
      approvalType: d.details.approvalType,
      text: d.text,
      reason: how.text,
      decidedBy: how.decidedBy,
      userMessage: meta.userMessage || null,
      auto: meta.auto ? true : undefined,
    });
  }

  // ------------------------------------------------------------------
  // The campaign file
  // ------------------------------------------------------------------

  _raiseDefinition(c, read, changes) {
    for (const old of this._pending(c, 'definition')) this._supersede(c, old, 'newer_definition');
    const header = c.definition
      ? 'The campaign file of ' + c.id + ' changed since you approved it. It is paused until you approve the new version.\n'
        + (changes.length ? 'Changes:\n- ' + changes.join('\n- ') + '\n' : '')
        + '\nThe new version:\n'
      : 'Approve campaign ' + c.id + ' before it runs anything.\n\n';
    return this._raise(c, 'definition', {
      text: header + def.renderDefinition(read.definition) + '\n\nFile: ' + c.file + ', sha256 ' + read.hash.slice(0, 12),
      options: ['approve', 'reject'],
      needsText: { reject: 'what to change' },
      details: { hash: read.hash, previousHash: c.definitionHash || null, file: c.file, changes, definition: read.definition },
    });
  }

  /**
   * Compare the campaign file with what was approved; pause and ask when
   * it differs.
   * @returns {boolean} true when the campaign must wait for a definition
   */
  _checkDefinition(c) {
    if (c.status === 'stopped') return false;
    const file = def.resolveCampaignFile(c.cwd, c.file);
    const read = file.ok ? def.readDefinition(file.path) : file;
    if (!read.ok) {
      const reason = 'The campaign file cannot be used: ' + read.message;
      if (c.statusReason !== reason) {
        this._enterAwaitingDefinition(c, reason);
        this._record(c, 'campaign_changed', 'polpo', { invalid: true, error: read.error, errors: read.errors || null });
        this._save(c);
      }
      return true;
    }
    if (read.hash === c.definitionHash) {
      if (c.status === 'awaiting_definition') {
        // Back to the approved version (an invalid edit was undone).
        for (const old of this._pending(c, 'definition')) this._supersede(c, old, 'definition_restored');
        c.status = c.statusBeforeDefinition || 'paused';
        c.statusBeforeDefinition = null;
        if (c.status === 'active') c.status = 'paused';
        c.statusReason = 'the campaign file is back to the approved version';
        this._save(c);
      }
      return false;
    }
    if (this._pending(c, 'definition').some((d) => d.details.hash === read.hash)) return true;
    if (c.lastRejectedHash === read.hash) return true;
    const changes = c.definition ? def.describeChange(c.definition, read.definition) : [];
    if (c.definition) {
      this._record(c, 'campaign_changed', 'polpo', { hash: read.hash, previousHash: c.definitionHash, changes });
    }
    this._enterAwaitingDefinition(c, c.definition ? 'the campaign file changed' : 'waiting for the campaign file to be approved');
    this._raiseDefinition(c, read, changes);
    return true;
  }

  _enterAwaitingDefinition(c, reason) {
    if (c.status !== 'awaiting_definition') {
      c.statusBeforeDefinition = c.status;
      c.status = 'awaiting_definition';
    }
    c.statusReason = reason;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Start a campaign from a repository's campaign file. Nothing runs
   * until its `definition` decision is answered.
   *
   * @param {object} o - { cwd, file, sessionId, channel }
   */
  create(o) {
    const opts = o || {};
    const file = def.resolveCampaignFile(opts.cwd, opts.file);
    if (!file.ok) return file;
    const read = def.readDefinition(file.path);
    if (!read.ok) return read;
    let sessionId = null;
    if (opts.sessionId !== undefined && opts.sessionId !== null) {
      if (typeof opts.sessionId !== 'string' || !SESSION_ID_RE.test(opts.sessionId)) {
        return fail('invalid_session_id', 'sessionId is not a session id.');
      }
      if (!this.sessionController.transcriptPathFor({ sessionId: opts.sessionId, agentType: 'claude' })) {
        return fail('session_not_found', 'No Claude session with that id on this machine.');
      }
      sessionId = opts.sessionId;
    }
    const id = read.definition.name;
    if (!this.store.create(id)) {
      return fail('campaign_exists', 'A campaign named ' + id + ' already exists; give this one another name.');
    }
    const now = new Date().toISOString();
    const c = {
      id,
      cwd: file.root,
      file: path.relative(file.root, file.path),
      agentType: 'claude',
      status: 'awaiting_definition',
      statusReason: 'waiting for the campaign file to be approved',
      createdAt: now,
      updatedAt: now,
      sessionId,
      instanceId: null,
      definition: null,
      definitionHash: null,
      pinned: {},
      approvedAt: null,
      activeMilestone: read.definition.milestones[0].id,
      gateRuns: [],
      gateRunning: null,
      decisions: [],
    };
    this.campaigns.set(id, c);
    this._record(c, 'campaign_created', opts.channel || 'dashboard', {
      cwd: c.cwd, file: c.file, sessionId, hash: read.hash,
    });
    const d = this._raiseDefinition(c, read, []);
    return { ok: true, campaign: this.describe(c), decision: decisions.publicDecision(d) };
  }

  /** Take or start the campaign's session and hold it as campaign:<id>. */
  async _bind(c) {
    const heldBy = this._heldBy(c);
    const ctl = this.sessionController;
    if (c.instanceId) {
      const inst = this.instanceManager.get(c.instanceId);
      if (inst && inst.heldBy === heldBy && ctl.agentFor(inst)) return { ok: true, instanceId: inst.id };
    }
    this._binding.add(c.id);
    try {
      let out;
      if (c.sessionId) {
        const live = (this.instanceManager.getAll() || []).find((i) => i && i.sessionId === c.sessionId);
        out = live
          ? await ctl.takeover(live.id, { heldBy, inheritPermissionMode: true })
          : await ctl.resume(c.sessionId, {
            agentType: 'claude', cwd: c.cwd, heldBy, inheritPermissionMode: true, name: 'Campaign ' + c.id,
          });
      } else {
        out = await ctl.start({ agentType: 'claude', cwd: c.cwd, name: 'Campaign ' + c.id, heldBy });
      }
      if (!out.ok) return out;
      c.instanceId = out.instanceId;
      const inst = this.instanceManager.get(out.instanceId);
      if (inst && inst.sessionId) c.sessionId = inst.sessionId;
      return { ok: true, instanceId: out.instanceId };
    } catch (err) {
      log.error('Campaign ' + c.id + ': cannot take the session:', err && err.message);
      return fail('bind_failed', 'polpo could not start or take the session.');
    } finally {
      this._binding.delete(c.id);
    }
  }

  /** Hold the session and tell the agent what the campaign is. */
  async _activate(c, why) {
    const bound = await this._bind(c);
    if (!bound.ok) {
      c.status = 'paused';
      c.statusReason = bound.message;
      this._record(c, 'pause', 'polpo', { reason: bound.error });
      this._save(c);
      return bound;
    }
    c.status = 'active';
    c.statusReason = null;
    c.briefing = why;
    this._save(c);
    this._sendBriefing(c);
    return { ok: true };
  }

  /** What the agent is told when the campaign starts, resumes or changes. */
  briefing(c, why) {
    const d = c.definition;
    const idx = d.milestones.findIndex((m) => m.id === c.activeMilestone);
    const m = d.milestones[idx];
    const lines = [];
    if (why === 'resume') lines.push('The polpo campaign "' + c.id + '" is resuming after a pause.');
    else if (why === 'changed') lines.push('The campaign file of "' + c.id + '" changed and was approved again.');
    else lines.push('You are working on the polpo campaign "' + c.id + '".');
    lines.push('Objective: ' + d.objective);
    lines.push('Active milestone ' + m.id + ' (' + (idx + 1) + ' of ' + d.milestones.length + '): ' + m.goal);
    lines.push('It is accepted when: ' + m.accept);
    lines.push('Its gate is `' + def.formatArgv(m.gate.run) + '`. polpo runs the gate itself, outside this session; '
      + 'the milestone is not passed until that run passes and the user accepts it, whatever your own checks say.');
    if (d.constraints && d.constraints.length) {
      lines.push('Constraints:');
      for (const x of d.constraints) lines.push('- ' + x);
    }
    if (d.read_first && d.read_first.length) {
      lines.push((why === 'start' ? 'Read these first: ' : 'Read these again: ') + d.read_first.join(', ') + '.');
    }
    lines.push('Do not edit ' + c.file + ' to change the milestones or gates: changing it pauses the campaign until the user approves it again.');
    lines.push(why === 'start' ? 'Then work on this milestone.' : 'Then continue with this milestone.');
    return lines.join('\n');
  }

  _sendBriefing(c) {
    if (!c.briefing || c.status !== 'active' || !c.definition) return;
    const inst = this.instanceManager.get(c.instanceId);
    if (!inst || inst.status === 'busy' || inst.status === 'waiting') return; // sent when it goes idle
    const why = c.briefing;
    c.briefing = null;
    const out = this.sessionController.sendPrompt(inst.id, this.briefing(c, why), { source: 'polpo', requireDelivery: true });
    if (!out.ok) {
      c.briefing = why;
      log.warn('Campaign ' + c.id + ': briefing not delivered: ' + out.error);
    }
    this._save(c);
  }

  pause(id, meta) {
    const c = this.campaigns.get(id);
    if (!c) return fail('campaign_not_found', 'No such campaign.');
    if (c.status === 'stopped') return fail('campaign_stopped', 'The campaign has ended.');
    if (c.status !== 'active' && c.status !== 'paused_desk') return { ok: true, campaign: this.describe(c) };
    const m = meta || {};
    c.status = 'paused';
    c.statusReason = 'paused from ' + (m.channel || 'dashboard');
    this._record(c, 'pause', m.channel || 'dashboard', {
      reason: m.text || null, decidedBy: m.decidedBy || 'user', userMessage: m.userMessage || null,
    });
    this._save(c);
    return { ok: true, campaign: this.describe(c) };
  }

  async resume(id, meta) {
    const c = this.campaigns.get(id);
    if (!c) return fail('campaign_not_found', 'No such campaign.');
    if (c.status === 'stopped') return fail('campaign_stopped', 'The campaign has ended.');
    if (c.status === 'active') return { ok: true, campaign: this.describe(c) };
    if (this._checkDefinition(c) || c.status === 'awaiting_definition') {
      return fail('awaiting_definition', 'The campaign file must be approved first.', {
        decisions: this._pending(c, 'definition').map(decisions.publicDecision),
      });
    }
    const m = meta || {};
    const inst = c.instanceId ? this.instanceManager.get(c.instanceId) : null;
    if (inst && (inst.status === 'busy' || inst.status === 'waiting') && inst.heldBy !== this._heldBy(c)) {
      return fail('session_busy', 'The session is still working. Resume once it is idle.');
    }
    this._record(c, 'resume', m.channel || 'dashboard', {
      from: c.status, decidedBy: m.decidedBy || 'user', userMessage: m.userMessage || null,
    });
    const out = await this._activate(c, 'resume');
    if (!out.ok) return out;
    return { ok: true, campaign: this.describe(c) };
  }

  /** End the campaign. Only the user may: callers check attestation. */
  async stop(id, meta) {
    const c = this.campaigns.get(id);
    if (!c) return fail('campaign_not_found', 'No such campaign.');
    if (c.status === 'stopped') return { ok: true, campaign: this.describe(c) };
    const m = meta || {};
    const gate = this._gates.get(c.id);
    if (gate) gate.cancel();
    const inst = c.instanceId ? this.instanceManager.get(c.instanceId) : null;
    if (inst && this.approvals) this.approvals.reject(inst.id, 'The campaign was stopped', { via: 'stopped' });
    for (const d of this._pending(c)) this._supersede(c, d, 'stopped');
    c.status = 'stopped';
    c.statusReason = 'stopped from ' + (m.channel || 'dashboard');
    // The session stays open, driven from the dashboard as any other.
    if (inst && inst.heldBy === this._heldBy(c)) this.sessionController.handOver(inst.id, 'dashboard');
    this._record(c, 'stop', m.channel || 'dashboard', {
      reason: m.text || null, decidedBy: m.decidedBy || 'user', userMessage: m.userMessage || null,
    });
    this._save(c);
    return { ok: true, campaign: this.describe(c) };
  }

  /**
   * Send a prompt into the campaign's session: a correction or a new
   * priority. Refused while the agent is working, like any prompt.
   */
  prompt(id, text, meta) {
    const c = this.campaigns.get(id);
    if (!c) return fail('campaign_not_found', 'No such campaign.');
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_PROMPT_CHARS) {
      return fail('invalid_text', 'text must be 1 to ' + MAX_PROMPT_CHARS + ' characters.');
    }
    if (c.status !== 'active') return fail('not_active', 'The campaign is ' + c.status + '.', { status: c.status });
    const inst = this.instanceManager.get(c.instanceId);
    if (!inst || inst.heldBy !== this._heldBy(c)) {
      return fail('not_active', 'The campaign does not hold its session right now.');
    }
    if (this._checkDefinition(c)) {
      return fail('campaign_changed', 'The campaign file changed; it must be approved again first.');
    }
    if (inst.status === 'busy' || inst.status === 'waiting') {
      return fail('session_busy', 'The agent is still working. Send this once it is idle.', { status: inst.status });
    }
    let full = text;
    if (c.briefing) {
      full = this.briefing(c, c.briefing) + '\n\n' + text;
      c.briefing = null;
      this._save(c);
    }
    const m = meta || {};
    return this.sessionController.sendPrompt(inst.id, full, { source: sourceOfChannel(m.channel), requireDelivery: true });
  }

  // ------------------------------------------------------------------
  // Gates
  // ------------------------------------------------------------------

  /**
   * Run a milestone's gate now (the active one unless named). Returns as
   * soon as it starts; the result arrives as a `gate` event, in the
   * ledger and on the campaign.
   */
  runGate(id, opts, meta) {
    const c = this.campaigns.get(id);
    if (!c) return fail('campaign_not_found', 'No such campaign.');
    if (c.status === 'stopped') return fail('campaign_stopped', 'The campaign has ended.');
    if (!c.definition) return fail('awaiting_definition', 'The campaign file must be approved first.');
    if (this._checkDefinition(c)) return fail('campaign_changed', 'The campaign file changed; it must be approved again first.');
    if (this._gates.has(c.id) || c.gateRunning) return fail('gate_running', 'A gate is already running for this campaign.');
    const mid = (opts && opts.milestone) || c.activeMilestone;
    const m = c.definition.milestones.find((x) => x.id === mid);
    if (!m) return fail('unknown_milestone', 'No milestone ' + mid + ' in this campaign.');
    const inst = c.instanceId ? this.instanceManager.get(c.instanceId) : null;
    if (inst && (inst.status === 'busy' || inst.status === 'waiting')) {
      return fail('session_busy', 'The agent is changing the tree right now. Run the gate once it is idle.');
    }
    const runId = 'g' + Date.now().toString(36);
    const channel = (meta && meta.channel) || 'dashboard';
    c.gateRunning = { runId, milestone: m.id, startedAt: new Date().toISOString(), channel };
    this._gates.set(c.id, { cancel() {} });
    this._save(c);
    this._executeGate(c, m, runId, channel, inst).catch((err) => {
      log.error('Campaign ' + c.id + ': gate failed to run:', err && err.message);
    });
    return { ok: true, run: c.gateRunning };
  }

  async _executeGate(c, m, runId, channel, inst) {
    const startedAt = c.gateRunning.startedAt;
    let result;
    let git = { commit: null, dirty: false, treeHash: null };
    try {
      git = await this._gitState(c.cwd);
      const handle = this._runGate({
        cwd: c.cwd,
        argv: m.gate.run,
        timeoutMs: def.gateTimeoutS(m) * 1000,
        logPath: path.join(this.store.gateLogDir(c.id), runId + '-' + m.id + '.log'),
      });
      this._gates.set(c.id, handle);
      result = await handle.done;
    } catch (err) {
      result = { exit: null, signal: null, timedOut: false, durationMs: 0, logSha256: null, tail: '', error: err.message };
    } finally {
      this._gates.delete(c.id);
    }
    const run = {
      runId,
      milestone: m.id,
      gate: def.formatArgv(m.gate.run),
      startedAt,
      finishedAt: new Date().toISOString(),
      commit: git.commit,
      dirty: git.dirty,
      treeHash: git.treeHash,
      exit: result.exit,
      signal: result.signal || null,
      timedOut: !!result.timedOut,
      error: result.error || null,
      durationMs: result.durationMs,
      passed: result.exit === 0 && !result.timedOut,
      logSha256: result.logSha256,
      logFile: runId + '-' + m.id + '.log',
      tail: redact(result.tail || ''),
      pinnedChanged: def.changedPinnedPaths(c.cwd, c.pinned),
      agent: { type: c.agentType, model: modelOf(inst && this.instanceManager.get(inst.id)) },
      definitionHash: c.definitionHash,
    };
    c.gateRuns = (c.gateRuns || []).concat([run]).slice(-MAX_GATE_RUNS_KEPT);
    c.gateRunning = null;
    const ledgerTail = run.tail.split('\n').slice(-40).join('\n');
    this._record(c, 'gate_run', channel, Object.assign({}, run, { tail: ledgerTail }));
    this._save(c);
    this.emit('gate', { campaignId: c.id, run });
    return run;
  }

  // ------------------------------------------------------------------
  // Following the session
  // ------------------------------------------------------------------

  _onControl(e) {
    const c = this._byInstance(e.id);
    if (!c || this._binding.has(c.id)) return;
    if (e.heldBy === this._heldBy(c)) return;
    if (c.status !== 'active' && c.status !== 'paused') return;
    const by = e.heldBy || null;
    const channel = by === 'dashboard' ? 'dashboard' : (by && by.indexOf('gateway:') === 0 ? by : 'desk');
    if (this.approvals) this.approvals.reject(e.id, 'The session was handed back', { via: 'handback' });
    c.status = 'paused_desk';
    c.statusReason = by ? 'taken over by ' + by : 'picked up again outside polpo';
    this._record(c, 'handback', channel, { heldBy: by });
    this._save(c);
  }

  _onDisconnected(inst) {
    const c = this._byInstance(inst && inst.id);
    if (!c || this._binding.has(c.id)) return;
    c.instanceId = null;
    if (c.status === 'active') {
      c.status = 'paused';
      c.statusReason = 'the session ended';
      this._record(c, 'pause', 'polpo', { reason: 'session_ended' });
    }
    this._save(c);
  }

  _onSessionInfo(e) {
    const c = this._byInstance(e.id);
    if (!c || !e.sessionId || c.sessionId === e.sessionId) return;
    c.sessionId = e.sessionId;
    this._save(c);
  }

  /**
   * Every prompt into the campaign's session goes into the ledger, with
   * where it came from. One the transcript shows is polpo's own when
   * polpo holds the session; otherwise it was typed at the desk, and the
   * session is handed back if polpo still held it.
   */
  _onMessage(e) {
    const c = this._byInstance(e.id);
    if (!c || !e.message || e.message.role !== 'user') return;
    const msg = e.message;
    if (msg.contentType && msg.contentType !== 'text') return;
    let channel = channelOfSource(msg.source);
    if (msg.source === 'jsonl') {
      const inst = this.instanceManager.get(e.id);
      if (inst && inst.heldBy === this._heldBy(c)) {
        const foreign = this.sessionController.checkHandback(inst);
        if (!foreign) return; // polpo's own prompt, already recorded
        this.sessionController.release(inst.id, foreign.writer);
      }
      channel = 'desk';
    }
    if (!channel) return;
    this._record(c, 'prompt', channel, { text: typeof msg.content === 'string' ? msg.content : '' });
  }

  _onStatus(e) {
    if (e.status !== 'idle') return;
    const c = this._byInstance(e.id);
    if (!c) return;
    if (c.definition && this._checkDefinition(c)) return;
    this._sendBriefing(c);
  }

  destroy() {
    for (const [ev, fn] of Object.entries(this._listeners)) this.instanceManager.removeListener(ev, fn);
    if (this.approvals) this.approvals.removeListener('settled', this._onSettled);
    for (const g of this._gates.values()) { try { g.cancel(); } catch {} }
    this._gates.clear();
  }
}

/** HTTP status for a campaign refusal, shared by the dashboard and the gateway. */
function campaignErrorStatus(code) {
  switch (code) {
    case 'campaign_not_found':
    case 'decision_not_found':
    case 'campaign_file_not_found':
    case 'session_not_found':
      return 404;
    case 'agent_may_not_decide':
      return 403;
    case 'campaign_exists':
    case 'decision_closed':
    case 'decision_superseded':
    case 'hash_mismatch':
    case 'campaign_stopped':
    case 'awaiting_definition':
    case 'campaign_changed':
    case 'not_active':
    case 'session_busy':
    case 'session_resumed_elsewhere':
    case 'gate_running':
      return 409;
    case 'bind_failed':
    case 'agent_not_connected':
      return 502;
    case 'not_supported':
      return 501;
    default:
      return 400;
  }
}

module.exports = { CampaignManager, channelOfSource, campaignErrorStatus };
