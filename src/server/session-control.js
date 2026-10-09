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

// A single message can be large (a tool result, a whole file the agent
// read). The conversation API caps each one so a poll stays small.
const MAX_MESSAGE_CHARS = 20000;
const DEFAULT_CONVERSATION_LIMIT = 50;
const MAX_CONVERSATION_LIMIT = 200;
const MAX_APPROVAL_INPUT_CHARS = 2000;

// Instance ids are UUIDs minted by the instance manager; anything else is
// rejected before it reaches a lookup.
const INSTANCE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

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

module.exports = {
  INSTANCE_ID_RE,
  MAX_MESSAGE_CHARS,
  MAX_CONVERSATION_LIMIT,
  originOf,
  describeInstance,
  describeApproval,
  conversationSince,
  serializeMessage,
};
