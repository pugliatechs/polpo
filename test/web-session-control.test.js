const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/**
 * The dashboard side of "one writer at a time". app.js is browser code
 * with no DOM harness here, so these pin the wiring in the source.
 */
const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'app.js'), 'utf8');

function block(marker, length) {
  const i = js.indexOf(marker);
  assert.ok(i !== -1, 'missing: ' + marker);
  return js.slice(i, i + (length || 900));
}

describe('dashboard: who drives a session', () => {
  it('follows takeovers and handbacks as they happen', () => {
    const b = block("case 'instance:control':");
    assert.match(b, /canReceivePrompts = msg\.canReceivePrompts/);
    assert.match(b, /heldBy = msg\.heldBy/);
    assert.match(b, /renderDetail\(\)/, 'swaps prompt box and takeover banner on the open session');
  });

  it('marks a refused prompt failed straight away', () => {
    const b = block("case 'prompt_refused':", 1200);
    assert.match(b, /clearOptimisticTimeout\(msg\.clientMsgId\)/);
    assert.match(b, /markBubbleFailed\(msg\.clientMsgId\)/);
  });

  it('blocks takeover while the agent is busy or waiting for an approval', () => {
    const b = block('var canPrompt = inst.canReceivePrompts !== false;', 1400);
    assert.match(b, /inst\.status === 'busy' \|\| inst\.status === 'waiting'/);
    assert.match(b, /Wait until it is idle/);
  });

  it('no longer assumes a watched session lives in a terminal', () => {
    assert.ok(!js.includes('This session is running in your terminal.'));
    assert.ok(!js.includes('This session is busy in your terminal.'));
  });

  it('shows which external agent holds a session', () => {
    assert.match(js, /inst\.heldBy\.indexOf\('gateway:'\) === 0/);
  });
});
