const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/**
 * Attribute-escaping contract for the dashboard.
 *
 * escapeHtml() serializes a text node. The HTML fragment serialization
 * algorithm escapes only &, U+00A0, < and > in text content: quotes are
 * left alone, because they are not special there. Interpolating its
 * result into a quoted attribute therefore lets the first quote in the
 * value close the attribute early, and the remainder is reparsed as
 * markup.
 *
 * That is not hypothetical. It silently broke the mind's inline action
 * buttons: the actions list is JSON in a data-* attribute, its very
 * first quote ended the attribute, JSON.parse received "{" and the
 * delegated click handler bailed out, so Approve / Tweak / Abandon did
 * nothing at all. Several other sites interpolate values nobody
 * authored by hand (file paths from git, uploaded filenames, package
 * names from a remote skill search), where the same gap is an
 * injection vector rather than a dead button.
 */
const APP = path.join(__dirname, '..', 'src', 'web', 'app.js');
const js = fs.readFileSync(APP, 'utf8');

// The idiom used throughout this file to open an attribute and splice a
// value in: `foo="' + fn(value) + '"`. Precise enough not to match
// legitimate text-content escaping like `'<span>' + escapeHtml(x)`.
const ATTR_ESCAPE_HTML = /=\\?"'\s*\+\s*escapeHtml\(/g;

describe('dashboard HTML escaping', () => {
  it('provides a distinct attribute escaper', () => {
    assert.match(js, /function escapeAttr\(/);
  });

  it('escapeAttr escapes both quote characters', () => {
    const body = js.slice(js.indexOf('function escapeAttr('));
    const fn = body.slice(0, body.indexOf('\n  }\n'));
    assert.match(fn, /&quot;/, 'must escape the double quote');
    assert.match(fn, /&#39;/, 'must escape the single quote');
    assert.match(fn, /escapeHtml\(/, 'must still escape &, < and >');
  });

  it('never uses the text escaper to fill an attribute', () => {
    const hits = js.match(ATTR_ESCAPE_HTML) || [];
    assert.equal(
      hits.length, 0,
      'escapeHtml() does not escape quotes; use escapeAttr() in attributes'
    );
  });

  it('builds the mind action list with the attribute escaper', () => {
    // This is the one that broke the buttons.
    const i = js.indexOf('data-msg-actions="');
    assert.ok(i !== -1, 'action rows must carry their actions');
    const near = js.slice(i, i + 200);
    assert.match(near, /escapeAttr\(JSON\.stringify/);
    assert.ok(!/escapeHtml\(JSON\.stringify/.test(near));
  });

  it('keeps escapeHtml for text content', () => {
    // The two must not be collapsed into one: over-escaping quotes in
    // text content would render &quot; visibly to the user.
    assert.match(js, /'<span>'\s*\+\s*escapeHtml\(/);
  });
});
