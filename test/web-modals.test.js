const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/**
 * Structural guard for dashboard modals.
 *
 * `.hidden` only undoes `display: none`. It is `.visible` that supplies
 * the backdrop, clears the sheet's `translateY(100%)` and restores
 * `pointer-events`. A modal opened by removing `hidden` alone renders
 * translated off the bottom of the viewport with no backdrop, and since
 * the overlay keeps `pointer-events: none` (which descendants inherit)
 * neither its close button nor the backdrop can be clicked.
 *
 * That has shipped twice now: the model picker, then the Builder
 * Profile explainer. app.js is browser code with no DOM harness here,
 * so this asserts the invariant against the source instead of adding a
 * jsdom dependency for it.
 */
const WEB = path.join(__dirname, '..', 'src', 'web');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8');

function modalIds() {
  const ids = new Set();
  const a = /id="([^"]+)"\s+class="modal-overlay/g;
  const b = /class="modal-overlay[^"]*"\s+id="([^"]+)"/g;
  let m;
  while ((m = a.exec(html))) ids.add(m[1]);
  while ((m = b.exec(html))) ids.add(m[1]);
  return [...ids].sort();
}

function bindingFor(id) {
  const re = new RegExp(
    '(?:var|const|let)\\s+(\\$?\\w+)\\s*=\\s*document\\.getElementById\\([\'"]' +
      id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]\\)'
  );
  const m = js.match(re);
  return m ? m[1] : null;
}

function countCalls(varName, call) {
  const re = new RegExp(
    varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.classList\\.' + call
  );
  return re.test(js);
}

describe('dashboard modals', () => {
  it('finds the modal overlays in the markup', () => {
    const ids = modalIds();
    assert.ok(ids.length >= 8, 'expected the dashboard modals, got ' + ids.length);
    assert.ok(ids.includes('profile-about-modal'));
    assert.ok(ids.includes('model-picker-modal'));
  });

  it('confirms .visible is what actually reveals a modal', () => {
    // If this ever stops being true the guard below is meaningless, so
    // assert the CSS contract the test depends on.
    assert.match(css, /\.modal-overlay\s*\{[^}]*pointer-events:\s*none/);
    assert.match(css, /\.modal-overlay\.visible\s*\{[^}]*pointer-events:\s*auto/);
    assert.match(css, /\.modal-overlay\.visible\s+\.modal-content\s*\{[^}]*transform:\s*translateY\(0\)/);
  });

  for (const id of modalIds()) {
    it(`${id} is opened with .visible, not just by removing .hidden`, () => {
      const varName = bindingFor(id);
      assert.ok(varName, `no getElementById binding found for ${id}`);

      const removesHidden = countCalls(varName, "remove\\('hidden'\\)");
      const addsVisible = countCalls(varName, "add\\('visible'\\)");

      if (removesHidden) {
        assert.ok(
          addsVisible,
          `${id} removes .hidden but never adds .visible, so it opens ` +
            'off-screen with no backdrop and cannot be dismissed'
        );
      }
    });

    it(`${id} is closed by removing .visible before re-hiding`, () => {
      const varName = bindingFor(id);
      assert.ok(varName);
      if (countCalls(varName, "add\\('visible'\\)")) {
        assert.ok(
          countCalls(varName, "remove\\('visible'\\)"),
          `${id} adds .visible but never removes it, so it cannot close`
        );
      }
    });
  }
});
