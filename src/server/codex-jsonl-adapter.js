/**
 * CodexJsonlAdapter — tails a Codex JSONL session file and emits
 * parsed conversation messages in the same format as JsonlWatcher.
 *
 * Handles the VS Code Codex extension format:
 *   session_meta, response_item, event_msg, turn_context
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
   * Handles VS Code Codex extension format (session_meta, response_item,
   * event_msg, turn_context).
   */
  _processEvent(event) {
    const payload = event.payload || {};

    switch (event.type) {
      case 'session_meta':
        this.emit('message', {
          role: 'system',
          content: JSON.stringify({
            subtype: 'init',
            session_id: payload.id || '',
            agent: 'codex',
          }),
          contentType: 'json',
          source: 'jsonl',
        });
        break;

      case 'event_msg':
        this._processEventMsg(payload, event.timestamp);
        break;

      case 'response_item':
        this._processResponseItem(payload, event.timestamp);
        break;

      // turn_context — skip (metadata only)
    }
  }

  /**
   * Handle event_msg payloads (task lifecycle, user messages).
   */
  _processEventMsg(payload, timestamp) {
    switch (payload.type) {
      case 'task_started':
        this.emit('status', 'busy');
        break;

      case 'task_complete':
        this.emit('status', 'idle');
        break;

      case 'user_message':
        if (payload.message) {
          this.emit('message', {
            role: 'user',
            content: payload.message,
            contentType: 'text',
            timestamp,
            source: 'jsonl',
          });
        }
        break;

      // Skip: agent_message (duplicated by response_item), agent_reasoning, token_count
    }
  }

  /**
   * Handle response_item payloads (messages, function calls, outputs).
   */
  _processResponseItem(payload, timestamp) {
    switch (payload.type) {
      case 'message': {
        if (payload.role === 'assistant') {
          const content = payload.content;
          if (!Array.isArray(content)) break;
          for (const block of content) {
            if (block.type === 'output_text' && block.text) {
              this.emit('message', {
                role: 'assistant',
                content: block.text,
                contentType: 'text',
                timestamp,
                source: 'jsonl',
              });
            }
          }
        }
        // Skip user/developer role messages (user_message in event_msg is cleaner)
        break;
      }

      case 'function_call': {
        const callId = payload.call_id;
        if (!callId) break;

        const callKey = `call:${callId}`;
        if (this.seenItemIds.has(callKey)) break;
        this.seenItemIds.add(callKey);

        let toolName = payload.name || 'unknown';
        let input = {};

        // Parse arguments (JSON string)
        try {
          input = JSON.parse(payload.arguments || '{}');
        } catch {
          input = { raw: payload.arguments || '' };
        }

        // Map exec_command to Bash for display
        if (toolName === 'exec_command') {
          toolName = 'Bash';
          input = { command: input.cmd || input.command || '' };
        }

        this.emit('message', {
          role: 'assistant',
          content: JSON.stringify({
            type: 'tool_use',
            name: toolName,
            input,
            id: callId,
          }),
          contentType: 'tool_use',
          timestamp,
          source: 'jsonl',
        });
        break;
      }

      case 'function_call_output': {
        const callId = payload.call_id;
        if (!callId) break;

        const outKey = `out:${callId}`;
        if (this.seenItemIds.has(outKey)) break;
        this.seenItemIds.add(outKey);

        // Extract clean output (strip Codex metadata prefix if present)
        let output = payload.output || '';
        const outputMarker = output.indexOf('\nOutput:\n');
        if (outputMarker !== -1) {
          output = output.slice(outputMarker + '\nOutput:\n'.length);
        }

        // Detect error from exit code in metadata
        const isError = /Process exited with code [^0]/.test(payload.output || '');

        const truncated = output.length > 2000
          ? output.slice(0, 2000) + '\n... (' + output.length + ' chars)'
          : output;

        this.emit('message', {
          role: 'tool',
          content: truncated,
          contentType: 'tool_result',
          toolUseId: callId,
          isError,
          timestamp,
          source: 'jsonl',
        });
        break;
      }

      // Skip: reasoning (internal)
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
