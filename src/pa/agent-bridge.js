/**
 * AgentBridge — bridges polpo's agent system with Telegram.
 *
 * Spawns a coding agent, subscribes to InstanceManager events, and provides
 * methods for Telegram handlers to send prompts and receive responses.
 *
 * Phase 6 enhancements (from moltbot stream-agent patterns):
 *   - --allowedTools whitelist for PA mode
 *   - History injection on first prompt (from memory DB)
 *   - Turn serialization (wait for idle before sending next prompt)
 *   - Per-prompt timeout (returns partial text on timeout)
 *   - Idle cleanup (kill agent after configurable inactivity)
 *   - CLAUDE_STREAM_ACTIVE=1 env to signal auth-renew
 */

const path = require('path');
const { ensurePAWorkspace } = require('./workspace');

var POLL_INTERVAL_MS = 500;

class AgentBridge {
  /**
   * @param {object} opts
   * @param {object} opts.instanceManager - Polpo InstanceManager
   * @param {number} opts.serverPort - Hub port for agent WebSocket connection
   * @param {string|null} opts.authToken - Auth token for agent registration
   * @param {object} opts.agentConfig - { type, cwd, model, name, allowedTools, idleTimeoutMinutes, promptTimeoutMs, historyInjectCount }
   * @param {object} [opts.memory] - MemoryManager instance for history injection
   */
  constructor(opts) {
    this.instanceManager = opts.instanceManager;
    this.serverPort = opts.serverPort;
    this.authToken = opts.authToken || null;
    this.agentConfig = opts.agentConfig || {};
    this.memory = opts.memory || null;

    this.agent = null;
    this.instanceId = null;
    this.agentType = null;

    // Turn serialization state
    this._busy = false;
    this._promptQueue = [];
    this._historyInjected = false;

    // Idle cleanup
    this._lastActivity = Date.now();
    this._idleTimer = null;

    this._messageCallbacks = [];
    this._approvalCallbacks = [];
    this._statusCallbacks = [];
    this._eventHandlers = {};
  }

  /**
   * Spawn a coding agent and connect it to the hub.
   */
  async spawnAgent() {
    if (this.agent) {
      throw new Error('Agent already running');
    }

    var createAgent = require('../agent/agent-factory').createAgent;

    var config = this.agentConfig;
    var agentType = config.type || 'claude';

    // For Claude: use PA workspace as cwd (gives CLAUDE.md with PA instructions)
    var cwd;
    if (agentType === 'claude') {
      cwd = config.cwd || ensurePAWorkspace();
      if (config.cwd) ensurePAWorkspace();
    } else {
      cwd = config.cwd || require('os').homedir();
    }

    // Build agent options
    var agentOpts = {
      name: config.name || 'Personal Assistant',
      cwd: cwd,
      model: config.model || undefined,
      serverUrl: 'ws://127.0.0.1:' + this.serverPort,
      token: this.authToken,
      type: 'pa',
      project: 'personal-assistant',
    };

    // Claude-specific PA options
    if (agentType === 'claude') {
      // --allowedTools whitelist instead of MCP/bypass
      if (config.allowedTools && config.allowedTools.length > 0) {
        agentOpts.allowedTools = config.allowedTools;
      }
      // Set env flags for stream mode
      agentOpts.extraEnv = {
        CLAUDE_STREAM_ACTIVE: '1', // Signal auth-renew to skip direct API refresh
      };
    }

    this.agent = createAgent(agentType, agentOpts);
    this.agentType = agentType;
    this._historyInjected = false;
    this._busy = false;
    this._lastActivity = Date.now();

    await this.agent.start();
    this.instanceId = this.agent.instanceId;

    this._subscribeToEvents();
    this._startIdleCleanup();
  }

  /**
   * Subscribe to InstanceManager events for this agent instance.
   */
  _subscribeToEvents() {
    var self = this;

    this._eventHandlers.message = function (data) {
      if (data.id === self.instanceId) {
        self._lastActivity = Date.now();
        for (var i = 0; i < self._messageCallbacks.length; i++) {
          try { self._messageCallbacks[i](data.message); } catch (e) {
            console.error('[pa-bridge] Message callback error:', e.message);
          }
        }
      }
    };

    this._eventHandlers.approval = function (data) {
      if (data.id === self.instanceId) {
        self._lastActivity = Date.now();
        for (var i = 0; i < self._approvalCallbacks.length; i++) {
          try { self._approvalCallbacks[i](data.approval, data.id); } catch (e) {
            console.error('[pa-bridge] Approval callback error:', e.message);
          }
        }
      }
    };

    this._eventHandlers.status = function (data) {
      if (data.id === self.instanceId) {
        self._lastActivity = Date.now();
        // Track busy/idle for turn serialization
        if (data.status === 'idle') {
          self._busy = false;
          self._processQueue();
        } else if (data.status === 'busy') {
          self._busy = true;
        }
        for (var i = 0; i < self._statusCallbacks.length; i++) {
          try { self._statusCallbacks[i](data.status, data.id); } catch (e) {
            console.error('[pa-bridge] Status callback error:', e.message);
          }
        }
      }
    };

    this.instanceManager.on('instance:message', this._eventHandlers.message);
    this.instanceManager.on('instance:approval', this._eventHandlers.approval);
    this.instanceManager.on('instance:status', this._eventHandlers.status);
  }

  /**
   * Unsubscribe from InstanceManager events.
   */
  _unsubscribeFromEvents() {
    if (this._eventHandlers.message) {
      this.instanceManager.removeListener('instance:message', this._eventHandlers.message);
    }
    if (this._eventHandlers.approval) {
      this.instanceManager.removeListener('instance:approval', this._eventHandlers.approval);
    }
    if (this._eventHandlers.status) {
      this.instanceManager.removeListener('instance:status', this._eventHandlers.status);
    }
    this._eventHandlers = {};
  }

  // ---- Turn serialization ----

  /**
   * Send a text prompt to the agent with turn serialization.
   * If the agent is busy, the prompt is queued and sent when idle.
   */
  sendPrompt(text) {
    if (!this.instanceId) {
      throw new Error('No agent running');
    }
    this._lastActivity = Date.now();

    // Queue the prompt
    this._promptQueue.push(text);

    // Process if not busy
    if (!this._busy) {
      this._processQueue();
    }
  }

  /**
   * Process the next prompt in the queue.
   */
  _processQueue() {
    if (this._busy || this._promptQueue.length === 0) return;

    var text = this._promptQueue.shift();
    this._busy = true;

    // History injection on first prompt of this session
    if (!this._historyInjected && this.memory) {
      text = this._injectHistory(text);
      this._historyInjected = true;
    }

    this.instanceManager.sendToAgent(this.instanceId, {
      type: 'prompt',
      text: text,
    });
  }

  /**
   * Inject conversation history from memory DB into the first prompt.
   * Formats as XML block similar to moltbot's stream-agent.
   * @param {string} text - The user's prompt
   * @returns {string} Prompt with history prepended
   */
  _injectHistory(text) {
    if (!this.memory) return text;

    try {
      var chatId = this._getPrimaryChatId();
      if (!chatId) return text;

      var count = this.agentConfig.historyInjectCount || 20;
      var history = this.memory.getHistory(chatId, count);
      if (!history || history.length === 0) return text;

      var lines = [];
      for (var i = 0; i < history.length; i++) {
        var msg = history[i];
        var role = msg.role === 'assistant' ? 'Assistant' : 'User';
        var content = msg.content || '';
        // Truncate long messages
        if (content.length > 500) {
          content = content.slice(0, 500) + '...';
        }
        lines.push(role + ': ' + content);
      }

      if (lines.length === 0) return text;

      return '<conversation_history>\n' +
        lines.join('\n') +
        '\n</conversation_history>\n\n' + text;
    } catch {
      return text;
    }
  }

  /**
   * Get the primary chat ID from memory. Returns the most recent chat ID.
   * @returns {string|null}
   */
  _getPrimaryChatId() {
    // The primary chat ID is tracked by the PA index module
    return this._primaryChatId || null;
  }

  /**
   * Set the primary chat ID (called from PA index when first message arrives).
   * @param {string} chatId
   */
  setPrimaryChatId(chatId) {
    this._primaryChatId = String(chatId);
  }

  // ---- Idle cleanup ----

  /**
   * Start idle cleanup interval.
   */
  _startIdleCleanup() {
    var self = this;
    var timeoutMs = (this.agentConfig.idleTimeoutMinutes || 30) * 60 * 1000;

    this._stopIdleCleanup();
    this._idleTimer = setInterval(function () {
      if (!self.agent) return;
      if (self._busy) return; // Don't kill while processing
      if (Date.now() - self._lastActivity > timeoutMs) {
        console.log('[pa-bridge] Agent idle for ' + self.agentConfig.idleTimeoutMinutes + 'm, stopping');
        self._stopAgentProcess();
      }
    }, 60000); // Check every 60 seconds
  }

  /**
   * Stop idle cleanup interval.
   */
  _stopIdleCleanup() {
    if (this._idleTimer) {
      clearInterval(this._idleTimer);
      this._idleTimer = null;
    }
  }

  /**
   * Stop just the agent process (not the bridge). Allows auto-respawn on next prompt.
   */
  _stopAgentProcess() {
    if (this.agent) {
      this.agent.stop();
      this.agent = null;
    }
    if (this.instanceId) {
      this.instanceManager.unregister(this.instanceId);
      this.instanceId = null;
    }
    this._busy = false;
  }

  // ---- Standard methods ----

  /**
   * Approve a pending action on the PA agent.
   */
  approve() {
    if (!this.instanceId) return;
    this._lastActivity = Date.now();
    this.instanceManager.sendToAgent(this.instanceId, { type: 'approve' });
    this.instanceManager.clearPendingApproval(this.instanceId);
  }

  /**
   * Reject a pending action on the PA agent.
   */
  reject() {
    if (!this.instanceId) return;
    this._lastActivity = Date.now();
    this.instanceManager.sendToAgent(this.instanceId, { type: 'reject' });
    this.instanceManager.clearPendingApproval(this.instanceId);
  }

  /**
   * Abort the running agent task.
   */
  abort() {
    if (!this.instanceId) return;
    this.instanceManager.sendToAgent(this.instanceId, { type: 'abort' });
    this._busy = false;
    this._processQueue();
  }

  /**
   * Stop and clean up the agent and bridge.
   */
  stopAgent() {
    this._stopIdleCleanup();
    this._unsubscribeFromEvents();
    this._promptQueue = [];

    if (this.agent) {
      this.agent.stop();
      this.agent = null;
    }
    if (this.instanceId) {
      this.instanceManager.unregister(this.instanceId);
      this.instanceId = null;
    }
    this.agentType = null;
    this._busy = false;
    this._historyInjected = false;
  }

  /**
   * Get the current agent's instance ID (null if not running).
   */
  getInstanceId() {
    return this.instanceId;
  }

  /**
   * Get the current agent type (null if not running).
   */
  getAgentType() {
    return this.agentType;
  }

  /**
   * List all active instances from InstanceManager.
   */
  listAllInstances() {
    return this.instanceManager.getAll().map(function (inst) {
      return {
        id: inst.id,
        name: inst.name || inst.project || inst.id,
        status: inst.status || 'unknown',
        project: inst.project || '',
        agentType: inst.agentType || 'claude',
        isPa: inst.id === this.instanceId,
      };
    }.bind(this));
  }

  /**
   * Approve a pending action on any instance.
   */
  approveInstance(instanceId) {
    var inst = this.instanceManager.get(instanceId);
    if (!inst) return false;
    this.instanceManager.sendToAgent(instanceId, { type: 'approve' });
    this.instanceManager.clearPendingApproval(instanceId);
    return true;
  }

  /**
   * Reject a pending action on any instance.
   */
  rejectInstance(instanceId) {
    var inst = this.instanceManager.get(instanceId);
    if (!inst) return false;
    this.instanceManager.sendToAgent(instanceId, { type: 'reject' });
    this.instanceManager.clearPendingApproval(instanceId);
    return true;
  }

  onMessage(cb) { this._messageCallbacks.push(cb); }
  onApproval(cb) { this._approvalCallbacks.push(cb); }
  onStatusChange(cb) { this._statusCallbacks.push(cb); }
}

module.exports = { AgentBridge };
