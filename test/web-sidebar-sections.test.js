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
  ['gateway-section', 'Gateway Sessions'],
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
    assert.deepEqual(positions, sorted, 'mind, gateway, active, then recent');
  });

  it('groups gateway tasks by their origin tag', () => {
    assert.match(js, /function gatewayClientOf\(inst\)/);
    const i = js.indexOf('function gatewayClientOf(inst)');
    const body = js.slice(i, i + 300);
    assert.match(body, /indexOf\('gateway:'\) !== 0/);
  });

  it('actually routes gateway tasks into their own group', () => {
    // The split must test the origin tag and fill the gateway group,
    // otherwise the section exists but stays empty forever.
    assert.match(js, /else if \(gatewayClientOf\(inst\)\) \{\s*gatewayGroup\.push\(inst\);/);
  });

  it('gateway-section is toggled by how many gateway tasks there are', () => {
    const i = js.indexOf("getElementById('gateway-section')");
    assert.ok(i !== -1);
    const near = js.slice(i, i + 400);
    assert.match(near, /gatewayGroup\.length > 0/);
    assert.match(near, /classList\.remove\('hidden'\)/);
  });

  it('wires clicks and pins on gateway cards too', () => {
    assert.match(js, /#gateway-list \.instance-card/);
    assert.match(js, /#gateway-list \.btn-pin/);
  });

  it('escapes the client label in both its text and its title', () => {
    const i = js.indexOf('class="client-badge"');
    assert.ok(i !== -1, 'gateway cards show their client');
    const near = js.slice(i, i + 220);
    assert.match(near, /escapeAttr\(gatewayClient\)/);
    assert.match(near, /escapeHtml\(gatewayClient\)/);
  });
});
