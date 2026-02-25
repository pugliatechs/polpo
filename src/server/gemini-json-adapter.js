/**
 * GeminiJsonAdapter — watches a Gemini session JSON file and emits
 * parsed conversation messages in the same format as JsonlWatcher.
 *
 * Gemini stores sessions as single JSON files (not JSONL):
 *   ~/.gemini/tmp/<project-slug>/chats/session-*.json
 *
 * The file contains: { sessionId, messages, startTime, lastUpdated, summary? }
 * Messages have: { type: 'user'|'gemini'|'info'|'error'|'warning', content, toolCalls? }
 *
 * On file change, re-reads the JSON, compares message count, and emits new messages.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class GeminiJsonAdapter extends EventEmitter {
  constructor(filePath, options = {}) {
    super();
    this.filePath = filePath;
    this.watcher = null;
    this.closed = false;
    this.debounceTimer = null;
    this.debounceMs = options.debounceMs || 200;
    this.lastMessageCount = 0;
    this.lastMessages = [];
    this.seenToolIds = new Set();
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
      this._processFile(true);
    } else {
      // Skip existing messages
      this._loadCurrentState();
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
          this._processFile(true);
          this._startWatching();
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
    this._processFile(false);
  }

  /**
   * Load current message count without emitting events.
   */
  _loadCurrentState() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const session = JSON.parse(data);
      if (session.messages && Array.isArray(session.messages)) {
        this.lastMessageCount = session.messages.length;
        this.lastMessages = session.messages;
        // Track existing tool call IDs
        for (const msg of session.messages) {
          if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
            for (const tc of msg.toolCalls) {
              if (tc.id) this.seenToolIds.add(tc.id);
            }
          }
        }
      }
    } catch {
      // File may not be readable yet
    }
  }

  /**
   * Read the JSON file and emit any new messages.
   */
  _processFile(emitAll) {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const session = JSON.parse(data);

      if (!session.messages || !Array.isArray(session.messages)) return;

      const messages = session.messages;
      const startIndex = emitAll ? 0 : this.lastMessageCount;

      for (let i = startIndex; i < messages.length; i++) {
        this._emitMessage(messages[i]);
      }

      this.lastMessageCount = messages.length;
      this.lastMessages = messages;
    } catch {
      // File may be mid-write — ignore parse errors
    }
  }

  /**
   * Convert a Gemini session message to hub-format events.
   */
  _emitMessage(msg) {
    const timestamp = Date.now();

    switch (msg.type) {
      case 'user': {
        const content = this._extractContent(msg.content);
        if (content) {
          this.emit('message', {
            role: 'user',
            content,
            contentType: 'text',
            timestamp,
            source: 'jsonl',
          });
          this.emit('status', 'busy');
        }
        break;
      }

      case 'gemini': {
        const content = this._extractContent(msg.content);
        if (content) {
          this.emit('message', {
            role: 'assistant',
            content,
            contentType: 'text',
            timestamp,
            source: 'jsonl',
          });
        }

        // Emit tool calls if present
        if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
          for (const tc of msg.toolCalls) {
            if (!tc.id || this.seenToolIds.has(tc.id)) continue;
            this.seenToolIds.add(tc.id);

            // Tool use event
            this.emit('message', {
              role: 'assistant',
              content: JSON.stringify({
                type: 'tool_use',
                name: tc.displayName || tc.name || 'unknown',
                input: tc.args || {},
                id: tc.id,
              }),
              contentType: 'tool_use',
              timestamp,
              source: 'jsonl',
            });

            // Tool result event (if result is available)
            if (tc.result !== undefined) {
              const resultText = typeof tc.result === 'string'
                ? tc.result
                : Array.isArray(tc.result)
                  ? tc.result.map(p => p.text || '').join('')
                  : JSON.stringify(tc.result || '');
              const truncated = resultText.length > 2000
                ? resultText.slice(0, 2000) + '\n... (' + resultText.length + ' chars)'
                : resultText;

              this.emit('message', {
                role: 'tool',
                content: truncated,
                contentType: 'tool_result',
                toolUseId: tc.id,
                isError: tc.status === 'error',
                timestamp,
                source: 'jsonl',
              });
            }
          }
        }

        this.emit('status', 'idle');
        break;
      }

      case 'info':
      case 'error':
      case 'warning':
        // System messages — skip for now
        break;
    }
  }

  /**
   * Extract text content from Gemini's PartListUnion format.
   * Can be a string, or an array of { text: string } parts.
   */
  _extractContent(content) {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map(part => {
          if (typeof part === 'string') return part;
          if (part && part.text) return part.text;
          return '';
        })
        .join('');
    }
    return String(content);
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

module.exports = { GeminiJsonAdapter };
