/**
 * JsonlWatcher — tails a Claude Code JSONL session file and emits
 * parsed conversation messages as they are appended.
 *
 * Uses fs.watch() + byte-offset tracking to read only new data.
 * Deduplicates by UUID and streaming assistant message.id.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class JsonlWatcher extends EventEmitter {
  constructor(filePath, options = {}) {
    super();
    this.filePath = filePath;
    this.offset = 0;
    this.watcher = null;
    this.lineBuffer = '';
    this.closed = false;
    this.debounceTimer = null;
    this.debounceMs = options.debounceMs || 100;
    this.seenUuids = new Set();
    this.assistantMessageIds = new Set();
  }

  /**
   * Start watching.
   * @param {object} opts
   * @param {boolean} opts.catchUp - If true, parse the existing file first.
   *   If false (default), skip to end and only emit new lines.
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
          // Read any content written during creation before starting the watcher
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
        // File was truncated (shouldn't happen, but handle it)
        this.offset = 0;
        this.seenUuids.clear();
        this.assistantMessageIds.clear();
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
        // Last element is either '' (ended with \n) or a partial line
        this.lineBuffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            this._processLine(obj);
          } catch {
            // Skip unparseable lines
          }
        }
        resolve();
      });
      stream.on('error', () => resolve());
    });
  }

  _processLine(obj) {
    if (obj.uuid) {
      if (this.seenUuids.has(obj.uuid)) return;
      this.seenUuids.add(obj.uuid);
    }

    if (obj.type === 'user') {
      this._emitUserMessage(obj);
    } else if (obj.type === 'assistant') {
      this._emitAssistantMessage(obj);
      // Detect turn completion: non-null stop_reason means model finished
      const stopReason = obj.message && obj.message.stop_reason;
      if (stopReason) {
        this.emit('status', 'idle');
      }
    }
    // Skip queue-operation, progress, file-history-snapshot, etc.
  }

  _emitUserMessage(obj) {
    const content = obj.message && obj.message.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'text' && !block.text.startsWith('<')) {
        // User sent a prompt — model will start working
        this.emit('status', 'busy');
        this.emit('message', {
          role: 'user',
          content: block.text,
          timestamp: obj.timestamp,
          source: 'jsonl',
        });
      } else if (block.type === 'tool_result') {
        const resultText = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content || '');
        const truncated = resultText.length > 2000
          ? resultText.slice(0, 2000) + '\n... (' + resultText.length + ' chars)'
          : resultText;
        this.emit('message', {
          role: 'tool',
          content: truncated,
          contentType: 'tool_result',
          toolUseId: block.tool_use_id,
          isError: block.is_error || false,
          timestamp: obj.timestamp,
          source: 'jsonl',
        });
      } else if (block.type === 'image' && block.source && block.source.data) {
        this.emit('message', {
          role: 'user',
          content: `data:${block.source.media_type || 'image/png'};base64,${block.source.data}`,
          contentType: 'image',
          timestamp: obj.timestamp,
          source: 'jsonl',
        });
      }
    }
  }

  _emitAssistantMessage(obj) {
    const content = obj.message && obj.message.content;
    if (!Array.isArray(content)) return;
    const msgId = obj.message && obj.message.id;

    // Claude Code writes each new content block as a separate JSONL entry
    // for the same message.id (incremental, not cumulative).
    // Always emit new blocks — dedup tool_use by block.id to avoid duplicates.
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        this.emit('message', {
          role: 'assistant',
          content: block.text,
          contentType: 'text',
          timestamp: obj.timestamp,
          source: 'jsonl',
          msgId,
        });
      } else if (block.type === 'tool_use') {
        // Dedup tool_use by block.id to handle any cumulative entries
        const toolKey = `tool:${block.id}`;
        if (this.assistantMessageIds.has(toolKey)) continue;
        this.assistantMessageIds.add(toolKey);
        this.emit('message', {
          role: 'assistant',
          content: JSON.stringify({
            type: 'tool_use',
            name: block.name,
            input: block.input,
            id: block.id,
          }),
          contentType: 'tool_use',
          timestamp: obj.timestamp,
          source: 'jsonl',
          msgId,
        });
      }
      // Skip 'thinking' blocks
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

module.exports = { JsonlWatcher };
