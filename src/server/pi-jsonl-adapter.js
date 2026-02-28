/**
 * PiJsonlAdapter — tails a Pi coding agent JSONL session file and emits
 * parsed conversation messages in the same format as JsonlWatcher.
 *
 * Pi JSONL format uses a tree structure with id/parentId fields:
 *   {type:"session", id, cwd, ...}
 *   {type:"message", id, parentId, role:"user"|"assistant"|"toolResult", content:[...]}
 *   {type:"model_change", ...}
 *   {type:"compaction", ...}
 *
 * Content blocks: {type:"text", text}, {type:"toolCall", ...}, {type:"toolResult", ...},
 *                 {type:"thinking", text} (skipped)
 *
 * Uses the same fs.watch() + byte-offset pattern as CodexJsonlAdapter.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class PiJsonlAdapter extends EventEmitter {
  constructor(filePath, options = {}) {
    super();
    this.filePath = filePath;
    this.offset = 0;
    this.watcher = null;
    this.lineBuffer = '';
    this.closed = false;
    this.debounceTimer = null;
    this.debounceMs = options.debounceMs || 100;
    this.seenIds = new Set();
  }

  /**
   * Start watching.
   * @param {object} opts
   * @param {boolean} opts.catchUp - If true, parse existing file first.
   */
  async start({ catchUp = false } = {}) {
    if (!fs.existsSync(this.filePath)) {
      this._watchForCreation();
      return;
    }

    if (catchUp) {
      await this._readFromOffset(0);
    } else {
      try {
        const stat = fs.statSync(this.filePath);
        this.offset = stat.size;
      } catch {
        this.offset = 0;
      }
    }

    this._startWatching();
  }

  _watchForCreation() {
    const dir = path.dirname(this.filePath);
    const basename = path.basename(this.filePath);
    try {
      this.watcher = fs.watch(dir, (eventType, filename) => {
        if (this.closed) return;
        if (filename === basename && fs.existsSync(this.filePath)) {
          this.watcher.close();
          this._readFromOffset(0).then(() => this._startWatching());
        }
      });
      this.watcher.on('error', () => {});
    } catch {
      // Directory may not exist
    }
  }

  _startWatching() {
    if (this.closed) return;
    try {
      this.watcher = fs.watch(this.filePath, () => {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this._onFileChange(), this.debounceMs);
      });
      this.watcher.on('error', (err) => this.emit('error', err));
    } catch (e) {
      this.emit('error', e);
    }
  }

  _onFileChange() {
    if (this.closed) return;
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size > this.offset) {
        this._readFromOffset(this.offset);
      } else if (stat.size < this.offset) {
        // File was truncated — re-read from start
        this.offset = 0;
        this.seenIds.clear();
        this.lineBuffer = '';
        this._readFromOffset(0);
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.emit('deleted');
        this.close();
      }
    }
  }

  _readFromOffset(offset) {
    return new Promise((resolve) => {
      const stream = fs.createReadStream(this.filePath, {
        encoding: 'utf8',
        start: offset,
      });
      let data = '';
      stream.on('data', (chunk) => { data += chunk; });
      stream.on('end', () => {
        this.offset = offset + Buffer.byteLength(data, 'utf8');

        data = this.lineBuffer + data;
        this.lineBuffer = '';

        const lines = data.split('\n');
        this.lineBuffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            this._processEntry(obj);
          } catch {
            // Skip unparseable lines
          }
        }
        resolve();
      });
      stream.on('error', () => resolve());
    });
  }

  /**
   * Translate a Pi JSONL entry into hub-format messages.
   */
  _processEntry(entry) {
    // Dedup by entry id
    if (entry.id && this.seenIds.has(entry.id)) return;
    if (entry.id) this.seenIds.add(entry.id);

    switch (entry.type) {
      case 'session':
        this.emit('message', {
          role: 'system',
          content: JSON.stringify({
            subtype: 'init',
            session_id: entry.id || '',
            agent: 'pi',
            cwd: entry.cwd || null,
          }),
          contentType: 'json',
          source: 'jsonl',
        });
        break;

      case 'message':
        this._processMessage(entry);
        break;

      // Skip metadata entries
      case 'model_change':
      case 'compaction':
        break;
    }
  }

  /**
   * Process a Pi message entry.
   */
  _processMessage(entry) {
    const content = entry.content;
    if (!Array.isArray(content)) return;

    if (entry.role === 'user') {
      this.emit('status', 'busy');
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          this.emit('message', {
            role: 'user',
            content: block.text,
            contentType: 'text',
            source: 'jsonl',
          });
        }
      }
      return;
    }

    if (entry.role === 'assistant') {
      for (const block of content) {
        // Skip thinking blocks
        if (block.type === 'thinking') continue;

        if (block.type === 'text' && block.text) {
          this.emit('message', {
            role: 'assistant',
            content: block.text,
            contentType: 'text',
            source: 'jsonl',
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
          this.emit('message', {
            role: 'assistant',
            content: JSON.stringify({
              type: 'tool_use',
              name: block.name || block.toolName || 'unknown',
              input,
              id: block.id || block.toolCallId || '',
            }),
            contentType: 'tool_use',
            source: 'jsonl',
          });
        }
      }
      return;
    }

    if (entry.role === 'toolResult') {
      for (const block of content) {
        const output = block.text || block.output || '';
        const truncated = output.length > 2000
          ? output.slice(0, 2000) + '\n... (' + output.length + ' chars)'
          : output;
        this.emit('message', {
          role: 'tool',
          content: truncated,
          contentType: 'tool_result',
          toolUseId: block.toolCallId || entry.toolCallId || '',
          isError: block.isError || false,
          source: 'jsonl',
        });
      }
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.debounceTimer);
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.removeAllListeners();
  }
}

module.exports = { PiJsonlAdapter };
