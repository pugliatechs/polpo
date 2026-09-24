const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { WrappedAgent } = require('../src/agent/wrapped');
const { CodexAgent } = require('../src/agent/codex-agent');
const { GeminiAgent } = require('../src/agent/gemini-agent');
const { OpencodeAgent } = require('../src/agent/opencode-agent');
const { PiAgent } = require('../src/agent/pi-agent');
const { GooseAgent } = require('../src/agent/goose-agent');

/**
 * Every agent must carry its origin tag INTO registration.
 *
 * The tag ('mind:<goal>', 'gateway:<client>', 'mind-reasoner') decides
 * whether an instance is shown as a session, counted in /health, and
 * offered to the planner as an arm. instanceManager.register() emits
 * instance:registered synchronously, so a source applied after the fact
 * is invisible to every listener of that event: the dashboard adds the
 * card before the tag exists and never removes it.
 *
 * That is exactly how the mind's own reasoner appeared in the sidebar
 * as a live session despite being filtered in getAll() and in the
 * broadcast guard. The runner still patches the instance afterwards as
 * a fallback, but the tag has to be in the POST body to be useful.
 */
const AGENTS = [
  ['WrappedAgent', WrappedAgent],
  ['CodexAgent', CodexAgent],
  ['GeminiAgent', GeminiAgent],
  ['OpencodeAgent', OpencodeAgent],
  ['PiAgent', PiAgent],
  ['GooseAgent', GooseAgent],
];

describe('agent registration carries the origin tag', () => {
  for (const [name, Agent] of AGENTS) {
    it(`${name} stores the source it was constructed with`, () => {
      const a = new Agent({ cwd: '/tmp', source: 'mind-reasoner' });
      assert.equal(a.source, 'mind-reasoner');
    });

    it(`${name} defaults source to null, not undefined`, () => {
      // register() serializes the body with JSON.stringify, which drops
      // undefined keys entirely. null survives and reads as "no tag".
      const a = new Agent({ cwd: '/tmp' });
      assert.equal(a.source, null);
    });
  }

  it('every agent sends source in its registration body', () => {
    // The bodies are hand-rolled per agent rather than shared, so this
    // checks the source line is actually present in each one.
    const dir = path.join(__dirname, '..', 'src', 'agent');
    const files = [
      'wrapped.js', 'codex-agent.js', 'gemini-agent.js',
      'opencode-agent.js', 'pi-agent.js', 'goose-agent.js', 'index.js',
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.match(
        src, /source: this\.source/,
        `${f} must send source in its registration body`
      );
    }
  });

  it('a tagged registration body round-trips through JSON', () => {
    const a = new WrappedAgent({ cwd: '/tmp', name: 'Mind reasoner', source: 'mind-reasoner' });
    const body = JSON.parse(JSON.stringify({
      name: a.name, type: a.type, project: a.project, cwd: a.cwd, source: a.source,
    }));
    assert.equal(body.source, 'mind-reasoner');
  });

  it('an untagged agent registers with an explicit null source', () => {
    const a = new WrappedAgent({ cwd: '/tmp' });
    const body = JSON.parse(JSON.stringify({ cwd: a.cwd, source: a.source }));
    assert.ok('source' in body);
    assert.equal(body.source, null);
  });
});
