/**
 * CodexScanner — discovers active OpenAI Codex sessions by watching
 * ~/.codex/sessions/ for JSONL file changes.
 *
 * Codex stores sessions in a date-based hierarchy:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Both the CLI and VS Code extension write to the same directory.
 * Also supports flat JSONL files directly in the sessions dir.
 *
 * Uses fs.watch() for event-driven detection with recursive subdirectory watching.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

class CodexScanner extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} options.idleCheckInterval - ms between idle checks (default: 30s)
   * @param {number} options.idleTimeout       - ms of inactivity before marking disconnected (default: 10 min)
   * @param {string} options.sessionsDir       - override sessions directory
   */
  constructor(options = {}) {
    super();
    this.sessionsDir = options.sessionsDir || path.join(os.homedir(), '.codex', 'sessions');
    this.idleCheckInterval = options.idleCheckInterval || 30 * 1000;
    this.idleTimeout = options.idleTimeout || 10 * 60 * 1000;
    this.sessions = new Map(); // sessionId -> { path, lastModified, registered }
    this.watchers = new Map(); // dirPath -> fs.FSWatcher
    this.idleTimer = null;
    this.closed = false;
  }

  start() {
    if (!fs.existsSync(this.sessionsDir)) {
      this._watchForCreation();
      return;
    }

    this._watchDir(this.sessionsDir);
    this._scanRecursive(this.sessionsDir);
    this._startIdleCheck();
  }

  stop() {
    this.closed = true;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    for (const w of this.watchers.values()) {
      w.close();
    }
    this.watchers.clear();
  }

  /**
   * Wait for the sessions directory to be created.
   */
  _watchForCreation() {
    const parent = path.dirname(this.sessionsDir);
    const basename = path.basename(this.sessionsDir);
    try {
      if (!fs.existsSync(parent)) {
        const grandparent = path.dirname(parent);
        if (!fs.existsSync(grandparent)) return;
        const w = fs.watch(grandparent, (_, filename) => {
          if (this.closed) return;
          if (filename === path.basename(parent) && fs.existsSync(this.sessionsDir)) {
            w.close();
            this.watchers.delete('__creation__');
            this._watchDir(this.sessionsDir);
            this._scanRecursive(this.sessionsDir);
            this._startIdleCheck();
          } else if (filename === path.basename(parent) && fs.existsSync(parent)) {
            w.close();
            this.watchers.delete('__creation__');
            this._watchForCreation();
          }
        });
        w.on('error', () => {});
        this.watchers.set('__creation__', w);
        return;
      }

      const w = fs.watch(parent, (_, filename) => {
        if (this.closed) return;
        if (filename === basename && fs.existsSync(this.sessionsDir)) {
          w.close();
          this.watchers.delete('__creation__');
          this._watchDir(this.sessionsDir);
          this._scanRecursive(this.sessionsDir);
          this._startIdleCheck();
        }
      });
      w.on('error', () => {});
      this.watchers.set('__creation__', w);
    } catch {
      // parent dir doesn't exist
    }
  }

  /**
   * Watch a directory. If a subdirectory appears, start watching it too.
   * If a JSONL file appears or changes, handle it.
   */
  _watchDir(dirPath) {
    if (this.closed || this.watchers.has(dirPath)) return;

    try {
      const watcher = fs.watch(dirPath, (eventType, filename) => {
        if (this.closed || !filename) return;

        const fullPath = path.join(dirPath, filename);

        if (filename.endsWith('.jsonl')) {
          const sessionId = this._deriveSessionId(fullPath);
          this._handleJsonlChange(sessionId, fullPath);
          return;
        }

        // Check if a new subdirectory appeared (YYYY, MM, DD)
        try {
          if (fs.statSync(fullPath).isDirectory() && !this.watchers.has(fullPath)) {
            this._watchDir(fullPath);
            this._scanRecursive(fullPath);
          }
        } catch {
          // file/dir disappeared
        }
      });
      watcher.on('error', () => {
        this.watchers.delete(dirPath);
      });
      this.watchers.set(dirPath, watcher);
    } catch {
      // directory may not exist
    }
  }

  /**
   * Recursively scan a directory for JSONL files and subdirectories.
   * Sets up watchers on all subdirectories found.
   */
  _scanRecursive(dirPath) {
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    const now = Date.now();
    const recentThreshold = 2 * 60 * 1000; // 2 minutes

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Recurse into subdirectory and watch it
        this._watchDir(fullPath);
        this._scanRecursive(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

      const sessionId = this._deriveSessionId(fullPath);
      if (this.sessions.has(sessionId)) continue;

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (now - stat.mtimeMs > recentThreshold) continue;

      this._handleJsonlChange(sessionId, fullPath);
    }
  }

  /**
   * Derive a unique session ID from a JSONL file path.
   * For rollout-*.jsonl, use the rollout filename stem.
   * For flat *.jsonl, use the filename stem.
   */
  _deriveSessionId(filePath) {
    return path.basename(filePath, '.jsonl');
  }

  /**
   * Handle a JSONL file change event.
   */
  _handleJsonlChange(sessionId, filePath) {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastModified = Date.now();
      return;
    }

    // Verify the file exists
    let stat;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile()) return;
    } catch {
      return;
    }

    const info = this._readSessionInfo(filePath);

    const sessionInfo = {
      path: filePath,
      lastModified: Date.now(),
      registered: true,
      cwd: info.cwd || null,
    };

    this.sessions.set(sessionId, sessionInfo);

    this.emit('session:discovered', {
      sessionId,
      transcriptPath: filePath,
      cwd: info.cwd || process.cwd(),
      projectName: info.cwd ? path.basename(info.cwd) : 'codex',
      firstPrompt: info.firstPrompt || null,
      agentType: 'codex',
    });
  }

  /**
   * Read the first few JSONL lines to extract session metadata.
   * Codex format: { type: 'thread.started', thread_id: '...' }
   */
  _readSessionInfo(filePath) {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(32768);
      const bytesRead = fs.readSync(fd, buf, 0, 32768, 0);
      fs.closeSync(fd);

      const text = buf.toString('utf8', 0, bytesRead);
      const lines = text.split('\n').filter(Boolean);

      let cwd = null;
      let firstPrompt = null;

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);

          if (obj.cwd && !cwd) cwd = obj.cwd;
          if (obj.type === 'thread.started' && obj.cwd && !cwd) cwd = obj.cwd;

          if (obj.type === 'item.completed' && obj.item) {
            if (obj.item.type === 'agent_message' && !firstPrompt) {
              firstPrompt = (obj.item.text || '').slice(0, 120);
            }
          }

          if (obj.prompt && !firstPrompt) {
            firstPrompt = obj.prompt.slice(0, 120);
          }

          if (cwd && firstPrompt) break;
        } catch {
          continue;
        }
      }

      return { cwd, firstPrompt };
    } catch {
      return {};
    }
  }

  /**
   * Periodic check for sessions that went inactive.
   */
  _startIdleCheck() {
    if (this.closed) return;
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, info] of this.sessions) {
        if (!info.registered) continue;
        const elapsed = now - info.lastModified;
        if (elapsed > this.idleTimeout) {
          this.emit('session:inactive', {
            sessionId,
            transcriptPath: info.path,
          });
          this.sessions.delete(sessionId);
        }
      }
    }, this.idleCheckInterval);
  }

  /**
   * Check if a session is currently tracked.
   */
  has(sessionId) {
    return this.sessions.has(sessionId);
  }
}

module.exports = { CodexScanner };
