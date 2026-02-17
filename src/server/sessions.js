/**
 * SessionScanner - Discovers Claude Code sessions from ~/.claude/projects/
 *
 * Scans the JSONL session files to extract metadata:
 *   - Session ID, project CWD, first prompt summary
 *   - First and last activity timestamps
 *   - Model used
 *
 * Only reads the first few and last few lines of each file for speed.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

/**
 * Scan all Claude Code projects and return session metadata.
 * @param {object} options
 * @param {number} options.maxAge - Max age in ms to include (default: 7 days)
 * @param {number} options.limit - Max sessions to return (default: 50)
 * @returns {Promise<Array>} sorted by lastActivity descending
 */
async function scanSessions(options = {}) {
  const maxAge = options.maxAge || 7 * 24 * 60 * 60 * 1000;
  const limit = options.limit || 50;
  const cutoff = Date.now() - maxAge;

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }

  const sessions = [];

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
            // Streaming dedup: only push one placeholder per message.id,
            // but keep updating the entry so the last one wins.
            const alreadyPlaced = assistantMessages.has(msgId);
            assistantMessages.set(msgId, { blocks: content, timestamp });
            if (!alreadyPlaced) {
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
 * Find the JSONL file for a session ID across all project directories.
 */
function findSessionFile(sessionId) {
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return null;
  }

  for (const dir of projectDirs) {
    const candidate = path.join(CLAUDE_DIR, dir, sessionId + '.jsonl');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

module.exports = { scanSessions, loadHistory };
