/**
 * Builder Profile analyzer — a Paxel-style "how you work with AI agents"
 * report, computed entirely on this machine.
 *
 * Inspired by YC's Paxel experiment, but with Polpo's privacy posture:
 * nothing leaves the host, no LLM calls, no new dependencies. It simply
 * reuses the transcript infrastructure Polpo already has (scanSessions +
 * loadHistory, which normalize Claude / Codex / Gemini / Pi / OpenCode /
 * Goose sessions into a uniform message shape) and derives statistics
 * from it.
 *
 * The module is split into two layers so the interesting logic is unit
 * testable without touching the filesystem:
 *
 *   analyzeProfile(opts)          IO layer — scans the session stores,
 *                                 loads a bounded sample of recent
 *                                 histories (deadline-guarded), then
 *                                 delegates to buildProfile().
 *
 *   buildProfile({ metas,         PURE — given session metadata + loaded
 *                  analyzed,      histories, computes the whole profile
 *                  now })         object. No IO, no clock (now injectable).
 *
 * The five dimension scores (steering / execution / engineering /
 * productInstinct / planning) and the archetype are deliberately
 * heuristic and opinionated — they are a mirror, not a verdict. Every
 * heuristic is documented inline so it can be tuned with intent.
 */

const { scanSessions, loadHistory } = require('./sessions');
const { normalizeTimestamp } = require('./normalize-timestamp');

const DAY_MS = 24 * 60 * 60 * 1000;

// IO bounds. The metadata pass is cheap (head/tail reads), so we let it
// cover the whole window. The content pass calls loadHistory per session,
// which is heavier, so it is capped and deadline-guarded — and the cap is
// reported back (analyzedSessions vs totalSessions), never silent.
const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 365;
const DEFAULT_MAX_ANALYZED = 200;
const DEFAULT_DEADLINE_MS = 15_000;
const META_SCAN_LIMIT = 10_000;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---- Tool categorization -----------------------------------------------

// Map a tool name (across all agents) to a coarse capability bucket. Names
// are matched case-insensitively; unknown names fall through to 'other'.
function categorizeTool(name) {
  if (!name || typeof name !== 'string') return 'other';
  const n = name.toLowerCase();
  if (n.startsWith('mcp__')) return 'mcp';
  // 'plan' is checked BEFORE 'edit' because TodoWrite contains "write" and
  // would otherwise be miscategorised as edit. ExitPlanMode is fine either
  // way; keeping them together is the simpler invariant to maintain.
  if (/(exitplanmode|todowrite|^plan$)/.test(n)) return 'plan';
  if (/(edit|write|str_replace|apply_patch|create_file|notebookedit)/.test(n)) return 'edit';
  if (/(^read$|notebookread|cat_file|view)/.test(n)) return 'read';
  if (/(grep|glob|^ls$|search|find|ripgrep)/.test(n)) return 'search';
  if (/(bash|shell|exec|run_command|terminal)/.test(n)) return 'exec';
  if (/(webfetch|websearch|fetch|browse)/.test(n)) return 'web';
  if (/(^task$|agent|dispatch)/.test(n)) return 'task';
  return 'other';
}

// Categorize a shell command by its intent. Looks at the leading token and
// a few well-known patterns. Returns a category string.
function categorizeBash(command) {
  if (!command || typeof command !== 'string') return 'other';
  const cmd = command.trim().toLowerCase();
  if (!cmd) return 'other';
  // Test runners — checked before generic package managers so "npm test"
  // counts as a test, not a package op.
  if (/\b(test|jest|vitest|pytest|mocha|go test|cargo test|rspec|phpunit|--test)\b/.test(cmd)) return 'test';
  if (/^git\b/.test(cmd)) return 'git';
  if (/^(npm|yarn|pnpm|bun|pip|pip3|poetry|cargo|go|gem|bundle|composer|apt|brew)\b/.test(cmd)) return 'package';
  if (/^(node|python3?|ruby|deno|ts-node|php)\b/.test(cmd)) return 'run';
  if (/\b(build|make|tsc|webpack|vite build|cargo build|go build|docker build)\b/.test(cmd)) return 'build';
  if (/^(ls|cat|cd|pwd|mkdir|rm|cp|mv|touch|head|tail|find|tree|echo|chmod|which)\b/.test(cmd)) return 'fs';
  if (/^(curl|wget|ssh|scp|nc|ping)\b/.test(cmd)) return 'network';
  return 'other';
}

// Is this a `git commit`? (counts shipping cadence)
function isGitCommit(command) {
  return typeof command === 'string' && /^git\b[\s\S]*\bcommit\b/.test(command.trim());
}

// ---- Prompt analysis ---------------------------------------------------

const PRODUCT_WORDS = /\b(user|users|customer|product|ui|ux|design|flow|onboarding|feature|experience|usability|accessib|conversion|landing|signup|checkout)\b/i;
const POLITE_WORDS = /\b(please|thanks|thank you|could you|would you|appreciate)\b/i;
const QUESTION_WORDS = /^(how|what|why|when|where|which|who|can|could|should|is|are|do|does|did|will|would)\b/i;

function wordCount(str) {
  if (!str) return 0;
  const m = str.trim().match(/\S+/g);
  return m ? m.length : 0;
}

function median(nums) {
  if (!nums.length) return 0;
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Compute prompt-style stats from an array of user prompt strings.
 */
function analyzePrompts(prompts) {
  const words = prompts.map(wordCount);
  const total = prompts.length;
  let questions = 0, codeBlocks = 0, polite = 0, product = 0;
  for (const p of prompts) {
    const t = (p || '').trim();
    if (t.endsWith('?') || QUESTION_WORDS.test(t)) questions++;
    if (t.includes('```') || /\b(function|const|class|def |import |=>)\b/.test(t)) codeBlocks++;
    if (POLITE_WORDS.test(t)) polite++;
    if (PRODUCT_WORDS.test(t)) product++;
  }
  return {
    count: total,
    avgWords: total ? Math.round(words.reduce((a, b) => a + b, 0) / total) : 0,
    medianWords: median(words),
    longestWords: words.length ? Math.max(...words) : 0,
    questionRatio: total ? questions / total : 0,
    codeRatio: total ? codeBlocks / total : 0,
    politeRatio: total ? polite / total : 0,
    productRatio: total ? product / total : 0,
  };
}

// ---- Scoring helpers ---------------------------------------------------

// Saturating 0..100 score: value/(value+midpoint)*100. At value==midpoint
// you score 50; it asymptotes toward 100 and never exceeds it. This keeps
// heavy users from blowing the scale while still rewarding more activity.
function saturate(value, midpoint) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const m = midpoint > 0 ? midpoint : 1;
  return Math.round((value / (value + m)) * 100);
}

function clamp100(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Archetype table keyed by the dominant dimension.
const ARCHETYPES = {
  planning: { name: 'The Architect', blurb: 'You think before you build — plans, structure, and intent come first.' },
  execution: { name: 'The Shipper', blurb: 'You move fast and produce a lot. Hands on the keyboard, things get built.' },
  engineering: { name: 'The Craftsperson', blurb: 'You value rigor: reading code, running tests, and clean commits.' },
  steering: { name: 'The Director', blurb: 'You guide the agent turn by turn, steering closely toward the goal.' },
  productInstinct: { name: 'The Visionary', blurb: 'You range across products and keep the user in frame.' },
};

function pickArchetype(scores) {
  const entries = Object.entries(scores);
  entries.sort((a, b) => b[1] - a[1]);
  const top = entries[0] || ['execution', 0];
  const arch = ARCHETYPES[top[0]] || ARCHETYPES.execution;
  return { key: top[0], name: arch.name, blurb: arch.blurb, dimension: top[0] };
}

/**
 * Derive the five 0..100 dimension scores from aggregated rates.
 * All inputs are per-session or ratio rates so the scores are
 * intensity-of-style, not raw volume.
 */
function scoreDimensions(rates) {
  const {
    editsPerSession, execPerSession, promptsPerSession, avgPromptWords,
    planToolsPerSession, testsPerSession, commitsPerSession,
    readSearchShare, uniqueProjects, productRatio,
  } = rates;

  // Execution — hands-on output volume per session (edits + shell runs).
  const execution = saturate(editsPerSession + execPerSession, 14);

  // Engineering — rigor signals: tests run, commits made, and how much of
  // the tool mix is reading/searching vs blind editing.
  const engineering = clamp100(
    saturate(testsPerSession, 1) * 0.35 +
    saturate(commitsPerSession, 1) * 0.30 +
    readSearchShare * 100 * 0.35
  );

  // Planning — explicit planning tools + how structured/verbose prompts are.
  const planning = clamp100(
    saturate(planToolsPerSession, 0.4) * 0.6 +
    saturate(avgPromptWords, 55) * 0.4
  );

  // Steering — multi-turn density: more prompts per session means closer,
  // more iterative guidance of the agent.
  const steering = saturate(promptsPerSession, 5);

  // Product instinct — breadth across projects + product/user vocabulary.
  const productInstinct = clamp100(
    saturate(uniqueProjects, 4) * 0.5 +
    productRatio * 100 * 0.5
  );

  return {
    steering: clamp100(steering),
    execution: clamp100(execution),
    engineering: clamp100(engineering),
    productInstinct: clamp100(productInstinct),
    planning: clamp100(planning),
  };
}

// ---- Pure profile builder ----------------------------------------------

/**
 * Parse a normalized message's tool_use payload (loadHistory encodes
 * tool calls as JSON strings with contentType 'tool_use').
 * Returns { name, input } or null.
 */
function parseToolUse(msg) {
  if (!msg || msg.contentType !== 'tool_use' || typeof msg.content !== 'string') return null;
  try {
    const obj = JSON.parse(msg.content);
    if (obj && obj.type === 'tool_use') return { name: obj.name || 'unknown', input: obj.input || {} };
  } catch { /* ignore */ }
  return null;
}

function topN(countMap, n) {
  return Object.entries(countMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

/**
 * @param {object} params
 * @param {Array}  params.metas     scanSessions() output (whole window)
 * @param {Array}  params.analyzed  [{ agentType, model, project, messages }]
 *                                  — the bounded content sample
 * @param {number} [params.now]     epoch ms (injectable for tests)
 */
function buildProfile({ metas = [], analyzed = [], now = Date.now() }) {
  // ---- Metadata-level aggregates (cover the whole window) ----
  const byAgent = {};
  const byModel = {};
  const byProject = {};
  const hourHist = new Array(24).fill(0);
  const dowHist = new Array(7).fill(0);
  const activeDays = new Set();
  let firstTs = 0, lastTs = 0;

  for (const m of metas) {
    if (!m) continue;
    byAgent[m.agentType || 'unknown'] = (byAgent[m.agentType || 'unknown'] || 0) + 1;
    if (m.model) byModel[m.model] = (byModel[m.model] || 0) + 1;
    const proj = m.project || (m.cwd ? m.cwd.split('/').pop() : 'unknown') || 'unknown';
    byProject[proj] = (byProject[proj] || 0) + 1;

    const startTs = normalizeTimestamp(m.firstActivity);
    const endTs = normalizeTimestamp(m.lastActivity);
    if (startTs) {
      const d = new Date(startTs);
      hourHist[d.getHours()]++;
      dowHist[d.getDay()]++;
      activeDays.add(d.toISOString().slice(0, 10));
      if (!firstTs || startTs < firstTs) firstTs = startTs;
    }
    if (endTs) {
      activeDays.add(new Date(endTs).toISOString().slice(0, 10));
      if (endTs > lastTs) lastTs = endTs;
    }
  }

  const totalSessions = metas.length;
  const numActiveDays = activeDays.size;
  const spanDays = firstTs && lastTs ? Math.max(1, Math.round((lastTs - firstTs) / DAY_MS) + 1) : (totalSessions ? 1 : 0);

  const peakHour = hourHist.some(Boolean) ? hourHist.indexOf(Math.max(...hourHist)) : null;
  const peakDow = dowHist.some(Boolean) ? dowHist.indexOf(Math.max(...dowHist)) : null;

  // ---- Content-level aggregates (the bounded sample) ----
  const prompts = [];
  const toolByName = {};
  const toolByCategory = { edit: 0, read: 0, search: 0, exec: 0, web: 0, plan: 0, task: 0, mcp: 0, other: 0 };
  const bashByCategory = {};
  let totalTools = 0, totalBash = 0, commits = 0, tests = 0;
  let assistantMessages = 0;

  for (const sess of analyzed) {
    const messages = (sess && sess.messages) || [];
    for (const msg of messages) {
      if (msg.role === 'user' && msg.contentType !== 'tool_result' && typeof msg.content === 'string'
          && !msg.content.startsWith('data:')) {
        prompts.push(msg.content);
        continue;
      }
      if (msg.role === 'assistant' && msg.contentType === 'text') {
        assistantMessages++;
        continue;
      }
      const tool = parseToolUse(msg);
      if (tool) {
        totalTools++;
        toolByName[tool.name] = (toolByName[tool.name] || 0) + 1;
        const cat = categorizeTool(tool.name);
        toolByCategory[cat] = (toolByCategory[cat] || 0) + 1;
        if (cat === 'exec') {
          const command = tool.input && (tool.input.command || tool.input.cmd);
          if (typeof command === 'string') {
            totalBash++;
            const bcat = categorizeBash(command);
            bashByCategory[bcat] = (bashByCategory[bcat] || 0) + 1;
            if (bcat === 'test') tests++;
            if (isGitCommit(command)) commits++;
          }
        }
      }
    }
  }

  const promptStats = analyzePrompts(prompts);
  const analyzedSessions = analyzed.length || 1; // avoid /0 in rates

  // Per-session rates feed the dimension model. They are computed over the
  // analyzed sample (the only sessions whose content we actually read).
  const readSearch = toolByCategory.read + toolByCategory.search;
  const rates = {
    editsPerSession: toolByCategory.edit / analyzedSessions,
    execPerSession: toolByCategory.exec / analyzedSessions,
    promptsPerSession: prompts.length / analyzedSessions,
    avgPromptWords: promptStats.avgWords,
    planToolsPerSession: toolByCategory.plan / analyzedSessions,
    testsPerSession: tests / analyzedSessions,
    commitsPerSession: commits / analyzedSessions,
    readSearchShare: totalTools ? readSearch / totalTools : 0,
    uniqueProjects: Object.keys(byProject).length,
    productRatio: promptStats.productRatio,
  };

  const dimensions = scoreDimensions(rates);
  const archetype = pickArchetype(dimensions);

  return {
    generatedAt: now,
    archetype,
    dimensions,
    activity: {
      totalSessions,
      analyzedSessions: analyzed.length,
      activeDays: numActiveDays,
      spanDays,
      sessionsPerActiveDay: numActiveDays ? Math.round((totalSessions / numActiveDays) * 10) / 10 : 0,
      firstActivity: firstTs || null,
      lastActivity: lastTs || null,
      peakHour,
      peakDay: peakDow !== null ? WEEKDAYS[peakDow] : null,
      hourHistogram: hourHist,
      dowHistogram: dowHist,
    },
    agents: topN(byAgent, 10),
    models: topN(byModel, 8),
    projects: topN(byProject, 8),
    prompts: promptStats,
    tools: {
      total: totalTools,
      byCategory: toolByCategory,
      top: topN(toolByName, 10),
    },
    shell: {
      total: totalBash,
      byCategory: bashByCategory,
      gitCommits: commits,
      testRuns: tests,
    },
    messages: {
      assistant: assistantMessages,
      userPrompts: prompts.length,
    },
  };
}

// ---- IO layer ----------------------------------------------------------

/**
 * Scan the session stores and produce a builder profile.
 *
 * @param {object} [opts]
 * @param {number} [opts.days]        analysis window (default 90, max 365)
 * @param {string} [opts.source]      'all' | 'claude' | 'codex' | ... (default 'all')
 * @param {number} [opts.maxAnalyzed] cap on histories loaded for content metrics
 * @param {number} [opts.deadlineMs]  wall-clock budget for the content pass
 * @param {object} [opts._deps]       injectable { scanSessions, loadHistory, now } for tests
 */
async function analyzeProfile(opts = {}) {
  const deps = opts._deps || {};
  const scan = deps.scanSessions || scanSessions;
  const load = deps.loadHistory || loadHistory;
  const now = deps.now || Date.now();

  const days = Math.min(Math.max(parseInt(opts.days, 10) || DEFAULT_WINDOW_DAYS, 1), MAX_WINDOW_DAYS);
  const source = opts.source || 'all';
  const maxAnalyzed = Math.min(Math.max(parseInt(opts.maxAnalyzed, 10) || DEFAULT_MAX_ANALYZED, 1), 1000);
  // deadlineMs === 0 means "the budget is already exhausted; do no
  // content loads"; default is DEFAULT_DEADLINE_MS in the future.
  const deadlineMs = (opts.deadlineMs == null) ? DEFAULT_DEADLINE_MS : opts.deadlineMs;
  const deadline = now + deadlineMs;
  // Read the clock the same way `now` was sourced so tests can pin a
  // deterministic timestamp via deps.now and still get the right
  // deadline behaviour. Production uses Date.now() because deps.now
  // is unset, so the wall clock advances naturally during the loop.
  const clock = () => (deps.now != null ? deps.now : Date.now());

  const metas = await scan({ maxAge: days * DAY_MS, source, limit: META_SCAN_LIMIT });

  // Content pass: most-recent sessions first, bounded + deadline-guarded.
  // scanSessions already returns newest-first, so just take the head.
  const analyzed = [];
  for (const meta of metas.slice(0, maxAnalyzed)) {
    // `>=` so deadlineMs:0 means "load nothing" (budget already spent),
    // matching the documented behaviour.
    if (clock() >= deadline) break;
    if (!meta || !meta.sessionId) continue;
    let messages = [];
    try { messages = await load(meta.sessionId); } catch { messages = []; }
    analyzed.push({
      agentType: meta.agentType,
      model: meta.model,
      project: meta.project,
      messages: Array.isArray(messages) ? messages : [],
    });
  }

  const profile = buildProfile({ metas, analyzed, now });
  profile.window = { days, source, truncated: metas.length > maxAnalyzed };
  return profile;
}

module.exports = {
  analyzeProfile,
  buildProfile,
  // exported for unit tests
  categorizeTool,
  categorizeBash,
  isGitCommit,
  analyzePrompts,
  scoreDimensions,
  pickArchetype,
  saturate,
  parseToolUse,
  WEEKDAYS,
};
