const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');

class InstanceManager extends EventEmitter {
  constructor() {
    super();
    // instanceId -> instance data
    this.instances = new Map();
  }

  register(info) {
    const id = info.id || uuidv4();
    const instance = {
      id,
      name: info.name || `Instance ${this.instances.size + 1}`,
      type: info.type || 'terminal', // 'terminal' | 'vscode'
      project: info.project || 'unknown',
      cwd: info.cwd || '',
      status: 'idle', // 'idle' | 'busy' | 'waiting' | 'paused' | 'disconnected'
      lastActivity: Date.now(),
      registeredAt: Date.now(),
      conversation: [],
      // Monotonic per-instance counter stamped on every addMessage().
      // Lets clients defeat duplicate-broadcast delivery (e.g. when a
      // stale WebSocket on the dashboard side hasn't fully closed yet
      // and so receives the same event on every still-open socket).
      // Seq is monotonic but NOT persisted across server restarts —
      // a restart wipes the instance, so the new instance id implies
      // a fresh counter.
      _msgSeq: 0,
      pendingApproval: null,
      autoApprove: false,
      agentSocket: null, // WebSocket back to the agent
      sessionId: info.sessionId || null,
      transcriptPath: info.transcriptPath || null,
      canReceivePrompts: info.canReceivePrompts !== undefined ? info.canReceivePrompts : true,
      firstPrompt: info.firstPrompt || null,
      agentType: info.agentType || 'claude',
      // Origin tag, e.g. 'gateway:openclaw', 'mind', or null for user-started.
      // Used by the dashboard to distinguish programmatic agents from manual ones.
      source: info.source || null,
    };
    this.instances.set(id, instance);
    this.emit('instance:registered', instance);
    return instance;
  }

  unregister(id) {
    const instance = this.instances.get(id);
    if (instance) {
      instance.status = 'disconnected';
      this.emit('instance:disconnected', instance);
      this.instances.delete(id);
    }
  }

  get(id) {
    return this.instances.get(id);
  }

  getAll() {
    return Array.from(this.instances.values()).map((inst) => ({
      id: inst.id,
      name: inst.name,
      type: inst.type,
      project: inst.project,
      cwd: inst.cwd,
      status: inst.status,
      lastActivity: inst.lastActivity,
      registeredAt: inst.registeredAt,
      conversationLength: inst.conversation.length,
      pendingApproval: inst.pendingApproval,
      autoApprove: inst.autoApprove,
      sessionId: inst.sessionId,
      canReceivePrompts: inst.canReceivePrompts,
      firstPrompt: inst.firstPrompt,
      agentType: inst.agentType,
      source: inst.source,
    }));
  }

  updateStatus(id, status) {
    const instance = this.instances.get(id);
    if (instance) {
      instance.status = status;
      instance.lastActivity = Date.now();
      this.emit('instance:status', { id, status });
    }
  }

  addMessage(id, message) {
    const instance = this.instances.get(id);
    if (instance) {
      // Stamp every message with a monotonic per-instance sequence
      // number. This is what lets the dashboard drop duplicate
      // broadcasts: any (id, seq) pair is uniquely identifying, and
      // a client that has already processed seq N can safely ignore
      // any later arrival with seq <= N for the same id.
      instance._msgSeq = (instance._msgSeq || 0) + 1;
      const stamped = {
        ...message,
        seq: instance._msgSeq,
        timestamp: message && message.timestamp ? message.timestamp : Date.now(),
      };
      instance.conversation.push(stamped);
      instance.lastActivity = Date.now();
      // Keep only last 200 messages per instance to manage memory
      if (instance.conversation.length > 200) {
        instance.conversation = instance.conversation.slice(-200);
      }
      this.emit('instance:message', { id, message: stamped });
    }
  }

  getConversation(id, limit = 50) {
    const instance = this.instances.get(id);
    if (!instance) return [];
    return instance.conversation.slice(-limit);
  }

  setPendingApproval(id, approval) {
    const instance = this.instances.get(id);
    if (instance) {
      instance.pendingApproval = approval;
      instance.status = 'waiting';
      instance.lastActivity = Date.now();
      this.emit('instance:approval', { id, approval });
    }
  }

  clearPendingApproval(id) {
    const instance = this.instances.get(id);
    if (instance) {
      instance.pendingApproval = null;
      if (instance.status === 'waiting') {
        instance.status = 'busy';
      }
      instance.lastActivity = Date.now();
      this.emit('instance:approval', { id, approval: null });
    }
  }

  setAutoApprove(id, value) {
    const instance = this.instances.get(id);
    if (instance) {
      instance.autoApprove = !!value;
      instance.lastActivity = Date.now();
      this.emit('instance:autoApprove', { id, autoApprove: instance.autoApprove });
    }
  }

  setSessionInfo(id, sessionId, transcriptPath) {
    const instance = this.instances.get(id);
    if (instance) {
      instance.sessionId = sessionId;
      instance.transcriptPath = transcriptPath;
      instance.lastActivity = Date.now();
      this.emit('instance:session_info', { id, sessionId, transcriptPath });
    }
  }

  setAgentSocket(id, socket) {
    const instance = this.instances.get(id);
    if (instance) {
      instance.agentSocket = socket;
    }
  }

  sendToAgent(id, message) {
    const instance = this.instances.get(id);
    if (instance && instance.agentSocket && instance.agentSocket.readyState === 1) {
      instance.agentSocket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }
}

module.exports = InstanceManager;
