/**
 * PiScanner — discovers active Pi coding agent sessions by watching
 * ~/.pi/agent/sessions/ for JSONL file changes.
 *
 * Pi stores sessions in project-based directories:
 *   ~/.pi/agent/sessions/--<cwd-dashes>--/<timestamp>_<uuid>.jsonl
 *
 * Directory slug format: dashes replace path separators with double-dash
 * delimiters at start/end. Example:
 *   --home-user-project-- → /home/user/project
 *
 * Uses fs.watch() for event-driven detection (same pattern as SessionScanner).
 *
 * Emits:
 *   - session:discovered  { sessionId, transcriptPath, cwd, projectName, firstPrompt, agentType }
 *   - session:inactive    { sessionId, transcriptPath }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

const PI_SESSIONS_DIR = path.join(os.homedir(), '.pi', 'agent', 'sessions');

class PiScanner extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} options.idleCheckInterval - ms between idle checks (default: 30s)
   * @param {number} options.idleTimeout       - ms of inactivity before marking disconnected (default: 10 min)
   * @param {number} options.scanInterval      - ms between polls (ENOSPC fallback, default: 2s)
   * @param {string} options.sessionsDir       - override sessions directory
   */
  constructor(options = {}) {
    super();
    this.sessionsDir = options.sessionsDir || PI_SESSIONS_DIR;
    this.idleCheckInterval = options.idleCheckInterval || 30 * 1000;
    this.idleTimeout = options.idleTimeout || 10 * 60 * 1000;
    this.scanInterval = options.scanInterval || 2000;
    this.sessions = new Map(); // sessionId -> { path, slug, lastModified, registered }
    this.watchers = new Map(); // slug -> fs.FSWatcher
    this.rootWatcher = null;
    this.creationWatcher = null;
    this.idleTimer = null;
    this.scanTimer = null;
    this.closed = false;
  }

  start() {
    if (!fs.existsSync(this.sessionsDir)) {
      this._watchForCreation();
      return;
    }

    this._watchRoot();
    this._watchExistingProjects();
    this._startIdleCheck();
  }

  stop() {
    this.closed = true;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.creationWatcher) {
      this.creationWatcher.close();
      this.creationWatcher = null;
    }
    if (this.rootWatcher) {
      this.rootWatcher.close();
      this.rootWatcher = null;
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
        // Watch grandparent for parent creation
        const grandparent = path.dirname(parent);
        if (!fs.existsSync(grandparent)) return;
        const w = fs.watch(grandparent, (_, filename) => {
          if (this.closed) return;
          if (filename === path.basename(parent) && fs.existsSync(this.sessionsDir)) {
            w.close();
            this.creationWatcher = null;
            this._watchRoot();
            this._watchExistingProjects();
            this._startIdleCheck();
          } else if (filename === path.basename(parent) && fs.existsSync(parent)) {
            w.close();
            this.creationWatcher = null;
            this._watchForCreation();
          }
        });
        w.on('error', () => {});
        this.creationWatcher = w;
        return;
      }

      const w = fs.watch(parent, (_, filename) => {
        if (this.closed) return;
        if (filename === basename && fs.existsSync(this.sessionsDir)) {
          w.close();
          this.creationWatcher = null;
          this._watchRoot();
          this._watchExistingProjects();
          this._startIdleCheck();
        }
      });
      w.on('error', () => {});
      this.creationWatcher = w;
    } catch {
      // parent dir doesn't exist
    }
  }

  /**
   * Watch the root sessions directory for new project subdirectories.
   */
  _watchRoot() {
    if (this.closed) return;
    try {
      this.rootWatcher = fs.watch(this.sessionsDir, (eventType, filename) => {
        if (this.closed || !filename) return;
        const projectDir = path.join(this.sessionsDir, filename);
        if (!this.watchers.has(filename)) {
          try {
            if (fs.statSync(projectDir).isDirectory()) {
              this._watchProjectDir(projectDir, filename);
            }
          } catch {
            // not a directory or disappeared
          }
        }
      });
      this.rootWatcher.on('error', () => {});
    } catch (e) {
      if (e.code === 'ENOSPC') {
        this._startPolling();
      }
    }
  }

  /**
   * Set up watchers on all existing project subdirectories.
   */
  _watchExistingProjects() {
    try {
      const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projectDir = path.join(this.sessionsDir, entry.name);
        this._watchProjectDir(projectDir, entry.name);
      }
    } catch {
      // sessionsDir may have vanished
    }
  }

  /**
   * Watch a single project directory for JSONL file changes.
   */
  _watchProjectDir(projectDir, slug) {
    if (this.closed || this.watchers.has(slug)) return;

    // Initial scan
    this._scanProjectDir(projectDir, slug);

    try {
      const watcher = fs.watch(projectDir, (eventType, filename) => {
        if (this.closed || !filename) return;
        if (!filename.endsWith('.jsonl')) return;

        const filePath = path.join(projectDir, filename);
        const sessionId = path.basename(filename, '.jsonl');
        this._handleJsonlChange(sessionId, filePath, slug);
      });
      watcher.on('error', () => {
        this.watchers.delete(slug);
      });
      this.watchers.set(slug, watcher);
    } catch (e) {
      if (e.code === 'ENOSPC') {
        this._startPolling();
      }
    }
  }

  /**
   * Handle a JSONL file change event.
   */
  _handleJsonlChange(sessionId, filePath, slug) {
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
    const cwd = info.cwd || this._slugToCwd(slug);

    this.sessions.set(sessionId, {
      path: filePath,
      slug,
      lastModified: Date.now(),
      registered: true,
    });

    this.emit('session:discovered', {
      sessionId,
      transcriptPath: filePath,
      cwd,
      projectName: path.basename(cwd),
      firstPrompt: info.firstPrompt || null,
      agentType: 'pi',
    });
  }

  /**
   * Fall back to periodic scanning when fs.watch is unavailable (ENOSPC).
   */
  _startPolling() {
    if (this.closed || this.scanTimer) return;
    this.scanTimer = setInterval(() => {
      if (this.closed) return;
      this._scanAllProjects();
    }, this.scanInterval);
  }

  /**
   * Scan all project directories for active JSONL files.
   */
  _scanAllProjects() {
    try {
      const entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projectDir = path.join(this.sessionsDir, entry.name);
        this._scanProjectDir(projectDir, entry.name);
      }
    } catch {
      // sessionsDir may have vanished
    }
  }

  /**
   * Scan a project directory for recently-modified JSONL files.
   */
  _scanProjectDir(projectDir, slug) {
    let entries;
    try {
      entries = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      return;
    }

    const now = Date.now();
    const recentThreshold = 2 * 60 * 1000;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

      const filePath = path.join(projectDir, entry.name);
      const sessionId = path.basename(entry.name, '.jsonl');

      if (this.sessions.has(sessionId)) continue;

      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }

      if (now - stat.mtimeMs > recentThreshold) continue;

      this._handleJsonlChange(sessionId, filePath, slug);
    }
  }

  /**
   * Read the first few JSONL lines to extract session metadata.
   * Pi format: first line is {type:"session", cwd, id}, first user message
   * is {type:"message", role:"user", content:[{type:"text", text:"..."}]}.
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

          // Session header
          if (obj.type === 'session' && obj.cwd && !cwd) {
            cwd = obj.cwd;
          }

          // First user message
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
   * Convert a Pi directory slug to a filesystem path.
   * Pi slug format: --home-user-project-- → /home/user/project
   *
   * Strips leading/trailing -- delimiters, then replaces - with /
   */
  _slugToCwd(slug) {
    if (!slug) return process.cwd();
    // Strip leading and trailing --
    let stripped = slug;
    if (stripped.startsWith('--')) stripped = stripped.slice(2);
    if (stripped.endsWith('--')) stripped = stripped.slice(0, -2);
    if (!stripped) return process.cwd();
    return '/' + stripped.replace(/-/g, '/');
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
        if (now - info.lastModified > this.idleTimeout) {
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

module.exports = { PiScanner };
