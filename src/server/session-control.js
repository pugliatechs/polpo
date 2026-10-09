/**
 * Session control: reading live coding sessions and deciding who may
 * drive them.
 *
 * One module, so the dashboard, the dashboard WebSocket and the gateway
 * apply the same rules. The read side lives here; see the takeover and
 * prompt helpers for the write side.
 *
 * The rule polpo enforces is one writer at a time. While a session's
 * agent is busy, polpo only reads it. Once it is idle, polpo may take it
 * over and continue the same session. A session polpo holds is handed
 * back as soon as someone else (VSCode, a terminal) writes to it again.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// A single message can be large (a tool result, a whole file the agent
// read). The conversation API caps each one so a poll stays small.
const MAX_MESSAGE_CHARS = 20000;
const DEFAULT_CONVERSATION_LIMIT = 50;
const MAX_CONVERSATION_LIMIT = 200;
const MAX_APPROVAL_INPUT_CHARS = 2000;

// Instance ids are UUIDs minted by the instance manager; anything else is
// rejected before it reaches a lookup.
const INSTANCE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

// Every Claude transcript entry records which program wrote it in an
// `entrypoint` field: 'claude-vscode' for the VSCode extension, 'cli' for
// a terminal, and 'sdk-cli' for claude driven over stream-json, which is
// how polpo runs it. Desk-to-phone handoffs show up in real transcripts
// as alternating claude-vscode and sdk-cli runs.
const POLPO_WRITERS = new Set(['sdk-cli']);

// How much of a transcript's end the handback check reads. Entries can be
// large (a tool result with a whole file), so this is bytes, not lines.
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

const GEMINI_TMP_DIR = path.join(os.homedir(), '.gemini', 'tmp');

// A turn that has not written anything for this long is treated as
// interrupted rather than in progress (closing VSCode mid-turn never
// writes an end_turn). The cost: one silent tool call running longer than
// this would look idle. POLPO_SESSION_STALE_MS overrides it.
const DEFAULT_STALE_MS = 10 * 60 * 1000;

// Assistant stop reasons that end a turn.
const TURN_ENDED = new Set(['end_turn', 'refusal', 'max_tokens', 'stop_sequence']);

function capText(text, max) {
  const s = typeof text === 'string' ? text : (text == null ? '' : String(text));
  return s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s, truncated: false };
}

/**
 * Where an instance came from.
 *
 *   discovered  polpo found its transcript and only watches it (VSCode,
 *               a terminal, another tool); it cannot be prompted until
 *               taken over
 *   polpo       started or taken over from the dashboard or the phone
 *   gateway     a /v1/tasks run
 *   mind        the Alien Mind itself
 *   mind-arm    an arm the mind dispatched
 */
function originOf(inst) {
  if (!inst) return null;
  if (inst.agentType === 'mind') return 'mind';
  const src = typeof inst.source === 'string' ? inst.source : '';
  if (src.indexOf('mind:') === 0) return 'mind-arm';
  if (src.indexOf('gateway:') === 0) return 'gateway';
  if (inst.canReceivePrompts === false) return 'discovered';
  return 'polpo';
}

/**
 * The approval an agent is waiting on, without dumping whatever large
 * input the tool was called with (a Write tool's input is a whole file).
 */
function describeApproval(approval) {
  if (!approval || typeof approval !== 'object') return null;
  let input = null;
  if (approval.input !== undefined) {
    const raw = typeof approval.input === 'string' ? approval.input : JSON.stringify(approval.input);
    input = capText(raw, MAX_APPROVAL_INPUT_CHARS).text;
  }
  return {
    tool: typeof approval.tool === 'string' ? approval.tool : null,
    description: typeof approval.description === 'string' ? capText(approval.description, 1000).text : null,
    input: input,
  };
}

/**
 * A live instance as an external caller sees it.
 * @param {object} inst - raw instance from the instance manager
 */
function describeInstance(inst) {
  if (!inst) return null;
  const conversation = Array.isArray(inst.conversation) ? inst.conversation : [];
  const last = conversation.length ? conversation[conversation.length - 1] : null;
  return {
    instanceId: inst.id,
    sessionId: inst.sessionId || null,
    agentType: inst.agentType || null,
    origin: originOf(inst),
    source: inst.source || null,
    project: inst.project || null,
    cwd: inst.cwd || null,
    status: inst.status || null,
    canReceivePrompts: inst.canReceivePrompts !== false,
    // Who took it over ('dashboard', 'gateway:<client>'), or null when
    // nobody holds it through polpo.
    heldBy: inst.heldBy || null,
    pendingApproval: describeApproval(inst.pendingApproval),
    firstPrompt: inst.firstPrompt ? capText(inst.firstPrompt, 200).text : null,
    lastActivity: inst.lastActivity || null,
    lastSeq: last && typeof last.seq === 'number' ? last.seq : 0,
  };
}

function serializeMessage(m) {
  const content = capText(typeof m.content === 'string' ? m.content : JSON.stringify(m.content), MAX_MESSAGE_CHARS);
  const out = {
    seq: typeof m.seq === 'number' ? m.seq : null,
    role: m.role || null,
    contentType: m.contentType || 'text',
    content: content.text,
    timestamp: m.timestamp || null,
  };
  if (content.truncated) out.truncated = true;
  if (m.source) out.source = m.source;
  if (m.toolUseId) out.toolUseId = m.toolUseId;
  if (m.isError) out.isError = true;
  if (Array.isArray(m.attachments) && m.attachments.length) {
    out.attachments = m.attachments.map((a) => ({ filename: a && a.filename ? String(a.filename) : null }));
  }
  return out;
}

/**
 * Messages newer than `since`, for polling. polpo keeps the last 200
 * messages per instance; `gap` says the caller fell further behind than
 * that and some messages are no longer available here.
 *
 * @param {object} inst - raw instance
 * @param {number} since - last seq the caller has seen (0 for everything kept)
 * @param {number} [limit]
 */
function conversationSince(inst, since, limit) {
  const max = Math.min(Math.max(1, limit || DEFAULT_CONVERSATION_LIMIT), MAX_CONVERSATION_LIMIT);
  const all = Array.isArray(inst.conversation) ? inst.conversation : [];
  const newer = all.filter((m) => typeof m.seq === 'number' && m.seq > since);
  const page = newer.slice(0, max);
  const firstKept = all.length && typeof all[0].seq === 'number' ? all[0].seq : null;
  return {
    instanceId: inst.id,
    status: inst.status || null,
    messages: page.map(serializeMessage),
    lastSeq: page.length ? page[page.length - 1].seq : since,
    hasMore: newer.length > page.length,
    gap: since > 0 && firstKept !== null && firstKept > since + 1,
  };
}

// ---------------------------------------------------------------------
// Write side: who may drive a session
// ---------------------------------------------------------------------

/**
 * Parsed entries from the end of a JSONL transcript, oldest first. Reads
 * at most `maxBytes` from the end and drops the first, possibly partial,
 * line when it did not start at the beginning of the file.
 *
 * @returns {Array<object>} [] when the file is missing or unreadable
 */
function readTranscriptTail(filePath, maxBytes) {
  const limit = maxBytes || TRANSCRIPT_TAIL_BYTES;
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - limit);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* partial or malformed */ }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

/** A turn in the main conversation, as opposed to metadata or a subagent. */
function isConversational(entry) {
  return !!entry && (entry.type === 'user' || entry.type === 'assistant') && !entry.isSidechain;
}

/** uuid of the newest conversational entry, or null. */
function lastConversationalUuid(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isConversational(entries[i]) && entries[i].uuid) return entries[i].uuid;
  }
  return null;
}

/**
 * Whether anyone other than polpo has written a conversational entry
 * after `baselineUuid` (or at all, when there is no baseline).
 *
 * The baseline is the transcript's newest entry when polpo took the
 * session over. Entries after it written by polpo's own process are its
 * turns; any other writer means the session was picked up again
 * elsewhere, typically VSCode after a window reload.
 *
 * @returns {?{writer: string}} the foreign writer, or null
 */
function foreignWriterSince(entries, baselineUuid) {
  let from = 0;
  if (baselineUuid) {
    const at = entries.findIndex((e) => e && e.uuid === baselineUuid);
    // Not in the window: polpo has written so much since that the
    // baseline scrolled out, so everything in the window is newer.
    from = at === -1 ? 0 : at + 1;
  }
  for (let i = from; i < entries.length; i++) {
    const e = entries[i];
    if (!isConversational(e)) continue;
    const writer = typeof e.entrypoint === 'string' ? e.entrypoint : null;
    if (writer && !POLPO_WRITERS.has(writer)) return { writer };
  }
  return null;
}

function staleMs() {
  const n = Number(process.env.POLPO_SESSION_STALE_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_STALE_MS;
}

/**
 * Whether a Claude session is mid-turn, read from its transcript.
 *
 * The same rule the transcript watcher uses (a turn has ended when the
 * last main-conversation entry is an assistant message that ended it),
 * plus the stale escape for interrupted turns. Used instead of the
 * instance's status where that can be wrong: a session discovered just
 * after its last turn used to stay "busy" until you typed again, because
 * the watcher only sees what is written after it starts.
 *
 * @param {Array<object>} entries - transcript tail, oldest first
 * @param {object} [opts] - { now, staleMs }
 * @returns {{state: 'idle'|'busy'|'unknown', reason: string}}
 */
function transcriptActivity(entries, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const stale = o.staleMs || staleMs();
  let last = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isConversational(entries[i])) { last = entries[i]; break; }
  }
  if (!last) return { state: 'unknown', reason: 'no_turns' };
  const stop = last.type === 'assistant' && last.message ? last.message.stop_reason : null;
  if (stop && TURN_ENDED.has(stop)) return { state: 'idle', reason: 'turn_ended' };
  const at = Date.parse(last.timestamp || '');
  if (Number.isFinite(at) && now - at > stale) return { state: 'idle', reason: 'stale' };
  return { state: 'busy', reason: 'in_progress' };
}

/** Human name for a transcript writer, for messages shown to the user. */
function writerLabel(writer) {
  if (writer === 'claude-vscode') return 'VSCode';
  if (writer === 'cli') return 'a terminal';
  return 'another program';
}

/**
 * Gemini resumes by the session id inside its JSON transcript, which can
 * differ from the filename-derived id polpo lists.
 */
function resolveGeminiSessionId(sessionId, transcriptPath) {
  if (transcriptPath && transcriptPath.endsWith('.json')) {
    try {
      const data = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
      if (data.sessionId) return data.sessionId;
    } catch {}
  }
  try {
    const slugDirs = fs.readdirSync(GEMINI_TMP_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    for (const slug of slugDirs) {
      const candidate = path.join(GEMINI_TMP_DIR, slug, 'chats', `session-${sessionId}.json`);
      if (fs.existsSync(candidate)) {
        const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (data.sessionId) return data.sessionId;
      }
    }
  } catch {}
  return sessionId;
}

function isUsableDir(p) {
  if (!p || typeof p !== 'string' || !path.isAbsolute(p)) return false;
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function fail(error, message, extra) {
  return Object.assign({ ok: false, error, message }, extra || {});
}

/**
 * Drives sessions on behalf of the dashboard, the phone and the gateway,
 * under one rule: one writer at a time.
 *
 *   - a session whose agent is busy can only be read
 *   - an idle session can be taken over and continued (same session id)
 *   - a session polpo drives is handed back as soon as someone else writes
 *     to its transcript, e.g. VSCode after you reload the window
 *
 * A single instance is shared by every entry point, so that a takeover
 * made from the phone is respected by a prompt sent through the gateway.
 */
class SessionController {
  /**
   * @param {object} opts
   * @param {object} opts.instanceManager
   * @param {object} [opts.outboxManager]
   * @param {function} [opts.getAuthState]
   * @param {number} [opts.hubPort] - polpo's port, for agents to dial back
   * @param {function} [opts.createAgent] - injectable for tests
   * @param {object} [opts.sessions] - injectable sessions module, for tests
   */
  constructor(opts) {
    this.instanceManager = opts.instanceManager;
    this.outboxManager = opts.outboxManager || null;
    this.getAuthState = opts.getAuthState || null;
    this.hubPort = opts.hubPort || null;
    this._createAgent = opts.createAgent || null;
    this._sessions = opts.sessions || null;
    // sessionId (or instanceId, for brand-new sessions) -> agent object.
    // Formerly a map private to the dashboard API router.
    this.agents = new Map();
    // instanceId -> { baselineUuid, heldBy }
    this.held = new Map();
    // Instances whose transcript polpo has been asked to watch.
    this._watched = new Set();
  }

  _createAgentFn() {
    return this._createAgent || require('../agent/agent-factory').createAgent;
  }

  _sessionsModule() {
    return this._sessions || require('./sessions');
  }

  _serverUrl(serverUrl) {
    return serverUrl || ('ws://127.0.0.1:' + (this.hubPort || 7890));
  }

  _authToken() {
    const authState = typeof this.getAuthState === 'function' ? this.getAuthState() : null;
    return authState && authState.enabled ? authState.token : undefined;
  }

  /** Transcript path for an instance, looked up by session id if needed. */
  transcriptPathFor(inst) {
    if (!inst) return null;
    if (inst.transcriptPath) return inst.transcriptPath;
    const sessions = this._sessionsModule();
    if (inst.sessionId && typeof sessions.findSessionFile === 'function') {
      try { return sessions.findSessionFile(inst.sessionId) || null; } catch { return null; }
    }
    return null;
  }

  /**
   * Is the session mid-turn? For a Claude session the transcript decides,
   * and a stale status is corrected on the way. An approval polpo itself
   * is waiting on always counts as busy.
   */
  _busy(inst) {
    if (inst.status === 'waiting') return true;
    if (this._guarded(inst)) {
      const p = this.transcriptPathFor(inst);
      if (p) {
        const activity = transcriptActivity(readTranscriptTail(p));
        if (activity.state === 'idle') {
          if (inst.status === 'busy') this.instanceManager.updateStatus(inst.id, 'idle');
          return false;
        }
        if (activity.state === 'busy') return true;
      }
    }
    return inst.status === 'busy';
  }

  /** Whether the handback check applies: a Claude JSONL transcript. */
  _guarded(inst) {
    return !!inst && (!inst.agentType || inst.agentType === 'claude');
  }

  /** The live agent object for an instance's session, or null. */
  agentFor(inst) {
    if (!inst) return null;
    const agent = (inst.sessionId && this.agents.get(inst.sessionId)) || this.agents.get(inst.id) || null;
    if (!agent || agent.instanceId !== inst.id) return null;
    return agent;
  }

  _agentAlive(agent) {
    return !!(agent && this.instanceManager.get(agent.instanceId) && agent.ws && agent.ws.readyState === 1);
  }

  /** Mark an instance as driven by polpo, recording the takeover point. */
  _hold(instanceId, heldBy) {
    const inst = this.instanceManager.get(instanceId);
    if (!inst) return;
    let baselineUuid = null;
    if (this._guarded(inst)) {
      const p = this.transcriptPathFor(inst);
      if (p) {
        baselineUuid = lastConversationalUuid(readTranscriptTail(p));
        // Watch the transcript, as polpo does for sessions it only
        // observes. Status and messages then reflect whoever writes it,
        // polpo or VSCode, so "busy" stays true while VSCode works and
        // the session is really monitored after a handback. The watcher
        // starts at the end of the file, so history is not duplicated.
        if (inst.transcriptPath !== p || !this._watched.has(instanceId)) {
          this._watched.add(instanceId);
          this.instanceManager.setSessionInfo(instanceId, inst.sessionId, p);
        }
      }
    }
    this.held.set(instanceId, { baselineUuid, heldBy: heldBy || 'polpo' });
    this.instanceManager.setControl(instanceId, { canReceivePrompts: true, heldBy: heldBy || 'polpo' });
  }

  /**
   * Has someone else written to this session since polpo took it?
   * @returns {?{writer: string}}
   */
  checkHandback(inst) {
    if (!this._guarded(inst)) return null;
    const p = this.transcriptPathFor(inst);
    if (!p) return null;
    const rec = this.held.get(inst.id);
    return foreignWriterSince(readTranscriptTail(p), rec ? rec.baselineUuid : null);
  }

  /**
   * Stop driving a session and go back to watching it.
   *
   * Only the agent's claude process is stopped. Its in-memory state is
   * now stale, and the next takeover resumes from the transcript, which
   * includes whatever happened elsewhere. The instance and its transcript
   * watcher stay, so the session keeps one card in the dashboard.
   */
  release(instanceId, writer) {
    const inst = this.instanceManager.get(instanceId);
    if (!inst) return false;
    this.held.delete(instanceId);
    const agent = this.agentFor(inst);
    if (agent && typeof agent.releaseProcess === 'function') {
      try { agent.releaseProcess(); } catch {}
    }
    this.instanceManager.setControl(instanceId, { canReceivePrompts: false, heldBy: null });
    this.instanceManager.addMessage(instanceId, {
      role: 'system',
      content: 'This session was picked up again in ' + writerLabel(writer) +
        '. polpo stopped driving it and is now only watching. Take it over again once it is idle.',
      source: 'polpo',
    });
    return true;
  }

  /**
   * Send a prompt into a session.
   *
   * @param {string} instanceId
   * @param {string} text
   * @param {object} [opts]
   * @param {string} [opts.source] - who sent it: 'mobile', 'gateway:<client>'
   * @param {Array} [opts.attachments]
   * @param {string} [opts.clientMsgId] - the dashboard's optimistic-render id
   * @param {boolean} [opts.requireDelivery] - fail when no agent socket took
   *   it. The dashboard WebSocket path leaves this off, because the mind's
   *   chat has no agent socket and is driven by the message being logged.
   * @returns {{ok: true, queued: boolean} | {ok: false, error: string, message: string}}
   */
  sendPrompt(instanceId, text, opts) {
    const o = opts || {};
    const inst = this.instanceManager.get(instanceId);
    if (!inst) return fail('instance_not_found', 'No such session.');

    if (inst.canReceivePrompts !== false && this._guarded(inst) && this.agentFor(inst)) {
      const foreign = this.checkHandback(inst);
      if (foreign) {
        this.release(instanceId, foreign.writer);
        return fail('session_resumed_elsewhere',
          'This session was picked up again in ' + writerLabel(foreign.writer) +
          '. polpo stopped driving it; take it over again once it is idle.',
          { writer: foreign.writer });
      }
    }

    const promptText = this.outboxManager ? this.outboxManager.injectDirective(instanceId, text) : text;
    const sent = this.instanceManager.sendToAgent(instanceId, {
      type: 'prompt',
      text: promptText,
      attachments: o.attachments || [],
    });
    if (!sent && o.requireDelivery) {
      return fail('agent_not_connected', 'The agent for this session is not connected.');
    }
    this.instanceManager.addMessage(instanceId, {
      role: 'user',
      content: text,
      source: o.source || 'mobile',
      attachments: o.attachments || [],
      clientMsgId: typeof o.clientMsgId === 'string' ? o.clientMsgId : undefined,
    });
    return { ok: true, queued: inst.status === 'busy' };
  }

  /**
   * Take over a session so polpo can drive it.
   *
   * Refused while the agent is busy or waiting for an approval: whoever
   * is driving it must finish first. Works both for a session polpo only
   * watches (VSCode, a terminal) and for one polpo handed back earlier.
   *
   * @param {string} instanceId
   * @param {object} [opts]
   * @param {string} [opts.heldBy] - 'dashboard' or 'gateway:<client>'
   * @param {string} [opts.serverUrl]
   * @returns {Promise<{ok: true, instanceId: string, retaken?: boolean} | {ok: false, error: string, message: string}>}
   */
  async takeover(instanceId, opts) {
    const o = opts || {};
    const inst = this.instanceManager.get(instanceId);
    if (!inst) return fail('instance_not_found', 'No such session.');
    if (!inst.sessionId) return fail('no_session', 'This instance has no session to continue.');
    if (this._busy(inst)) {
      return fail('session_busy', 'The agent is still working. Wait until it is idle, then take it over.',
        { status: inst.status });
    }

    // A session polpo already runs an agent for (taken over earlier and
    // handed back, or open twice): reclaim it rather than spawning another.
    const existing = this.agents.get(inst.sessionId);
    if (existing && this._agentAlive(existing)) {
      if (existing.instanceId !== instanceId) {
        // The card the caller saw is a discovered duplicate of a session
        // polpo already runs; keep the agent's instance.
        this.instanceManager.unregister(instanceId);
      }
      this._hold(existing.instanceId, o.heldBy);
      return { ok: true, instanceId: existing.instanceId, retaken: true };
    }
    if (existing) this._forget(inst.sessionId, existing);

    const resumeId = inst.agentType === 'gemini'
      ? resolveGeminiSessionId(inst.sessionId, inst.transcriptPath)
      : inst.sessionId;
    const agent = this._createAgentFn()(inst.agentType || 'claude', {
      name: 'Takeover (' + (inst.name || inst.sessionId.slice(0, 8)) + ')',
      cwd: inst.cwd,
      resumeSessionId: resumeId,
      serverUrl: this._serverUrl(o.serverUrl),
      token: this._authToken(),
    });
    await agent.start();
    this.track(inst.sessionId, agent);

    // Carry the session over to the agent's instance and retire the
    // watched one it replaces.
    const newInst = this.instanceManager.get(agent.instanceId);
    if (newInst) {
      newInst.sessionId = inst.sessionId;
      newInst.transcriptPath = inst.transcriptPath;
      if (Array.isArray(inst.conversation) && inst.conversation.length) {
        newInst.conversation = inst.conversation.slice();
      }
    }
    this.instanceManager.unregister(instanceId);
    this._hold(agent.instanceId, o.heldBy);
    return { ok: true, instanceId: agent.instanceId };
  }

  /**
   * Resume a session from the catalogue (not necessarily live), so polpo
   * can drive it. Refused while a live copy of it is busy elsewhere.
   *
   * @param {string} sessionId
   * @param {object} [opts] - { name, cwd, agentType, heldBy, serverUrl }
   */
  async resume(sessionId, opts) {
    const o = opts || {};
    const liveSummary = (this.instanceManager.getAll() || []).find((i) => i && i.sessionId === sessionId);
    const live = liveSummary ? this.instanceManager.get(liveSummary.id) : null;
    if (live && this._busy(live)) {
      return fail('session_busy', 'The agent is still working. Wait until it is idle, then resume it.',
        { status: live.status, instanceId: live.id });
    }

    const existing = this.agents.get(sessionId);
    if (existing && this._agentAlive(existing)) {
      this._hold(existing.instanceId, o.heldBy);
      return { ok: true, instanceId: existing.instanceId, alreadyRunning: true };
    }
    if (existing) this._forget(sessionId, existing);

    // The cwd recorded in the session's own transcript wins: agents find
    // a transcript by hashing the cwd into a project slug, so resuming
    // from anywhere else does not find it. The caller's cwd is a fallback
    // for stores this cannot read and for a project that has moved.
    let resolvedCwd = null;
    try {
      const sessions = this._sessionsModule();
      const recorded = typeof sessions.resolveSessionCwd === 'function'
        ? await sessions.resolveSessionCwd(sessionId)
        : null;
      if (isUsableDir(recorded)) resolvedCwd = recorded;
    } catch { /* unreadable store */ }
    if (!resolvedCwd && isUsableDir(o.cwd)) resolvedCwd = o.cwd;
    if (!resolvedCwd) resolvedCwd = process.cwd();

    const resumeId = o.agentType === 'gemini' ? resolveGeminiSessionId(sessionId) : sessionId;
    const agent = this._createAgentFn()(o.agentType || 'claude', {
      name: o.name || ('Resumed (' + sessionId.slice(0, 8) + ')'),
      cwd: resolvedCwd,
      resumeSessionId: resumeId,
      serverUrl: this._serverUrl(o.serverUrl),
      token: this._authToken(),
    });
    await agent.start();
    this.track(sessionId, agent);
    // Set the session id right away so the dashboard can dedup.
    this.instanceManager.setSessionInfo(agent.instanceId, resumeId, null);
    this._hold(agent.instanceId, o.heldBy);
    return { ok: true, instanceId: agent.instanceId };
  }

  /** Remember an agent and forget it when its connection closes. */
  track(key, agent) {
    this.agents.set(key, agent);
    if (agent.ws && typeof agent.ws.on === 'function') {
      agent.ws.on('close', () => {
        if (this.agents.get(key) === agent) this.agents.delete(key);
        this.held.delete(agent.instanceId);
        this._watched.delete(agent.instanceId);
        this.instanceManager.unregister(agent.instanceId);
      });
    }
  }

  _forget(key, agent) {
    if (agent.instanceId) this.instanceManager.unregister(agent.instanceId);
    this.agents.delete(key);
    this.held.delete(agent.instanceId);
    if (agent.ws) { try { agent.ws.close(); } catch {} }
  }
}

module.exports = {
  SessionController,
  transcriptActivity,
  DEFAULT_STALE_MS,
  POLPO_WRITERS,
  readTranscriptTail,
  lastConversationalUuid,
  foreignWriterSince,
  writerLabel,
  resolveGeminiSessionId,
  INSTANCE_ID_RE,
  MAX_MESSAGE_CHARS,
  MAX_CONVERSATION_LIMIT,
  originOf,
  describeInstance,
  describeApproval,
  conversationSince,
  serializeMessage,
};
