/**
 * CodexJsonlAdapter — tails a Codex JSONL session file and emits
 * parsed conversation messages in the same format as JsonlWatcher.
 *
 * Codex JSONL events (thread.started, item.*, turn.*) are translated
 * to the hub's uniform message format (role/content/contentType).
 *
 * Uses the same fs.watch() + byte-offset pattern as JsonlWatcher.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class CodexJsonlAdapter extends EventEmitter {
  constructor(filePath, options = {}) {
    super();
    this.filePath = filePath;
    this.offset = 0;
    this.watcher = null;
    this.lineBuffer = '';
    this.closed = false;
    this.debounceTimer = null;
    this.debounceMs = options.debounceMs || 100;
    this.seenItemIds = new Set();
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
        this.offset = 0;
        this.seenItemIds.clear();
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
            this._processEvent(obj);
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
   * Translate a Codex JSONL event into hub-format messages.
   */
  _processEvent(event) {
    switch (event.type) {
      case 'thread.started':
        this.emit('message', {
          role: 'system',
          content: JSON.stringify({
            subtype: 'init',
            session_id: event.thread_id,
            agent: 'codex',
          }),
          contentType: 'json',
          source: 'jsonl',
        });
        break;

      case 'turn.started':
        this.emit('status', 'busy');
        break;

      case 'item.started': {
        const item = event.item || {};
        if (!item.id) break;

        // Dedup: skip if we've already seen this item
        const startKey = `start:${item.id}`;
        if (this.seenItemIds.has(startKey)) break;
        this.seenItemIds.add(startKey);

        if (item.type === 'command_execution') {
          this.emit('message', {
            role: 'assistant',
            content: JSON.stringify({
              type: 'tool_use',
              name: 'Bash',
              input: { command: item.command || '' },
              id: item.id,
            }),
            contentType: 'tool_use',
            source: 'jsonl',
          });
        } else if (item.type === 'file_change') {
          const toolName = item.action === 'create' ? 'Write' : 'Edit';
          this.emit('message', {
            role: 'assistant',
            content: JSON.stringify({
              type: 'tool_use',
              name: toolName,
              input: { file_path: item.file || item.path || '' },
              id: item.id,
            }),
            contentType: 'tool_use',
            source: 'jsonl',
          });
        } else if (item.type === 'mcp_tool_call') {
          this.emit('message', {
            role: 'assistant',
            content: JSON.stringify({
              type: 'tool_use',
              name: item.tool_name || item.name || 'mcp_tool',
              input: item.arguments || item.input || {},
              id: item.id,
            }),
            contentType: 'tool_use',
            source: 'jsonl',
          });
        }
        break;
      }

      case 'item.completed': {
        const item = event.item || {};
        if (!item.id) break;

        const completeKey = `complete:${item.id}`;
        if (this.seenItemIds.has(completeKey)) break;
        this.seenItemIds.add(completeKey);

        if (item.type === 'agent_message') {
          this.emit('message', {
            role: 'assistant',
            content: item.text || '',
            contentType: 'text',
            source: 'jsonl',
          });
        } else if (item.type === 'command_execution') {
          const output = item.output || item.stdout || '';
          const truncated = output.length > 2000
            ? output.slice(0, 2000) + '\n... (' + output.length + ' chars)'
            : output;
          this.emit('message', {
            role: 'tool',
            content: truncated,
            contentType: 'tool_result',
            toolUseId: item.id,
            isError: item.exit_code !== 0,
            source: 'jsonl',
          });
        } else if (item.type === 'file_change') {
          this.emit('message', {
            role: 'tool',
            content: `${item.action || 'modified'}: ${item.file || item.path || ''}`,
            contentType: 'tool_result',
            toolUseId: item.id,
            source: 'jsonl',
          });
        } else if (item.type === 'mcp_tool_call') {
          const result = typeof item.result === 'string'
            ? item.result
            : JSON.stringify(item.result || '');
          const truncated = result.length > 2000
            ? result.slice(0, 2000) + '\n... (' + result.length + ' chars)'
            : result;
          this.emit('message', {
            role: 'tool',
            content: truncated,
            contentType: 'tool_result',
            toolUseId: item.id,
            isError: !!item.error,
            source: 'jsonl',
          });
        }
        break;
      }

      case 'turn.completed':
        this.emit('status', 'idle');
        this.emit('message', {
          role: 'system',
          content: JSON.stringify({
            type: 'turn_complete',
            usage: event.usage || {},
          }),
          contentType: 'turn_complete',
          source: 'jsonl',
        });
        break;

      case 'turn.failed':
        this.emit('status', 'idle');
        this.emit('message', {
          role: 'system',
          content: `[turn failed: ${event.error || event.message || 'unknown error'}]`,
          contentType: 'text',
          source: 'jsonl',
        });
        break;
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

module.exports = { CodexJsonlAdapter };
