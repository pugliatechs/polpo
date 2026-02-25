/**
 * Session scanner — discovers sessions from Claude Code, Codex, and Gemini.
 *
 * Claude sessions:  ~/.claude/projects/<slug>/<sessionId>.jsonl
 * Codex sessions:   ~/.codex/sessions/<threadId>.jsonl
 * Gemini sessions:  ~/.gemini/tmp/<slug>/chats/session-*.json
 *
 * Scans JSONL/JSON files to extract metadata (session ID, first prompt,
 * timestamps, model). Only reads the first/last few lines for speed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');
const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const GEMINI_TMP_DIR = path.join(GEMINI_DIR, 'tmp');
const GEMINI_PROJECTS_FILE = path.join(GEMINI_DIR, 'projects.json');

/**
 * Scan sessions from Claude Code and/or Codex and return metadata.
 * @param {object} options
 * @param {number} options.maxAge - Max age in ms to include (default: 7 days)
 * @param {number} options.limit - Max sessions to return (default: 50)
 * @param {string} options.source - 'claude' | 'codex' | 'gemini' | 'all' (default: 'all')
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
  // Find the session file across all project directories
  const filePath = findSessionFile(sessionId);
  if (!filePath) return [];

  // Gemini sessions are .json files (not .jsonl)
  if (filePath.endsWith('.json')) {
    return loadGeminiHistory(filePath);
  }

  // Detect JSONL format from the first line
  const firstLines = await readLines(filePath, 1, 'head');
  let isCodex = false;
  if (firstLines.length > 0) {
    try {
      const first = JSON.parse(firstLines[0]);
      isCodex = first.type === 'session_meta';
    } catch {}
  }

  if (isCodex) {
    return loadCodexHistory(filePath);
  }

  return loadClaudeHistory(filePath);
}

/**
 * Load conversation history from a Claude Code JSONL file.
 */
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
          if (!Array.isArray(content)) return;

          for (const block of content) {
            if (block.type === 'text' && !block.text.startsWith('<')) {
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

  return null;
}

module.exports = { scanSessions, loadHistory };
