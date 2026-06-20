/**
 * Session scanner — discovers sessions from Claude Code, Codex, Gemini, OpenCode, and Pi.
 *
 * Claude sessions:   ~/.claude/projects/<slug>/<sessionId>.jsonl
 * Codex sessions:    ~/.codex/sessions/<threadId>.jsonl
 * Gemini sessions:   ~/.gemini/tmp/<slug>/chats/session-*.json
 * OpenCode sessions: ~/.local/share/opencode/opencode.db (SQLite)
 * Pi sessions:       ~/.pi/agent/sessions/--<cwd-dashes>--/<timestamp>_<uuid>.jsonl
 *
 * Scans JSONL/JSON files to extract metadata (session ID, first prompt,
 * timestamps, model). Only reads the first/last few lines for speed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const { execFileSync } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');
const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const GEMINI_TMP_DIR = path.join(GEMINI_DIR, 'tmp');
const GEMINI_PROJECTS_FILE = path.join(GEMINI_DIR, 'projects.json');
const OPENCODE_DB = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const PI_SESSIONS_DIR = path.join(os.homedir(), '.pi', 'agent', 'sessions');

/**
 * Scan sessions from Claude Code and/or Codex and return metadata.
 * @param {object} options
 * @param {number} options.maxAge - Max age in ms to include (default: 7 days)
 * @param {number} options.limit - Max sessions to return (default: 50)
 * @param {string} options.source - 'claude' | 'codex' | 'gemini' | 'opencode' | 'pi' | 'all' (default: 'all')
 * @returns {Promise<Array>} sorted by lastActivity descending
 */
async function scanSessions(options = {}) {
  const maxAge = options.maxAge || 7 * 24 * 60 * 60 * 1000;
  const limit = options.limit || 50;
  const source = options.source || 'all';
  const cutoff = Date.now() - maxAge;

  const sessions = [];

  // Scan Claude sessions
  if (source === 'all' || source === 'claude') {
    let projectDirs;
    try {
      projectDirs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      projectDirs = [];
    }

    for (const projectSlug of projectDirs) {
      const projectPath = path.join(CLAUDE_DIR, projectSlug);
      let files;
      try {
        files = fs.readdirSync(projectPath)
          .filter(f => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = path.join(projectPath, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) continue;

          const meta = await extractMetadata(filePath);
          if (meta) {
            meta.agentType = 'claude';
            sessions.push(meta);
          }
        } catch {
          continue;
        }
      }
    }
  }

  // Scan Codex sessions (recursive — supports YYYY/MM/DD subdirs from VS Code extension)
  if (source === 'all' || source === 'codex') {
    const codexFiles = findJsonlRecursive(CODEX_DIR, cutoff);
    for (const filePath of codexFiles) {
      try {
        const meta = await extractCodexMetadata(filePath);
        if (meta) {
          meta.agentType = 'codex';
          sessions.push(meta);
        }
      } catch {
        continue;
      }
    }
  }

  // Scan Gemini sessions
  if (source === 'all' || source === 'gemini') {
    // Read projects.json for project slug → cwd mapping
    let projectMap = {};
    try {
      const projectsData = JSON.parse(fs.readFileSync(GEMINI_PROJECTS_FILE, 'utf8'));
      if (projectsData && projectsData.projects) {
        // projects.json maps cwd → slug, we need slug → cwd
        for (const [cwd, slug] of Object.entries(projectsData.projects)) {
          projectMap[slug] = cwd;
        }
      }
    } catch {
      // No projects file or parse error
    }

    // Scan each project's chats/ directory
    let slugDirs;
    try {
      slugDirs = fs.readdirSync(GEMINI_TMP_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      slugDirs = [];
    }

    for (const slug of slugDirs) {
      const chatsDir = path.join(GEMINI_TMP_DIR, slug, 'chats');
      let files;
      try {
        files = fs.readdirSync(chatsDir)
          .filter(f => f.startsWith('session-') && f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = path.join(chatsDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) continue;

          const meta = extractGeminiMetadata(filePath, projectMap[slug] || null);
          if (meta) {
            meta.agentType = 'gemini';
            sessions.push(meta);
          }
        } catch {
          continue;
        }
      }
    }
  }

  // Scan OpenCode sessions
  if (source === 'all' || source === 'opencode') {
    const opencodeSessions = scanOpencodeSessions(cutoff);
    sessions.push(...opencodeSessions);
  }

  // Scan Pi sessions
  if (source === 'all' || source === 'pi') {
    const piSessions = await scanPiSessions(cutoff);
    sessions.push(...piSessions);
  }

  sessions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
  return sessions.slice(0, limit);
}

/**
 * Extract metadata from a session JSONL file by reading
 * the first few lines (for session info + first prompt)
 * and the last few lines (for last activity timestamp).
 */
async function extractMetadata(filePath) {
  const sessionId = path.basename(filePath, '.jsonl');

  // Read first 20 lines for session info (slug appears around line 5-8)
  const headLines = await readLines(filePath, 20, 'head');
  // Read last 5 lines for last activity
  const tailLines = await readLines(filePath, 5, 'tail');

  let cwd = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let firstPrompt = null;
  let model = null;
  let slug = null;

  for (const line of headLines) {
    try {
      const obj = JSON.parse(line);

      if (obj.cwd && !cwd) cwd = obj.cwd;
      if (obj.timestamp && !firstTimestamp) firstTimestamp = obj.timestamp;
      if (obj.slug && !slug) slug = obj.slug;

      // Extract first user prompt text
      if (obj.type === 'user' && !firstPrompt) {
        const content = obj.message && obj.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && !block.text.startsWith('<')) {
              firstPrompt = block.text.slice(0, 120);
              break;
            }
          }
        }
      }

      // Extract model from assistant message
      if (obj.type === 'assistant' && obj.message && obj.message.model && !model) {
        model = obj.message.model;
      }
    } catch {
      continue;
    }
  }

  for (const line of tailLines) {
    try {
      const obj = JSON.parse(line);
      if (obj.timestamp) lastTimestamp = obj.timestamp;
    } catch {
      continue;
    }
  }

  if (!cwd || !sessionId) return null;

  return {
    sessionId,
    slug: slug || null,
    cwd,
    project: path.basename(cwd),
    firstPrompt: firstPrompt || null,
    model: model || null,
    firstActivity: firstTimestamp || null,
    lastActivity: lastTimestamp || firstTimestamp || null,
  };
}

/**
 * Read N lines from the head or tail of a file.
 */
function readLines(filePath, n, mode) {
  return new Promise((resolve) => {
    if (mode === 'tail') {
      // Read last N lines by reading the end of the file
      const stat = fs.statSync(filePath);
      const chunkSize = Math.min(stat.size, 8192);
      const buf = Buffer.alloc(chunkSize);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, chunkSize, stat.size - chunkSize);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      resolve(lines.slice(-n));
    } else {
      // Read first N lines
      const lines = [];
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream });
      rl.on('line', (line) => {
        lines.push(line);
        if (lines.length >= n) {
          rl.close();
          stream.destroy();
        }
      });
      rl.on('close', () => resolve(lines));
      stream.on('error', () => resolve(lines));
    }
  });
}

/**
 * Load conversation history from a session JSONL file.
 * Parses all messages, deduplicates streaming updates (by message.id),
 * and returns an array in the format the frontend expects.
 * Supports both Claude Code and Codex VS Code JSONL formats.
 *
 * @param {string} sessionId - The session UUID
 * @returns {Promise<Array>} conversation messages
 */
async function loadHistory(sessionId) {
  // OpenCode sessions use ses_ prefix — load from SQLite
  if (sessionId.startsWith('ses_')) {
    return loadOpencodeHistory(sessionId);
  }

  // Find the session file across all project directories
  const filePath = findSessionFile(sessionId);
  if (!filePath) return [];

  // Gemini sessions are .json files (not .jsonl)
  if (filePath.endsWith('.json')) {
    return loadGeminiHistory(filePath);
  }

  // Detect JSONL format from the first line
  const firstLines = await readLines(filePath, 1, 'head');
  let format = 'claude';
  if (firstLines.length > 0) {
    try {
      const first = JSON.parse(firstLines[0]);
      if (first.type === 'session_meta') format = 'codex';
      else if (first.type === 'session') format = 'pi';
    } catch {}
  }

  if (format === 'codex') {
    return loadCodexHistory(filePath);
  }
  if (format === 'pi') {
    return loadPiHistory(filePath);
  }

  return loadClaudeHistory(filePath);
}

/**
 * Load conversation history from a Claude Code JSONL file.
 */
// Claude Code prepends `<system-reminder>...</system-reminder>` blocks
// to user messages to inject ambient state (tool list, env, hooks). We
// don't want those rendered as "user prompts" in history. The earlier
// implementation used `!text.startsWith('<')` which also dropped any
// legitimate user text that happened to begin with an angle bracket
// (e.g. `<polpo:artifacts>` directives the mind injects, or XML the
// user typed). Be precise: only strip the specific wrapper.
function isSystemReminderText(text) {
  if (typeof text !== 'string') return false;
  return /^\s*<system-reminder\b/i.test(text);
}

function loadClaudeHistory(filePath) {
  return new Promise((resolve) => {
    const messages = [];
    const assistantMessages = new Map();

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });

    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'user' && obj.type !== 'assistant') return;

        const content = obj.message && obj.message.content;
        if (!content) return;
        const timestamp = obj.timestamp || null;

        if (obj.type === 'assistant') {
          const msgId = obj.message.id;
          if (!Array.isArray(content)) return;

          if (msgId) {
            const existing = assistantMessages.get(msgId);
            if (existing) {
              existing.blocks = existing.blocks.concat(content);
              existing.timestamp = timestamp;
            } else {
              assistantMessages.set(msgId, { blocks: [...content], timestamp });
              messages.push({ type: 'assistant', msgId, timestamp });
            }
          } else {
            messages.push({ type: 'assistant', blocks: content, timestamp });
          }
          return;
        }

        if (obj.type === 'user') {
          // Claude Code writes user messages in two shapes: a plain string
          // (the common case for typed prompts) and an array of blocks
          // (tool results, images, multi-part user messages). Both must
          // make it into the rendered history, otherwise user prompts
          // disappear from /v1/sessions/:id and /api/sessions/:id/history.
          if (typeof content === 'string') {
            if (!isSystemReminderText(content)) {
              messages.push({
                type: 'user',
                role: 'user',
                content,
                timestamp,
              });
            }
            return;
          }
          if (!Array.isArray(content)) return;

          for (const block of content) {
            if (block.type === 'text' && !isSystemReminderText(block.text)) {
              messages.push({
                type: 'user',
                role: 'user',
                content: block.text,
                timestamp,
              });
            } else if (block.type === 'image' && block.source && block.source.data) {
              messages.push({
                type: 'user',
                role: 'user',
                content: `data:${block.source.media_type || 'image/png'};base64,${block.source.data}`,
                contentType: 'image',
                timestamp,
              });
            } else if (block.type === 'tool_result') {
              const resultText = typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content || '');
              const truncated = resultText.length > 2000
                ? resultText.slice(0, 2000) + '\n... (' + resultText.length + ' chars)'
                : resultText;
              messages.push({
                type: 'tool_result',
                role: 'tool',
                content: truncated,
                contentType: 'tool_result',
                toolUseId: block.tool_use_id,
                isError: block.is_error || false,
                timestamp,
              });
            }
          }
        }
      } catch {
        // skip unparseable lines
      }
    });

    rl.on('close', () => {
      const result = [];
      const seenToolIds = new Set();
      for (const msg of messages) {
        if (msg.type === 'assistant' && msg.msgId) {
          const entry = assistantMessages.get(msg.msgId);
          if (!entry) continue;
          for (const block of entry.blocks) {
            if (block.type === 'text' && block.text) {
              result.push({
                role: 'assistant',
                content: block.text,
                contentType: 'text',
                timestamp: entry.timestamp,
              });
            } else if (block.type === 'tool_use') {
              if (seenToolIds.has(block.id)) continue;
              seenToolIds.add(block.id);
              result.push({
                role: 'assistant',
                content: JSON.stringify({
                  type: 'tool_use',
                  name: block.name,
                  input: block.input,
                  id: block.id,
                }),
                contentType: 'tool_use',
                timestamp: entry.timestamp,
              });
            }
          }
        } else if (msg.type === 'assistant' && msg.blocks) {
          for (const block of msg.blocks) {
            if (block.type === 'text' && block.text) {
              result.push({
                role: 'assistant',
                content: block.text,
                contentType: 'text',
                timestamp: msg.timestamp,
              });
            }
          }
        } else if (msg.type !== 'assistant') {
          result.push(msg);
        }
      }
      resolve(result);
    });

    stream.on('error', () => resolve([]));
  });
}

/**
 * Load conversation history from a Codex VS Code JSONL file.
 * Handles session_meta, response_item, event_msg, turn_context format.
 */
function loadCodexHistory(filePath) {
  return new Promise((resolve) => {
    const result = [];
    const seenCallIds = new Set();

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });

    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line);
        const payload = obj.payload || {};
        const timestamp = obj.timestamp || null;

        if (obj.type === 'event_msg') {
          // User prompt
          if (payload.type === 'user_message' && payload.message) {
            result.push({
              role: 'user',
              content: payload.message,
              timestamp,
            });
          }
          return;
        }

        if (obj.type === 'response_item') {
          // Assistant text message
          if (payload.type === 'message' && payload.role === 'assistant') {
            const content = payload.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'output_text' && block.text) {
                  result.push({
                    role: 'assistant',
                    content: block.text,
                    contentType: 'text',
                    timestamp,
                  });
                }
              }
            }
            return;
          }

          // Function call (tool use)
          if (payload.type === 'function_call' && payload.call_id) {
            if (seenCallIds.has(payload.call_id)) return;
            seenCallIds.add(payload.call_id);

            let toolName = payload.name || 'unknown';
            let input = {};
            try {
              input = JSON.parse(payload.arguments || '{}');
            } catch {
              input = { raw: payload.arguments || '' };
            }

            if (toolName === 'exec_command') {
              toolName = 'Bash';
              input = { command: input.cmd || input.command || '' };
            }

            result.push({
              role: 'assistant',
              content: JSON.stringify({
                type: 'tool_use',
                name: toolName,
                input,
                id: payload.call_id,
              }),
              contentType: 'tool_use',
              timestamp,
            });
            return;
          }

          // Function call output (tool result)
          if (payload.type === 'function_call_output' && payload.call_id) {
            const outKey = `out:${payload.call_id}`;
            if (seenCallIds.has(outKey)) return;
            seenCallIds.add(outKey);

            let output = payload.output || '';
            const outputMarker = output.indexOf('\nOutput:\n');
            if (outputMarker !== -1) {
              output = output.slice(outputMarker + '\nOutput:\n'.length);
            }

            const isError = /Process exited with code [^0]/.test(payload.output || '');
            const truncated = output.length > 2000
              ? output.slice(0, 2000) + '\n... (' + output.length + ' chars)'
              : output;

            result.push({
              role: 'tool',
              content: truncated,
              contentType: 'tool_result',
              toolUseId: payload.call_id,
              isError,
              timestamp,
            });
          }
        }
      } catch {
        // skip unparseable lines
      }
    });

    rl.on('close', () => resolve(result));
    stream.on('error', () => resolve([]));
  });
}

/**
 * Load conversation history from a Gemini session JSON file.
 * Gemini format: { sessionId, messages: [{ id, timestamp, type, content, model?, thoughts? }] }
 */
function loadGeminiHistory(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    const messages = data.messages || [];
    const result = [];

    for (const msg of messages) {
      const timestamp = msg.timestamp || null;

      if (msg.type === 'user') {
        const text = extractGeminiContent(msg.content);
        if (text) {
          result.push({
            role: 'user',
            content: text,
            timestamp,
          });
        }
        continue;
      }

      if (msg.type === 'gemini') {
        const content = msg.content;
        const displayContent = msg.displayContent;

        // displayContent often has the rendered output; fallback to content
        const text = extractGeminiContent(displayContent) || extractGeminiContent(content);
        if (text) {
          result.push({
            role: 'assistant',
            content: text,
            contentType: 'text',
            timestamp,
          });
        }

        // Extract tool calls from content if it's an array of parts
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part && part.functionCall) {
              result.push({
                role: 'assistant',
                content: JSON.stringify({
                  type: 'tool_use',
                  name: part.functionCall.name || 'unknown',
                  input: part.functionCall.args || {},
                  id: part.functionCall.id || msg.id,
                }),
                contentType: 'tool_use',
                timestamp,
              });
            }
            if (part && part.functionResponse) {
              const output = typeof part.functionResponse.response === 'string'
                ? part.functionResponse.response
                : JSON.stringify(part.functionResponse.response || '');
              const truncated = output.length > 2000
                ? output.slice(0, 2000) + '\n... (' + output.length + ' chars)'
                : output;
              result.push({
                role: 'tool',
                content: truncated,
                contentType: 'tool_result',
                toolUseId: part.functionResponse.id || msg.id,
                isError: false,
                timestamp,
              });
            }
          }
        }
        continue;
      }
    }

    return result;
  } catch {
    return [];
  }
}

/**
 * Recursively find all .jsonl files in a directory tree.
 * Used for Codex sessions which may be in YYYY/MM/DD subdirs.
 * @param {string} dirPath - Root directory to scan
 * @param {number} cutoff - Only include files modified after this timestamp
 * @returns {string[]} Array of absolute file paths
 */
function findJsonlRecursive(dirPath, cutoff) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlRecursive(fullPath, cutoff));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs >= cutoff) {
          results.push(fullPath);
        }
      } catch {
        // skip inaccessible files
      }
    }
  }

  return results;
}

/**
 * Extract metadata from a Codex session JSONL file.
 * Handles VS Code Codex extension format (session_meta, event_msg, response_item).
 */
async function extractCodexMetadata(filePath) {
  const sessionId = path.basename(filePath, '.jsonl');

  const headLines = await readLines(filePath, 30, 'head');
  const tailLines = await readLines(filePath, 5, 'tail');

  let cwd = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let firstPrompt = null;
  let metaId = null;
  let model = null;

  for (const line of headLines) {
    try {
      const obj = JSON.parse(line);
      const payload = obj.payload || {};

      if (obj.timestamp && !firstTimestamp) firstTimestamp = obj.timestamp;

      // VS Code format: session_meta has cwd and id in payload
      if (obj.type === 'session_meta') {
        if (payload.cwd && !cwd) cwd = payload.cwd;
        if (payload.id && !metaId) metaId = payload.id;
      }

      // VS Code format: user prompt in event_msg.user_message
      if (obj.type === 'event_msg' && payload.type === 'user_message' && payload.message && !firstPrompt) {
        firstPrompt = payload.message.slice(0, 120);
      }

      // VS Code format: model in turn_context
      if (obj.type === 'turn_context' && payload.model && !model) {
        model = payload.model;
      }

      // Fallback: top-level cwd (CLI format)
      if (obj.cwd && !cwd) cwd = obj.cwd;
    } catch {
      continue;
    }
  }

  for (const line of tailLines) {
    try {
      const obj = JSON.parse(line);
      if (obj.timestamp) lastTimestamp = obj.timestamp;
    } catch {
      continue;
    }
  }

  return {
    sessionId: metaId || sessionId,
    slug: null,
    cwd: cwd || null,
    project: cwd ? path.basename(cwd) : 'codex',
    firstPrompt: firstPrompt || null,
    model: model || null,
    firstActivity: firstTimestamp || null,
    lastActivity: lastTimestamp || firstTimestamp || null,
  };
}

/**
 * Extract metadata from a Gemini session JSON file.
 * Gemini format: { sessionId, projectHash, startTime, lastUpdated, messages: [...], summary? }
 * Message format: { id, timestamp, type: 'user'|'gemini', content, model?, thoughts? }
 */
function extractGeminiMetadata(filePath, cwd) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);

    const sessionId = data.sessionId || path.basename(filePath, '.json');
    const messages = data.messages || [];

    let firstPrompt = null;
    let model = null;

    for (const msg of messages) {
      if (msg.type === 'user' && !firstPrompt) {
        const text = extractGeminiContent(msg.content);
        if (text) firstPrompt = text.slice(0, 120);
      }
      if (msg.type === 'gemini' && msg.model && !model) {
        model = msg.model;
      }
      if (firstPrompt && model) break;
    }

    return {
      sessionId,
      slug: null,
      cwd: cwd || null,
      project: cwd ? path.basename(cwd) : 'gemini',
      firstPrompt: firstPrompt || data.summary || null,
      model: model || null,
      firstActivity: data.startTime || null,
      lastActivity: data.lastUpdated || data.startTime || null,
    };
  } catch {
    return null;
  }
}

/**
 * Extract text content from a Gemini message content field.
 * Content can be a string, or an array of parts (PartListUnion).
 */
function extractGeminiContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part.text === 'string') return part.text;
    }
  }
  return null;
}

/**
 * Find the JSONL/JSON file for a session ID across Claude, Codex, and Gemini directories.
 */
function findSessionFile(sessionId) {
  // Check Claude projects
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    projectDirs = [];
  }

  for (const dir of projectDirs) {
    const candidate = path.join(CLAUDE_DIR, dir, sessionId + '.jsonl');
    if (fs.existsSync(candidate)) return candidate;
  }

  // Check Codex sessions (flat and nested YYYY/MM/DD structure)
  const codexCandidate = path.join(CODEX_DIR, sessionId + '.jsonl');
  if (fs.existsSync(codexCandidate)) return codexCandidate;

  // Search nested dirs for rollout-*.jsonl or thread-id.jsonl
  const nested = findJsonlRecursive(CODEX_DIR, 0);
  for (const fp of nested) {
    if (path.basename(fp, '.jsonl') === sessionId) return fp;
  }

  // Check Gemini sessions
  let slugDirs;
  try {
    slugDirs = fs.readdirSync(GEMINI_TMP_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    slugDirs = [];
  }

  for (const slug of slugDirs) {
    const chatsDir = path.join(GEMINI_TMP_DIR, slug, 'chats');
    let files;
    try {
      files = fs.readdirSync(chatsDir)
        .filter(f => f.startsWith('session-') && f.endsWith('.json'));
    } catch {
      continue;
    }

    // Direct filename match (scanner derives sessionId from filename stem)
    const directMatch = `session-${sessionId}.json`;
    if (files.includes(directMatch)) {
      return path.join(chatsDir, directMatch);
    }

    // Match by JSON sessionId field (UUID inside the file)
    for (const file of files) {
      const filePath = path.join(chatsDir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        if (data.sessionId === sessionId) return filePath;
      } catch {
        continue;
      }
    }
  }

  // Check Pi sessions
  let piProjectDirs;
  try {
    piProjectDirs = fs.readdirSync(PI_SESSIONS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    piProjectDirs = [];
  }

  for (const slug of piProjectDirs) {
    const piDir = path.join(PI_SESSIONS_DIR, slug);
    let files;
    try {
      files = fs.readdirSync(piDir).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      if (path.basename(file, '.jsonl') === sessionId) {
        return path.join(piDir, file);
      }
    }
  }

  return null;
}

// --- OpenCode SQLite helpers ---

/**
 * Check if sqlite3 CLI is available.
 */
let _sqlite3Available = null;
function hasSqlite3() {
  if (_sqlite3Available !== null) return _sqlite3Available;
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'pipe', timeout: 5000 });
    _sqlite3Available = true;
  } catch {
    _sqlite3Available = false;
  }
  return _sqlite3Available;
}

/**
 * Run a SQLite query using the sqlite3 CLI and return parsed JSON rows.
 * Uses -readonly for safety and -json for structured output.
 */
function querySqlite(dbPath, query) {
  if (!hasSqlite3()) return [];
  if (!fs.existsSync(dbPath)) return [];
  try {
    const output = execFileSync('sqlite3', [
      '-readonly', '-json', dbPath, query,
    ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, encoding: 'utf8' });
    return JSON.parse(output || '[]');
  } catch {
    return [];
  }
}

/**
 * Scan OpenCode sessions from SQLite database.
 */
function scanOpencodeSessions(cutoff) {
  const cutoffISO = new Date(cutoff).toISOString();
  const rows = querySqlite(OPENCODE_DB,
    `SELECT id, title, directory, created_at, updated_at
     FROM session
     WHERE updated_at > '${cutoffISO}' AND parent_id IS NULL
     ORDER BY updated_at DESC
     LIMIT 50`
  );

  return rows.map(row => ({
    sessionId: row.id,
    slug: null,
    cwd: row.directory || null,
    project: row.directory ? path.basename(row.directory) : 'opencode',
    firstPrompt: row.title || null,
    model: null,
    firstActivity: row.created_at || null,
    lastActivity: row.updated_at || row.created_at || null,
    agentType: 'opencode',
  }));
}

/**
 * Load conversation history from OpenCode SQLite database for a session.
 */
function loadOpencodeHistory(sessionId) {
  // Query messages for this session, ordered by creation time
  const messages = querySqlite(OPENCODE_DB,
    `SELECT id, role, session_id, created_at
     FROM message
     WHERE session_id = '${sessionId.replace(/'/g, "''")}'
     ORDER BY created_at ASC`
  );

  if (messages.length === 0) return [];

  const result = [];

  for (const msg of messages) {
    // Query parts for each message
    const parts = querySqlite(OPENCODE_DB,
      `SELECT id, type, content, tool_call_id, tool_name
       FROM part
       WHERE message_id = '${msg.id.replace(/'/g, "''")}'
       ORDER BY id ASC`
    );

    const timestamp = msg.created_at || null;

    if (msg.role === 'user') {
      for (const part of parts) {
        if (part.type === 'text' && part.content) {
          result.push({
            role: 'user',
            content: part.content,
            timestamp,
          });
        }
      }
    } else if (msg.role === 'assistant') {
      for (const part of parts) {
        if (part.type === 'text' && part.content) {
          result.push({
            role: 'assistant',
            content: part.content,
            contentType: 'text',
            timestamp,
          });
        } else if (part.type === 'tool-invocation' || part.type === 'tool') {
          let input = {};
          try { input = JSON.parse(part.content || '{}'); } catch {}
          result.push({
            role: 'assistant',
            content: JSON.stringify({
              type: 'tool_use',
              name: part.tool_name || 'unknown',
              input,
              id: part.tool_call_id || part.id,
            }),
            contentType: 'tool_use',
            timestamp,
          });
        }
      }
    } else if (msg.role === 'tool') {
      for (const part of parts) {
        const output = part.content || '';
        const truncated = output.length > 2000
          ? output.slice(0, 2000) + '\n... (' + output.length + ' chars)'
          : output;
        result.push({
          role: 'tool',
          content: truncated,
          contentType: 'tool_result',
          toolUseId: part.tool_call_id || '',
          isError: false,
          timestamp,
        });
      }
    }
  }

  return result;
}

// --- Pi session helpers ---

/**
 * Scan Pi sessions from JSONL files in ~/.pi/agent/sessions/.
 */
async function scanPiSessions(cutoff) {
  const sessions = [];
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(PI_SESSIONS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return sessions;
  }

  for (const slug of projectDirs) {
    const piDir = path.join(PI_SESSIONS_DIR, slug);
    let files;
    try {
      files = fs.readdirSync(piDir).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(piDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) continue;

        const meta = await extractPiMetadata(filePath, slug);
        if (meta) {
          meta.agentType = 'pi';
          sessions.push(meta);
        }
      } catch {
        continue;
      }
    }
  }

  return sessions;
}

/**
 * Extract metadata from a Pi JSONL session file.
 * Pi format: {type:"session", cwd, id}, {type:"message", role:"user", content:[...]}, ...
 */
async function extractPiMetadata(filePath, slug) {
  const sessionId = path.basename(filePath, '.jsonl');
  const headLines = await readLines(filePath, 20, 'head');
  const tailLines = await readLines(filePath, 5, 'tail');

  let cwd = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let firstPrompt = null;
  let model = null;

  for (const line of headLines) {
    try {
      const obj = JSON.parse(line);

      if (obj.type === 'session' && obj.cwd && !cwd) cwd = obj.cwd;
      if (obj.timestamp && !firstTimestamp) firstTimestamp = obj.timestamp;

      // Extract first user message
      if (obj.type === 'message' && obj.role === 'user' && !firstPrompt) {
        const content = obj.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              firstPrompt = block.text.slice(0, 120);
              break;
            }
          }
        }
      }

      // Extract model from model_change or session header
      if (obj.type === 'model_change' && obj.model && !model) {
        model = obj.model;
      }
      if (obj.type === 'session' && obj.model && !model) {
        model = obj.model;
      }
    } catch {
      continue;
    }
  }

  for (const line of tailLines) {
    try {
      const obj = JSON.parse(line);
      if (obj.timestamp) lastTimestamp = obj.timestamp;
    } catch {
      continue;
    }
  }

  // Derive cwd from slug if not in file header
  if (!cwd && slug) {
    let stripped = slug;
    if (stripped.startsWith('--')) stripped = stripped.slice(2);
    if (stripped.endsWith('--')) stripped = stripped.slice(0, -2);
    if (stripped) cwd = '/' + stripped.replace(/-/g, '/');
  }

  return {
    sessionId,
    slug: slug || null,
    cwd: cwd || null,
    project: cwd ? path.basename(cwd) : 'pi',
    firstPrompt: firstPrompt || null,
    model: model || null,
    firstActivity: firstTimestamp || null,
    lastActivity: lastTimestamp || firstTimestamp || null,
  };
}

/**
 * Load conversation history from a Pi JSONL session file.
 * Parses all entries, skips thinking blocks, deduplicates by entry id.
 */
function loadPiHistory(filePath) {
  return new Promise((resolve) => {
    const result = [];
    const seenIds = new Set();

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });

    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.id && seenIds.has(obj.id)) return;
        if (obj.id) seenIds.add(obj.id);

        if (obj.type !== 'message') return;

        const content = obj.content;
        if (!Array.isArray(content)) return;
        const timestamp = obj.timestamp || null;

        if (obj.role === 'user') {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              result.push({
                role: 'user',
                content: block.text,
                timestamp,
              });
            }
          }
          return;
        }

        if (obj.role === 'assistant') {
          for (const block of content) {
            if (block.type === 'thinking') continue;

            if (block.type === 'text' && block.text) {
              result.push({
                role: 'assistant',
                content: block.text,
                contentType: 'text',
                timestamp,
              });
            } else if (block.type === 'toolCall') {
              let input = {};
              if (block.input) {
                if (typeof block.input === 'string') {
                  try { input = JSON.parse(block.input); } catch { input = { raw: block.input }; }
                } else {
                  input = block.input;
                }
              }
              result.push({
                role: 'assistant',
                content: JSON.stringify({
                  type: 'tool_use',
                  name: block.name || block.toolName || 'unknown',
                  input,
                  id: block.id || block.toolCallId || '',
                }),
                contentType: 'tool_use',
                timestamp,
              });
            }
          }
          return;
        }

        if (obj.role === 'toolResult') {
          for (const block of content) {
            const output = block.text || block.output || '';
            const truncated = output.length > 2000
              ? output.slice(0, 2000) + '\n... (' + output.length + ' chars)'
              : output;
            result.push({
              role: 'tool',
              content: truncated,
              contentType: 'tool_result',
              toolUseId: block.toolCallId || obj.toolCallId || '',
              isError: block.isError || false,
              timestamp,
            });
          }
        }
      } catch {
        // skip unparseable lines
      }
    });

    rl.on('close', () => resolve(result));
    stream.on('error', () => resolve([]));
  });
}

module.exports = {
  scanSessions,
  loadHistory,
  // Exported for unit tests: takes an absolute path to a JSONL file
  // and returns the parsed history array. The public `loadHistory`
  // resolves a sessionId to the right file via CLAUDE_DIR — for tests
  // that work against fixture files we call the parser directly.
  loadClaudeHistory,
  isSystemReminderText,
};
