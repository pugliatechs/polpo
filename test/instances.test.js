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

    it('stamps a monotonic per-instance seq on every message', () => {
      mgr.register({ id: 'seq1' });
      mgr.addMessage('seq1', { role: 'user', content: 'a' });
      mgr.addMessage('seq1', { role: 'assistant', content: 'b' });
      mgr.addMessage('seq1', { role: 'user', content: 'c' });
      const conv = mgr.getConversation('seq1');
      assert.deepEqual(conv.map((m) => m.seq), [1, 2, 3]);
    });

    it('the seq stamped on the emitted message matches the stored one', () => {
      mgr.register({ id: 'seq2' });
      const seen = [];
      mgr.on('instance:message', (e) => { seen.push(e.message.seq); });
      mgr.addMessage('seq2', { role: 'user', content: 'a' });
      mgr.addMessage('seq2', { role: 'user', content: 'b' });
      assert.deepEqual(seen, [1, 2]);
      assert.deepEqual(mgr.getConversation('seq2').map((m) => m.seq), [1, 2]);
    });

    it('seqs are independent per instance', () => {
      mgr.register({ id: 'A' });
      mgr.register({ id: 'B' });
      mgr.addMessage('A', { content: 'a1' });
      mgr.addMessage('B', { content: 'b1' });
      mgr.addMessage('A', { content: 'a2' });
      assert.deepEqual(mgr.getConversation('A').map((m) => m.seq), [1, 2]);
      assert.deepEqual(mgr.getConversation('B').map((m) => m.seq), [1]);
    });

    it('preserves clientMsgId through addMessage so the dashboard can reconcile', () => {
      mgr.register({ id: 'opt' });
      mgr.addMessage('opt', {
        role: 'user',
        content: 'hi from phone',
        source: 'mobile',
        clientMsgId: 'cmsg-abc123',
      });
      const stored = mgr.getConversation('opt');
      assert.equal(stored.length, 1);
      assert.equal(stored[0].clientMsgId, 'cmsg-abc123');
      assert.equal(stored[0].seq, 1);
    });

    it('emits the same clientMsgId on instance:message as it stores', () => {
      mgr.register({ id: 'opt2' });
      let seen = null;
      mgr.on('instance:message', (e) => { seen = e.message; });
      mgr.addMessage('opt2', {
        role: 'user',
        content: 'x',
        clientMsgId: 'cmsg-xyz',
      });
      assert.equal(seen.clientMsgId, 'cmsg-xyz');
      assert.equal(seen.seq, 1);
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
