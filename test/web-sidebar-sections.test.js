const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/**
 * Sidebar section contract.
 *
 * The sidebar has three groups, and each must be labelled and must
 * collapse when empty. The live non-mind block used to render with no
 * header at all, wedged between Distributed Mind and Recent Sessions,
 * so nothing told the reader that those are running right now while
 * the ones below are history read off disk.
 */
const WEB = path.join(__dirname, '..', 'src', 'web');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');

const SECTIONS = [
  ['mind-section', 'Distributed Mind'],
  ['active-section', 'Active Sessions'],
  ['sessions-section', 'Recent Sessions'],
];

describe('sidebar sections', () => {
  for (const [id, title] of SECTIONS) {
    it(`${id} exists and is labelled "${title}"`, () => {
      const i = html.indexOf(`id="${id}"`);
      assert.ok(i !== -1, `missing #${id}`);
      const block = html.slice(i, i + 400);
      assert.ok(block.includes(title), `#${id} must carry its heading`);
    });

    it(`${id} starts hidden so it can collapse when empty`, () => {
      const re = new RegExp(`id="${id}"[^>]*class="[^"]*hidden`);
      assert.match(html, re);
    });
  }

  it('the active list lives inside the labelled section', () => {
    const i = html.indexOf('id="active-section"');
    const j = html.indexOf('id="instance-list"');
    const end = html.indexOf('</div>', j);
    assert.ok(i !== -1 && j > i, 'instance-list must be inside active-section');
    assert.ok(end !== -1);
  });

  it('active-section is toggled by how many live instances there are', () => {
    const i = js.indexOf("getElementById('active-section')");
    assert.ok(i !== -1, 'render must toggle the section');
    const near = js.slice(i, i + 320);
    assert.match(near, /regular\.length > 0/);
    assert.match(near, /classList\.remove\('hidden'\)/);
    assert.match(near, /classList\.add\('hidden'\)/);
  });

  it('the three sections appear in order down the sidebar', () => {
    const positions = SECTIONS.map(([id]) => html.indexOf(`id="${id}"`));
    const sorted = [...positions].sort((a, b) => a - b);
    assert.deepEqual(positions, sorted, 'mind, then active, then recent');
  });
});
