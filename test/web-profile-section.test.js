const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/**
 * Contract for the Builder Profile section.
 *
 * The analysis takes tens of seconds over a large session history. The
 * section used to stay hidden until the response landed, so on desktop
 * it materialised out of nowhere long after the page had settled, and a
 * failure left it hidden forever with no sign anything was attempted.
 *
 * app.js is browser code with no DOM harness here, so these pin the
 * pieces that make the section appear immediately with a status line.
 */
const WEB = path.join(__dirname, '..', 'src', 'web');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8');

describe('Builder Profile section', () => {
  it('has a status line inside the card', () => {
    assert.match(html, /id="profile-status"/);
  });

  it('starts the card in its loading state', () => {
    // So the very first paint shows the status line, not a card full of
    // empty placeholders.
    assert.match(html, /class="profile-card is-loading"/);
  });

  it('hides the card contents while loading, and the status line once loaded', () => {
    assert.match(css, /\.profile-card\.is-loading\s*>\s*\*:not\(#profile-status\)\s*\{[^}]*display:\s*none/);
    assert.match(css, /\.profile-card:not\(\.is-loading\)\s*>\s*#profile-status\s*\{[^}]*display:\s*none/);
  });

  it('reveals the section before awaiting the request, not after', () => {
    const fn = js.slice(js.indexOf('function loadProfile()'));
    const body = fn.slice(0, fn.indexOf('\n  }\n'));
    const reveal = body.indexOf("$profileSection.classList.remove('hidden')");
    const fetchAt = body.indexOf("authFetch('/api/profile");
    assert.ok(reveal !== -1, 'loadProfile must reveal the section');
    assert.ok(fetchAt !== -1, 'loadProfile must request the profile');
    assert.ok(
      reveal < fetchAt,
      'the section must be revealed before the request, otherwise it pops in tens of seconds late'
    );
  });

  it('tells the user something is happening', () => {
    assert.match(js, /Analyzing your sessions/);
  });

  it('surfaces a failure instead of leaving an empty space', () => {
    const fn = js.slice(js.indexOf('function loadProfile()'));
    const body = fn.slice(0, fn.indexOf('\n  }\n'));
    assert.match(body, /Could not load your profile/);
  });

  it('honours the stale marker the server sets', () => {
    assert.match(js, /X-Profile-Stale/);
  });
});
