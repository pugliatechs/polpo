const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/**
 * The Mobile Setup panel must follow tunnel rotations.
 *
 * A rotation is announced with a tunnel:changed broadcast, which only
 * reaches tabs connected at that moment. A tab whose WebSocket was down
 * when it happened kept showing the old tunnel QR until a full reload,
 * while the log already printed the new one. app.js is browser code
 * with no DOM harness here, so these pin the wiring in the source.
 */
const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'app.js'), 'utf8');

function block(startMarker, length) {
  const i = js.indexOf(startMarker);
  assert.ok(i !== -1, 'missing: ' + startMarker);
  return js.slice(i, i + (length || 600));
}

describe('tunnel QR stays current', () => {
  it('reloads the QR codes when a rotation is announced', () => {
    assert.match(block("case 'tunnel:changed':", 500), /loadQrCodes\(\)/);
  });

  it('reloads them when the tunnel goes down, so the dead URL is not shown', () => {
    assert.match(block("case 'tunnel:down':", 600), /loadQrCodes\(\)/);
  });

  it('re-syncs them after a reconnect, for rotations it missed while away', () => {
    const onopen = block('ws.onopen = function () {', 700);
    assert.match(onopen, /var isReconnect = wasConnected;/);
    assert.match(onopen, /if \(isReconnect\) loadQrCodes\(\);/);
    assert.ok(
      onopen.indexOf('var isReconnect = wasConnected;') < onopen.indexOf('wasConnected = true;'),
      'must read wasConnected before overwriting it, or every connect looks like a reconnect'
    );
  });
});
