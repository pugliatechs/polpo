/**
 * Approvals an agent is waiting on, one per instance.
 *
 * The MCP permission server long-polls the hub with each tool approval;
 * the request is answered when someone approves or rejects it. Formerly
 * a map private to the dashboard API router; shared now so a campaign can
 * answer an approval it carried to a PA through the gateway.
 *
 * Two kinds of wait:
 *
 *   expiring  denied after `expiresMs` (five minutes on the dashboard):
 *             right for a session someone is watching
 *   held      never expires; the hub answers {retry: true} every
 *             `holdMs` and the permission server asks again with the
 *             same tool_use_id, so no HTTP request stays open for hours
 *
 * Emits 'settled' { instanceId, toolUseId, decision, meta } whenever a
 * pending approval is answered, by anyone, or expires.
 */

'use strict';

const EventEmitter = require('events');

const DEFAULT_EXPIRES_MS = 5 * 60 * 1000;
const DEFAULT_HOLD_MS = 4 * 60 * 1000;

class PendingApprovals extends EventEmitter {
  /** @param {object} instanceManager */
  constructor(instanceManager) {
    super();
    this.instanceManager = instanceManager;
    // instanceId -> { toolUseId, toolInput, approvalType, waiter, timer,
    //                 holdTimer, decision, settled }
    this._pending = new Map();
  }

  /** The approval an instance waits on, or null. */
  current(instanceId) {
    const e = this._pending.get(instanceId);
    if (!e || e.settled) return null;
    return { toolUseId: e.toolUseId, toolInput: e.toolInput, approvalType: e.approvalType };
  }

  /**
   * Whether this request asks again about the approval already pending
   * (a held wait the hub told to retry).
   */
  isRepoll(instanceId, toolUseId) {
    const e = this._pending.get(instanceId);
    return !!(e && toolUseId && e.toolUseId === toolUseId);
  }

  /**
   * Wait for a decision.
   *
   * @param {string} instanceId
   * @param {{toolUseId?: string, toolInput?: object, approvalType?: string}} req
   * @param {{expiresMs?: ?number, holdMs?: ?number}} [opts] - expiresMs
   *   null means it never expires; holdMs set means answer {retry: true}
   *   after that long
   * @returns {Promise<object>} the decision for the permission server
   */
  wait(instanceId, req, opts) {
    const o = opts || {};
    const existing = this._pending.get(instanceId);
    if (existing && req.toolUseId && existing.toolUseId === req.toolUseId) {
      if (existing.settled) {
        this._drop(instanceId, existing);
        return Promise.resolve(existing.decision);
      }
      if (existing.waiter) existing.waiter({ retry: true });
      return this._attach(existing, o.holdMs);
    }
    if (existing) {
      // A new request while another is pending: either the old one was
      // abandoned (its process is gone) or the agent asked for two at
      // once. Either way nobody answered the old one, so it is denied.
      // It used to be allowed, which approved a parallel tool call that
      // no one had seen.
      this._finish(instanceId, existing, { behavior: 'deny', message: 'Superseded by a newer approval request' }, { via: 'superseded' });
    }
    const entry = {
      toolUseId: req.toolUseId || null,
      toolInput: req.toolInput,
      approvalType: req.approvalType || 'tool',
      waiter: null,
      timer: null,
      holdTimer: null,
      decision: null,
      settled: false,
    };
    this._pending.set(instanceId, entry);
    const expiresMs = o.expiresMs === undefined ? DEFAULT_EXPIRES_MS : o.expiresMs;
    if (expiresMs) {
      entry.timer = setTimeout(() => {
        this.settle(instanceId, { behavior: 'deny', message: 'Approval timed out' }, { via: 'timeout' });
      }, expiresMs);
    }
    return this._attach(entry, o.holdMs);
  }

  _attach(entry, holdMs) {
    clearTimeout(entry.holdTimer);
    entry.holdTimer = null;
    return new Promise((resolve) => {
      entry.waiter = resolve;
      if (holdMs) {
        entry.holdTimer = setTimeout(() => {
          if (entry.waiter !== resolve) return;
          entry.waiter = null;
          resolve({ retry: true });
        }, holdMs);
      }
    });
  }

  /**
   * Answer the pending approval of an instance.
   *
   * @param {string} instanceId
   * @param {object} decision - { behavior: 'allow'|'deny', ... }
   * @param {object} [meta] - who answered and how, passed to listeners
   * @returns {boolean} false when nothing was pending
   */
  settle(instanceId, decision, meta) {
    const entry = this._pending.get(instanceId);
    if (!entry || entry.settled) return false;
    this._finish(instanceId, entry, decision, meta || {});
    return true;
  }

  /** Allow, keeping the input the tool was called with. */
  approve(instanceId, meta) {
    const e = this.current(instanceId);
    if (!e) return false;
    return this.settle(instanceId, { behavior: 'allow', updatedInput: e.toolInput }, meta);
  }

  reject(instanceId, message, meta) {
    return this.settle(instanceId, { behavior: 'deny', message: message || 'Rejected via Polpo' }, meta);
  }

  /** Answer an AskUserQuestion: the answers are merged into its input. */
  answer(instanceId, answers, meta) {
    const e = this.current(instanceId);
    if (!e) return false;
    const updatedInput = Object.assign({}, e.toolInput, { answers: answers || {} });
    return this.settle(instanceId, { behavior: 'allow', updatedInput }, meta);
  }

  _finish(instanceId, entry, decision, meta) {
    clearTimeout(entry.timer);
    clearTimeout(entry.holdTimer);
    entry.settled = true;
    entry.decision = decision;
    if (this.instanceManager) this.instanceManager.clearPendingApproval(instanceId);
    if (entry.waiter) {
      const w = entry.waiter;
      entry.waiter = null;
      this._drop(instanceId, entry);
      w(decision);
    } else {
      // Between a retry and the request that follows it: keep the answer
      // for that request, and forget it if the request never comes.
      entry.timer = setTimeout(() => this._drop(instanceId, entry), DEFAULT_HOLD_MS * 2);
      if (entry.timer.unref) entry.timer.unref();
    }
    this.emit('settled', { instanceId, toolUseId: entry.toolUseId, decision, meta: meta || {} });
  }

  _drop(instanceId, entry) {
    clearTimeout(entry.timer);
    if (this._pending.get(instanceId) === entry) this._pending.delete(instanceId);
  }

  destroy() {
    for (const [, e] of this._pending) { clearTimeout(e.timer); clearTimeout(e.holdTimer); }
    this._pending.clear();
    this.removeAllListeners();
  }
}

module.exports = { PendingApprovals, DEFAULT_EXPIRES_MS, DEFAULT_HOLD_MS };
