/**
 * Session scanner — discovers sessions from Claude Code and Codex.
 *
 * Claude sessions:  ~/.claude/projects/<slug>/<sessionId>.jsonl
 * Codex sessions:   ~/.codex/sessions/<threadId>.jsonl
 *
 * Scans JSONL files to extract metadata (session ID, first prompt,
 * timestamps, model). Only reads the first/last few lines for speed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');

/**
 * Scan sessions from Claude Code and/or Codex and return metadata.
 * @param {object} options
 * @param {number} options.maxAge - Max age in ms to include (default: 7 days)
 * @param {number} options.limit - Max sessions to return (default: 50)
 * @param {string} options.source - 'claude' | 'codex' | 'all' (default: 'all')
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
 *
 * @param {string} sessionId - The session UUID
 * @returns {Promise<Array>} conversation messages
 */
async function loadHistory(sessionId) {
  // Find the JSONL file across all project directories
  const filePath = findSessionFile(sessionId);
  if (!filePath) return [];

  return new Promise((resolve) => {
    const messages = [];
    // Track last content per assistant message.id (streaming dedup)
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
            // Accumulate blocks across incremental entries for the same message.id.
            // Claude Code writes each new content block as a separate JSONL entry,
            // so we must concat rather than overwrite.
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
      // Resolve assistant message placeholders with final content
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
              // Deduplicate tool_use by id (safety net)
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
            // Skip 'thinking' blocks
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
 * Codex uses: thread.started, item.*, turn.* event format.
 */
async function extractCodexMetadata(filePath) {
  const sessionId = path.basename(filePath, '.jsonl');

  const headLines = await readLines(filePath, 30, 'head');
  const tailLines = await readLines(filePath, 5, 'tail');

  let cwd = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let firstPrompt = null;
  let threadId = null;

  for (const line of headLines) {
    try {
      const obj = JSON.parse(line);

      if (obj.cwd && !cwd) cwd = obj.cwd;
      if (obj.timestamp && !firstTimestamp) firstTimestamp = obj.timestamp;
      if (obj.type === 'thread.started' && obj.thread_id) {
        threadId = obj.thread_id;
        if (obj.cwd && !cwd) cwd = obj.cwd;
      }

      // First agent message or prompt as firstPrompt
      if (obj.type === 'item.completed' && obj.item) {
        if (obj.item.type === 'agent_message' && !firstPrompt) {
          firstPrompt = (obj.item.text || '').slice(0, 120);
        }
      }
      if (obj.prompt && !firstPrompt) {
        firstPrompt = obj.prompt.slice(0, 120);
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

  return {
    sessionId: threadId || sessionId,
    slug: null,
    cwd: cwd || null,
    project: cwd ? path.basename(cwd) : 'codex',
    firstPrompt: firstPrompt || null,
    model: null,
    firstActivity: firstTimestamp || null,
    lastActivity: lastTimestamp || firstTimestamp || null,
  };
}

/**
 * Find the JSONL file for a session ID across Claude and Codex directories.
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

  return null;
}

module.exports = { scanSessions, loadHistory };
