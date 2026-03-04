/**
 * SessionScanner — discovers active Claude Code sessions by watching
 * ~/.claude/projects/ for JSONL transcript file changes.
 *
 * Uses fs.watch() for instant, event-driven detection instead of polling.
 * A lightweight idle-check timer cleans up stale sessions.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

class SessionScanner extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} options.idleCheckInterval - ms between idle checks (default: 30s)
   * @param {number} options.idleTimeout       - ms of inactivity before marking disconnected (default: 10 min)
   * @param {string} options.projectsDir       - override projects directory
   */
  constructor(options = {}) {
    super();
    this.projectsDir = options.projectsDir || path.join(os.homedir(), '.claude', 'projects');
    this.idleCheckInterval = options.idleCheckInterval || 30 * 1000;
    this.idleTimeout = options.idleTimeout || 10 * 60 * 1000;
    this.scanInterval = options.scanInterval || 2000;
    this.sessions = new Map(); // sessionId -> { path, projectSlug, cwd, lastModified, registered }
    this.watchers = new Map(); // projectSlug -> fs.FSWatcher
    this.rootWatcher = null;
    this.creationWatcher = null;
    this.idleTimer = null;
    this.scanTimer = null;
    this.closed = false;
  }

  start() {
    if (!fs.existsSync(this.projectsDir)) {
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
   * Wait for the projects directory to be created.
   */
  _watchForCreation() {
    const parent = path.dirname(this.projectsDir);
    const basename = path.basename(this.projectsDir);
    try {
      if (!fs.existsSync(parent)) return;
      const w = fs.watch(parent, (_, filename) => {
        if (this.closed) return;
        if (filename === basename && fs.existsSync(this.projectsDir)) {
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
   * Watch the root projects directory for new project subdirectories.
   */
  _watchRoot() {
    if (this.closed) return;
    try {
      this.rootWatcher = fs.watch(this.projectsDir, (eventType, filename) => {
        if (this.closed || !filename) return;
        const projectDir = path.join(this.projectsDir, filename);
        // A new project directory appeared — start watching it
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
      // fs.watch unavailable (ENOSPC) — fall back to periodic scanning
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
      const entries = fs.readdirSync(this.projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projectDir = path.join(this.projectsDir, entry.name);
        this._watchProjectDir(projectDir, entry.name);
      }
    } catch {
      // projectsDir may have vanished
    }
  }

  /**
   * Watch a single project directory for JSONL file changes.
   */
  _watchProjectDir(projectDir, projectSlug) {
    if (this.closed || this.watchers.has(projectSlug)) return;

    // Do an initial scan of existing JSONL files
    this._scanProjectDir(projectDir, projectSlug);

    try {
      const watcher = fs.watch(projectDir, (eventType, filename) => {
        if (this.closed || !filename) return;
        if (!filename.endsWith('.jsonl')) return;

        const filePath = path.join(projectDir, filename);
        const sessionId = filename.replace('.jsonl', '');

        // Ignore subagent files (they would be in subdirectories, not caught here)
        this._handleJsonlChange(sessionId, filePath, projectSlug);
      });
      watcher.on('error', () => {
        // Directory removed — clean up
        this.watchers.delete(projectSlug);
      });
      this.watchers.set(projectSlug, watcher);
    } catch (e) {
      // fs.watch unavailable (ENOSPC) — polling fallback is handled at root level
      if (e.code === 'ENOSPC') {
        this._startPolling();
      }
    }
  }

  /**
   * Handle a JSONL file change event.
   */
  _handleJsonlChange(sessionId, filePath, projectSlug) {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastModified = Date.now();
      return;
    }

    // Verify the file exists and is a regular file
    let stat;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile()) return;
    } catch {
      return;
    }

    // New session discovered — read first line for metadata
    const info = this._readSessionInfo(filePath);

    const sessionInfo = {
      path: filePath,
      projectSlug,
      cwd: info.cwd || this._slugToCwd(projectSlug),
      lastModified: Date.now(),
      registered: true,
      version: info.version || null,
    };

    this.sessions.set(sessionId, sessionInfo);

    this.emit('session:discovered', {
      sessionId,
      transcriptPath: filePath,
      projectSlug,
      cwd: sessionInfo.cwd,
      projectName: this._extractProjectName(sessionInfo.cwd),
      firstPrompt: info.firstPrompt || null,
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
      const entries = fs.readdirSync(this.projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projectDir = path.join(this.projectsDir, entry.name);
        this._scanProjectDir(projectDir, entry.name);
      }
    } catch {
      // projectsDir may have vanished
    }
  }

  /**
   * Scan an existing project directory for active JSONL files.
   * Called once when starting to watch a project dir.
   */
  _scanProjectDir(projectDir, projectSlug) {
    let entries;
    try {
      entries = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      return;
    }

    const now = Date.now();
    // Only discover files modified very recently (within 2 min) during initial scan
    const recentThreshold = 2 * 60 * 1000;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

      const filePath = path.join(projectDir, entry.name);
      const sessionId = entry.name.replace('.jsonl', '');

      if (this.sessions.has(sessionId)) continue;

      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }

      if (now - stat.mtimeMs > recentThreshold) continue;

      this._handleJsonlChange(sessionId, filePath, projectSlug);
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
            projectSlug: info.projectSlug,
          });
          this.sessions.delete(sessionId);
        }
      }
    }, this.idleCheckInterval);
  }

  /**
   * Read the first few JSONL lines to extract session metadata (cwd, version, firstPrompt).
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
      let version = null;
      let firstPrompt = null;

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.cwd && !cwd) cwd = obj.cwd;
          if (obj.version && !version) version = obj.version;
          if (obj.type === 'user' && !firstPrompt) {
            const content = obj.message && obj.message.content;
            if (typeof content === 'string' && content.length > 0 && !content.startsWith('<')) {
              firstPrompt = content.slice(0, 120);
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && !block.text.startsWith('<')) {
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

      return { cwd, version, firstPrompt };
    } catch {
      return {};
    }
  }

  /**
   * Best-effort conversion of project slug to cwd path.
   * Slug format: -home-user-dev-project → /home/user/dev/project
   */
  _slugToCwd(slug) {
    if (!slug.startsWith('-')) return slug;
    return '/' + slug.slice(1).replace(/-/g, '/');
  }

  /**
   * Extract a short project name from the cwd path.
   */
  _extractProjectName(cwd) {
    if (!cwd) return 'unknown';
    const parts = cwd.split(path.sep).filter(Boolean);
    if (parts.length >= 2) {
      return parts.slice(-2).join('/');
    }
    return parts[parts.length - 1] || 'unknown';
  }

  /**
   * Check if a session is currently tracked.
   */
  has(sessionId) {
    return this.sessions.has(sessionId);
  }

  /**
   * Mark a session as no longer needing discovery (e.g., bridge took over).
   */
  markManaged(sessionId) {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.registered = true;
    }
  }
}

module.exports = { SessionScanner };
