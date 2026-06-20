'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  buildProfile,
  analyzeProfile,
  categorizeTool,
  categorizeBash,
  isGitCommit,
  analyzePrompts,
  scoreDimensions,
  pickArchetype,
  saturate,
  parseToolUse,
} = require('../src/server/profile-analyzer');

// ---- helpers to build synthetic transcript messages ----

function userMsg(text, ts) {
  return { role: 'user', content: text, timestamp: ts || null };
}
function assistantText(text, ts) {
  return { role: 'assistant', content: text, contentType: 'text', timestamp: ts || null };
}
function toolUse(name, input, ts) {
  return {
    role: 'assistant',
    content: JSON.stringify({ type: 'tool_use', name, input: input || {}, id: name + '-1' }),
    contentType: 'tool_use',
    timestamp: ts || null,
  };
}

// ---- categorizeTool ----

test('categorizeTool maps known tools to buckets', () => {
  assert.equal(categorizeTool('Edit'), 'edit');
  assert.equal(categorizeTool('Write'), 'edit');
  assert.equal(categorizeTool('MultiEdit'), 'edit');
  assert.equal(categorizeTool('apply_patch'), 'edit');
  assert.equal(categorizeTool('Read'), 'read');
  assert.equal(categorizeTool('Grep'), 'search');
  assert.equal(categorizeTool('Glob'), 'search');
  assert.equal(categorizeTool('Bash'), 'exec');
  assert.equal(categorizeTool('exec_command'), 'exec');
  assert.equal(categorizeTool('WebFetch'), 'web');
  assert.equal(categorizeTool('ExitPlanMode'), 'plan');
  assert.equal(categorizeTool('TodoWrite'), 'plan');
  assert.equal(categorizeTool('Task'), 'task');
  assert.equal(categorizeTool('mcp__server__do'), 'mcp');
  assert.equal(categorizeTool('SomethingWeird'), 'other');
  assert.equal(categorizeTool(null), 'other');
});

// ---- categorizeBash + isGitCommit ----

test('categorizeBash classifies commands by intent', () => {
  assert.equal(categorizeBash('npm test'), 'test'); // test wins over package
  assert.equal(categorizeBash('npx vitest run'), 'test');
  assert.equal(categorizeBash('git status'), 'git');
  assert.equal(categorizeBash('npm install express'), 'package');
  assert.equal(categorizeBash('node server.js'), 'run');
  assert.equal(categorizeBash('make build'), 'build');
  assert.equal(categorizeBash('ls -la'), 'fs');
  assert.equal(categorizeBash('curl https://x'), 'network');
  assert.equal(categorizeBash(''), 'other');
});

test('isGitCommit only matches commit commands', () => {
  assert.equal(isGitCommit('git commit -m "x"'), true);
  assert.equal(isGitCommit('git add -A && git commit'), true);
  assert.equal(isGitCommit('git status'), false);
  assert.equal(isGitCommit('npm commit'), false);
});

// ---- parseToolUse ----

test('parseToolUse extracts name/input, ignores non-tool messages', () => {
  assert.deepEqual(parseToolUse(toolUse('Bash', { command: 'ls' })), { name: 'Bash', input: { command: 'ls' } });
  assert.equal(parseToolUse(userMsg('hi')), null);
  assert.equal(parseToolUse(assistantText('hi')), null);
  assert.equal(parseToolUse({ contentType: 'tool_use', content: 'not json' }), null);
});

// ---- analyzePrompts ----

test('analyzePrompts computes word + style stats', () => {
  const stats = analyzePrompts([
    'How do I fix this bug?',
    'Please refactor the auth module and add tests',
    'add a `function foo()` to the user onboarding flow',
  ]);
  assert.equal(stats.count, 3);
  assert.ok(stats.avgWords > 0);
  assert.ok(stats.questionRatio > 0); // first prompt is a question
  assert.ok(stats.politeRatio > 0);   // "Please"
  assert.ok(stats.productRatio > 0);  // "user onboarding flow"
  assert.ok(stats.codeRatio > 0);     // backtick code + function
});

test('analyzePrompts handles empty input', () => {
  const stats = analyzePrompts([]);
  assert.equal(stats.count, 0);
  assert.equal(stats.avgWords, 0);
  assert.equal(stats.questionRatio, 0);
});

// ---- saturate / scoreDimensions / archetype ----

test('saturate is bounded 0..100 and monotonic', () => {
  assert.equal(saturate(0, 10), 0);
  assert.equal(saturate(-5, 10), 0);
  assert.equal(saturate(10, 10), 50); // value == midpoint => 50
  assert.ok(saturate(100, 10) > saturate(50, 10));
  assert.ok(saturate(1e6, 10) <= 100);
});

test('scoreDimensions returns five clamped scores', () => {
  const dims = scoreDimensions({
    editsPerSession: 5, execPerSession: 5, promptsPerSession: 5, avgPromptWords: 55,
    planToolsPerSession: 0.4, testsPerSession: 1, commitsPerSession: 1,
    readSearchShare: 0.5, uniqueProjects: 4, productRatio: 0.5,
  });
  for (const k of ['steering', 'execution', 'engineering', 'productInstinct', 'planning']) {
    assert.ok(k in dims, 'has ' + k);
    assert.ok(dims[k] >= 0 && dims[k] <= 100, k + ' in range');
  }
});

test('pickArchetype selects the dominant dimension', () => {
  const arch = pickArchetype({ steering: 10, execution: 90, engineering: 20, productInstinct: 5, planning: 30 });
  assert.equal(arch.key, 'execution');
  assert.equal(arch.name, 'The Shipper');
  const arch2 = pickArchetype({ steering: 10, execution: 10, engineering: 10, productInstinct: 10, planning: 95 });
  assert.equal(arch2.name, 'The Architect');
});

// ---- buildProfile (pure, end to end) ----

test('buildProfile aggregates metadata and content', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const metas = [
    { agentType: 'claude', model: 'opus', project: 'polpo', firstActivity: new Date(now - day).toISOString(), lastActivity: new Date(now - day + 3600000).toISOString(), sessionId: 's1' },
    { agentType: 'claude', model: 'sonnet', project: 'polpo', firstActivity: new Date(now - 2 * day).toISOString(), lastActivity: new Date(now - 2 * day).toISOString(), sessionId: 's2' },
    { agentType: 'codex', model: 'gpt-5', project: 'webapp', firstActivity: new Date(now - 3 * day).toISOString(), lastActivity: new Date(now - 3 * day).toISOString(), sessionId: 's3' },
  ];
  const analyzed = [
    {
      agentType: 'claude', model: 'opus', project: 'polpo',
      messages: [
        userMsg('Please add tests to the auth module'),
        assistantText('Sure'),
        toolUse('Read', { file_path: 'a.js' }),
        toolUse('Edit', { file_path: 'a.js' }),
        toolUse('Bash', { command: 'npm test' }),
        toolUse('Bash', { command: 'git commit -m "tests"' }),
      ],
    },
    {
      agentType: 'codex', model: 'gpt-5', project: 'webapp',
      messages: [
        userMsg('How should I structure the user onboarding flow?'),
        toolUse('Grep', { pattern: 'foo' }),
      ],
    },
  ];

  const p = buildProfile({ metas, analyzed, now });

  assert.equal(p.activity.totalSessions, 3);
  assert.equal(p.activity.analyzedSessions, 2);
  assert.ok(p.activity.activeDays >= 3);
  assert.equal(p.agents.find(a => a.key === 'claude').count, 2);
  assert.equal(p.models.find(m => m.key === 'opus').count, 1);
  assert.equal(p.projects.find(pr => pr.key === 'polpo').count, 2);

  assert.equal(p.tools.byCategory.edit, 1);
  assert.equal(p.tools.byCategory.read, 1);
  assert.equal(p.tools.byCategory.search, 1);
  assert.equal(p.tools.byCategory.exec, 2);
  assert.equal(p.shell.testRuns, 1);
  assert.equal(p.shell.gitCommits, 1);

  assert.equal(p.messages.userPrompts, 2);
  assert.ok(p.prompts.questionRatio > 0);

  // dimensions + archetype present and valid
  assert.ok(p.archetype && p.archetype.name);
  for (const k of ['steering', 'execution', 'engineering', 'productInstinct', 'planning']) {
    assert.ok(p.dimensions[k] >= 0 && p.dimensions[k] <= 100);
  }
});

test('buildProfile tolerates empty input', () => {
  const p = buildProfile({ metas: [], analyzed: [], now: 1700000000000 });
  assert.equal(p.activity.totalSessions, 0);
  assert.equal(p.activity.peakHour, null);
  assert.equal(p.activity.peakDay, null);
  assert.ok(p.archetype && p.archetype.name);
});

// ---- analyzeProfile IO layer with injected deps ----

test('analyzeProfile wires scan + load via injected deps', async () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const fakeMetas = [
    { agentType: 'claude', model: 'opus', project: 'polpo', sessionId: 's1',
      firstActivity: new Date(now - 86400000).toISOString(), lastActivity: new Date(now - 86400000).toISOString() },
  ];
  const deps = {
    now,
    scanSessions: async (opts) => {
      assert.equal(opts.source, 'all');
      assert.ok(opts.maxAge > 0);
      return fakeMetas;
    },
    loadHistory: async (id) => {
      assert.equal(id, 's1');
      return [userMsg('do the thing'), toolUse('Edit', { file_path: 'x' })];
    },
  };
  const p = await analyzeProfile({ days: 30, _deps: deps });
  assert.equal(p.activity.totalSessions, 1);
  assert.equal(p.activity.analyzedSessions, 1);
  assert.equal(p.tools.byCategory.edit, 1);
  assert.equal(p.window.days, 30);
  assert.equal(p.window.source, 'all');
});

test('analyzeProfile respects the content deadline', async () => {
  // deadlineMs:0 means the content pass should load nothing, but metadata
  // aggregates still populate.
  const now = Date.now();
  const metas = Array.from({ length: 5 }, (_, i) => ({
    agentType: 'claude', model: 'opus', project: 'p', sessionId: 's' + i,
    firstActivity: new Date(now - i * 86400000).toISOString(),
    lastActivity: new Date(now - i * 86400000).toISOString(),
  }));
  let loadCalls = 0;
  const deps = {
    now,
    scanSessions: async () => metas,
    loadHistory: async () => { loadCalls++; return []; },
  };
  const p = await analyzeProfile({ days: 30, deadlineMs: 0, _deps: deps });
  assert.equal(loadCalls, 0, 'no histories loaded past the deadline');
  assert.equal(p.activity.totalSessions, 5);
  assert.equal(p.activity.analyzedSessions, 0);
});
