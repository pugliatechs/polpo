const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const InstanceManager = require('../src/server/instances');

describe('InstanceManager', () => {
  let mgr;

  beforeEach(() => {
    mgr = new InstanceManager();
  });

  describe('register', () => {
    it('creates an instance with defaults', () => {
      const inst = mgr.register({ name: 'Test' });
      assert.ok(inst.id);
      assert.equal(inst.name, 'Test');
      assert.equal(inst.type, 'terminal');
      assert.equal(inst.status, 'idle');
      assert.equal(inst.autoApprove, false);
      assert.deepEqual(inst.conversation, []);
      assert.equal(inst.pendingApproval, null);
    });

    it('uses provided id', () => {
      const inst = mgr.register({ id: 'custom-id', name: 'X' });
      assert.equal(inst.id, 'custom-id');
      assert.equal(mgr.get('custom-id'), inst);
    });

    it('emits instance:registered event', () => {
      let emitted = null;
      mgr.on('instance:registered', (inst) => { emitted = inst; });
      const inst = mgr.register({ name: 'E' });
      assert.equal(emitted, inst);
    });

    it('increments default name counter', () => {
      const a = mgr.register({});
      const b = mgr.register({});
      assert.equal(a.name, 'Instance 1');
      assert.equal(b.name, 'Instance 2');
    });
  });

  describe('unregister', () => {
    it('removes instance and emits disconnected', () => {
      const inst = mgr.register({ id: 'rm-me' });
      let emitted = null;
      mgr.on('instance:disconnected', (i) => { emitted = i; });
      mgr.unregister('rm-me');
      assert.equal(mgr.get('rm-me'), undefined);
      assert.equal(emitted.id, 'rm-me');
      assert.equal(emitted.status, 'disconnected');
    });

    it('no-ops for unknown id', () => {
      mgr.unregister('nonexistent'); // should not throw
    });
  });

  describe('getAll', () => {
    it('returns sanitized list without agentSocket', () => {
      mgr.register({ id: 'a', name: 'A' });
      mgr.register({ id: 'b', name: 'B' });
      const all = mgr.getAll();
      assert.equal(all.length, 2);
      assert.ok(!('agentSocket' in all[0]));
      assert.ok(!('conversation' in all[0]));
      assert.equal(all[0].conversationLength, 0);
    });
  });

  describe('updateStatus', () => {
    it('updates status and emits event', () => {
      mgr.register({ id: 's1' });
      let emitted = null;
      mgr.on('instance:status', (e) => { emitted = e; });
      mgr.updateStatus('s1', 'busy');
      assert.equal(mgr.get('s1').status, 'busy');
      assert.deepEqual(emitted, { id: 's1', status: 'busy' });
    });

    it('no-ops for unknown id', () => {
      mgr.updateStatus('nope', 'busy'); // should not throw
    });
  });

  describe('addMessage', () => {
    it('adds message with timestamp', () => {
      mgr.register({ id: 'm1' });
      mgr.addMessage('m1', { role: 'user', content: 'hello' });
      const conv = mgr.getConversation('m1');
      assert.equal(conv.length, 1);
      assert.equal(conv[0].role, 'user');
      assert.equal(conv[0].content, 'hello');
      assert.ok(conv[0].timestamp);
    });

    it('emits instance:message event', () => {
      mgr.register({ id: 'm2' });
      let emitted = null;
      mgr.on('instance:message', (e) => { emitted = e; });
      mgr.addMessage('m2', { role: 'assistant', content: 'hi' });
      assert.equal(emitted.id, 'm2');
      assert.equal(emitted.message.role, 'assistant');
    });

    it('caps conversation at 200 messages', () => {
      mgr.register({ id: 'cap' });
      for (let i = 0; i < 210; i++) {
        mgr.addMessage('cap', { content: `msg-${i}` });
      }
      const conv = mgr.getConversation('cap', 999);
      assert.equal(conv.length, 200);
      assert.equal(conv[0].content, 'msg-10');
    });
  });

  describe('getConversation', () => {
    it('returns last N messages', () => {
      mgr.register({ id: 'gc' });
      for (let i = 0; i < 10; i++) {
        mgr.addMessage('gc', { content: `msg-${i}` });
      }
      const last3 = mgr.getConversation('gc', 3);
      assert.equal(last3.length, 3);
      assert.equal(last3[0].content, 'msg-7');
    });

    it('returns empty array for unknown id', () => {
      assert.deepEqual(mgr.getConversation('nope'), []);
    });
  });

  describe('pendingApproval', () => {
    it('sets approval and moves to waiting status', () => {
      mgr.register({ id: 'ap' });
      let emitted = null;
      mgr.on('instance:approval', (e) => { emitted = e; });
      const approval = { tool: 'Bash', command: 'rm -rf /' };
      mgr.setPendingApproval('ap', approval);

      assert.equal(mgr.get('ap').status, 'waiting');
      assert.deepEqual(mgr.get('ap').pendingApproval, approval);
      assert.deepEqual(emitted.approval, approval);
    });

    it('clears approval and moves to busy', () => {
      mgr.register({ id: 'cl' });
      mgr.setPendingApproval('cl', { tool: 'X' });

      let emitted = null;
      mgr.on('instance:approval', (e) => { emitted = e; });
      mgr.clearPendingApproval('cl');

      assert.equal(mgr.get('cl').pendingApproval, null);
      assert.equal(mgr.get('cl').status, 'busy');
      assert.equal(emitted.approval, null);
    });

    it('clearPendingApproval does not change status if not waiting', () => {
      mgr.register({ id: 'ns' });
      mgr.updateStatus('ns', 'idle');
      mgr.clearPendingApproval('ns');
      assert.equal(mgr.get('ns').status, 'idle');
    });
  });

  describe('autoApprove', () => {
    it('sets autoApprove and emits event', () => {
      mgr.register({ id: 'aa' });
      let emitted = null;
      mgr.on('instance:autoApprove', (e) => { emitted = e; });
      mgr.setAutoApprove('aa', true);

      assert.equal(mgr.get('aa').autoApprove, true);
      assert.deepEqual(emitted, { id: 'aa', autoApprove: true });
    });

    it('toggles off', () => {
      mgr.register({ id: 'aa2' });
      mgr.setAutoApprove('aa2', true);
      mgr.setAutoApprove('aa2', false);
      assert.equal(mgr.get('aa2').autoApprove, false);
    });

    it('coerces truthy values to boolean', () => {
      mgr.register({ id: 'aa3' });
      mgr.setAutoApprove('aa3', 1);
      assert.equal(mgr.get('aa3').autoApprove, true);
      mgr.setAutoApprove('aa3', 0);
      assert.equal(mgr.get('aa3').autoApprove, false);
    });
  });

  describe('sendToAgent', () => {
    it('returns false when no socket', () => {
      mgr.register({ id: 'no-sock' });
      assert.equal(mgr.sendToAgent('no-sock', { type: 'test' }), false);
    });

    it('sends JSON to open socket', () => {
      mgr.register({ id: 'ws' });
      let sent = null;
      const fakeSocket = {
        readyState: 1,
        send: (data) => { sent = data; },
      };
      mgr.setAgentSocket('ws', fakeSocket);
      const result = mgr.sendToAgent('ws', { type: 'prompt', text: 'hi' });
      assert.equal(result, true);
      assert.deepEqual(JSON.parse(sent), { type: 'prompt', text: 'hi' });
    });

    it('returns false for closed socket', () => {
      mgr.register({ id: 'closed' });
      mgr.setAgentSocket('closed', { readyState: 3, send: () => {} });
      assert.equal(mgr.sendToAgent('closed', {}), false);
    });

    it('returns false for unknown instance', () => {
      assert.equal(mgr.sendToAgent('unknown', {}), false);
    });
  });
});
