const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/**
 * A message in the dashboard shows its time; one from another day shows
 * the day too, or a session opened days later reads as if it all
 * happened today.
 */
const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'app.js'), 'utf8');
const start = js.indexOf('  function formatTime(');
const src = js.slice(start, js.indexOf('\n  }\n', start) + 4);
// eslint-disable-next-line no-new-func
const formatTime = new Function(src + '\nreturn formatTime;')();

describe('dashboard message time', () => {
  const now = new Date(2026, 10, 8, 15, 0).getTime();

  it('is the time alone for a message from today', () => {
    assert.equal(formatTime(new Date(2026, 10, 8, 9, 5).getTime(), now), '09:05');
  });

  it('carries the day for a message from another day', () => {
    const out = formatTime(new Date(2026, 10, 1, 10, 45).getTime(), now);
    assert.match(out, /10:45$/);
    assert.match(out, /1/);
    assert.notEqual(out, '10:45');
    assert.ok(!/2026/.test(out), 'no year within the current one');
  });

  it('carries the year for a message from another year', () => {
    assert.match(formatTime(new Date(2025, 11, 31, 23, 59).getTime(), now), /2025.*23:59$/);
  });

  it('shows nothing for a timestamp it cannot read', () => {
    assert.equal(formatTime('not a date', now), '');
  });

  it('shows the full date on hover', () => {
    assert.match(js, /class="msg-time" title="' \+ escapeAttr\(new Date\(m\.timestamp\)\.toLocaleString\(\)\)/);
  });
});
