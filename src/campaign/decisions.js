/**
 * Pending decisions: everything a campaign waits on, the same object on
 * the dashboard, the phone and the gateway.
 *
 * The first valid answer closes a decision; a later one is refused with
 * what was decided and where. A decision is tied to the state it asked
 * about, and is superseded when the campaign moves on.
 *
 * See docs/campaigns.md, section 4.10.
 */

'use strict';

const crypto = require('crypto');

const KINDS = new Set(['definition', 'verdict', 'question', 'budget', 'approval', 'resume']);
// The kinds a PA could ever be allowed to decide on its own. The others
// are always yours.
const AGENT_MAY_ALLOWED = new Set(['question', 'budget', 'resume']);
const MAX_ANSWER_TEXT = 4000;
const DECISION_ID_RE = /^dec-[0-9a-f]{8,32}$/;

/**
 * Parse POLPO_CAMPAIGN_AGENT_MAY. Throws on a kind a PA may never decide,
 * or on anything unknown, so a typo cannot widen it silently.
 * @returns {Set<string>}
 */
function parseAgentMay(value) {
  const out = new Set();
  if (value === undefined || value === null || String(value).trim() === '') return out;
  for (const raw of String(value).split(',')) {
    const k = raw.trim();
    if (!k) continue;
    if (!KINDS.has(k)) throw new Error('POLPO_CAMPAIGN_AGENT_MAY: unknown decision kind "' + k + '"');
    if (!AGENT_MAY_ALLOWED.has(k)) {
      throw new Error('POLPO_CAMPAIGN_AGENT_MAY: "' + k + '" decisions are always yours; only '
        + [...AGENT_MAY_ALLOWED].join(', ') + ' can be listed');
    }
    out.add(k);
  }
  return out;
}

function newDecisionId() {
  return 'dec-' + crypto.randomBytes(6).toString('hex');
}

function fail(error, message, extra) {
  return Object.assign({ ok: false, error, message }, extra || {});
}

/**
 * Check an answer against a pending decision.
 *
 * @param {object} decision
 * @param {object} answer - { answer, text, hash, channel, decidedBy, userMessage }
 * @param {Set<string>} agentMay
 * @returns {{ok: true} | {ok: false, error: string, message: string}}
 */
function checkAnswer(decision, answer, agentMay) {
  if (decision.status === 'closed') {
    return fail('decision_closed', 'This decision was already answered.', {
      decided: {
        answer: decision.answer, channel: decision.channel, decidedBy: decision.decidedBy, at: decision.closedAt,
      },
    });
  }
  if (decision.status === 'superseded') {
    return fail('decision_superseded', 'The campaign moved on; this decision no longer applies.', {
      reason: decision.supersededBy || null,
    });
  }
  const a = answer || {};
  if (typeof a.answer !== 'string' || decision.options.indexOf(a.answer) === -1) {
    return fail('invalid_answer', 'answer must be one of: ' + decision.options.join(', ') + '.');
  }
  const text = typeof a.text === 'string' ? a.text.trim() : '';
  if (a.text !== undefined && typeof a.text !== 'string') return fail('invalid_text', 'text must be a string.');
  if (text.length > MAX_ANSWER_TEXT) return fail('invalid_text', 'text is longer than ' + MAX_ANSWER_TEXT + ' characters.');
  if (decision.needsText && decision.needsText[a.answer] && !text) {
    return fail('text_required', 'This answer needs text: ' + decision.needsText[a.answer] + '.');
  }
  if (decision.kind === 'definition' && decision.details && decision.details.hash && a.answer === 'approve'
    && a.hash !== decision.details.hash) {
    return fail('hash_mismatch', 'Approving a campaign file needs the hash of the version you were shown.', {
      hash: decision.details.hash,
    });
  }
  if (a.decidedBy === 'agent' && !(agentMay && agentMay.has(decision.kind))) {
    return fail('agent_may_not_decide', 'A ' + decision.kind + ' decision must be decided by the user.');
  }
  return { ok: true };
}

/**
 * Check the relay attestation a gateway caller sends with an answer.
 * @returns {{ok: true, decidedBy: string, userMessage: ?string} | {ok: false, error: string, message: string}}
 */
function checkRelay(relay) {
  if (!relay || typeof relay !== 'object') {
    return fail('invalid_relay', 'relay is required: { decidedBy: "user" | "agent", userMessage }.');
  }
  if (relay.decidedBy !== 'user' && relay.decidedBy !== 'agent') {
    return fail('invalid_relay', 'relay.decidedBy must be "user" or "agent".');
  }
  let userMessage = null;
  if (relay.userMessage !== undefined && relay.userMessage !== null) {
    if (typeof relay.userMessage !== 'string' || relay.userMessage.length > MAX_ANSWER_TEXT) {
      return fail('invalid_relay', 'relay.userMessage must be a string of at most ' + MAX_ANSWER_TEXT + ' characters.');
    }
    userMessage = relay.userMessage;
  }
  if (relay.decidedBy === 'user' && !(userMessage && userMessage.trim())) {
    return fail('invalid_relay', 'relay.userMessage is required when the user decided: their words, verbatim.');
  }
  return { ok: true, decidedBy: relay.decidedBy, userMessage };
}

/** A decision as every surface shows it. */
function publicDecision(d) {
  const out = {
    decisionId: d.decisionId,
    campaignId: d.campaignId,
    kind: d.kind,
    milestone: d.milestone || null,
    createdAt: d.createdAt,
    seq: d.seq,
    status: d.status,
    text: d.text,
    options: d.options.slice(),
    needsText: d.needsText || {},
    details: d.details || {},
  };
  if (d.status === 'closed') {
    out.answer = d.answer;
    out.answerText = d.answerText || null;
    out.channel = d.channel;
    out.decidedBy = d.decidedBy;
    out.closedAt = d.closedAt;
  }
  if (d.status === 'superseded') out.supersededBy = d.supersededBy || null;
  return out;
}

module.exports = {
  KINDS,
  AGENT_MAY_ALLOWED,
  DECISION_ID_RE,
  MAX_ANSWER_TEXT,
  parseAgentMay,
  newDecisionId,
  checkAnswer,
  checkRelay,
  publicDecision,
};
