/**
 * GeminiScanner — discovers active Google Gemini CLI sessions by watching
 * for JSON file changes in the Gemini session directories.
 *
 * Gemini stores sessions as JSON files (not JSONL):
 *   ~/.gemini/tmp/<project-slug>/chats/session-*.json
 *
 * Project slugs are mapped in ~/.gemini/projects.json:
 *   { "projects": { "/path/to/project": "slug" } }
 *
 * Uses fs.watch() for event-driven detection.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const GEMINI_TMP_DIR = path.join(GEMINI_DIR, 'tmp');
const GEMINI_PROJECTS_FILE = path.join(GEMINI_DIR, 'projects.json');
const SESSION_FILE_PREFIX = 'session-';

class GeminiScanner extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} options.idleCheckInterval - ms between idle checks (default: 30s)
   * @param {number} options.idleTimeout       - ms of inactivity before marking disconnected (default: 10 min)
   * @param {string} options.geminiDir         - override gemini directory
   */
  constructor(options = {}) {
    super();
    this.geminiDir = options.geminiDir || GEMINI_DIR;
    this.tmpDir = options.tmpDir || GEMINI_TMP_DIR;
    this.projectsFile = options.projectsFile || GEMINI_PROJECTS_FILE;
    this.idleCheckInterval = options.idleCheckInterval || 30 * 1000;
    this.idleTimeout = options.idleTimeout || 10 * 60 * 1000;
    this.scanInterval = options.scanInterval || 2000;
    this.sessions = new Map(); // sessionId -> { path, lastModified, registered, cwd }
    this.watchers = new Map(); // dirPath -> fs.FSWatcher
    this.projectMap = new Map(); // slug -> cwd
    this.idleTimer = null;
    this.scanTimer = null;
    this.closed = false;
  }

  start() {
    // Load project mapping
    this._loadProjects();

    // Watch for new projects
    this._watchProjectsFile();

    if (!fs.existsSync(this.tmpDir)) {
      this._watchForCreation();
      return;
    }

    this._scanProjects();
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
    for (const w of this.watchers.values()) {
      w.close();
    }
    this.watchers.clear();
  }

  /**
   * Load project slug -> cwd mapping from projects.json.
   */
  _loadProjects() {
    try {
      const data = fs.readFileSync(this.projectsFile, 'utf8');
      const parsed = JSON.parse(data);
      if (parsed.projects && typeof parsed.projects === 'object') {
        for (const [cwdPath, slug] of Object.entries(parsed.projects)) {
          this.projectMap.set(slug, cwdPath);
        }
      }
    } catch {
      // File may not exist
    }
  }

  /**
   * Watch projects.json for new project additions.
   */
  _watchProjectsFile() {
    if (this.closed) return;

    try {
      if (!fs.existsSync(this.projectsFile)) {
        // Watch parent dir for projects.json creation
        if (fs.existsSync(this.geminiDir)) {
          try {
            const w = fs.watch(this.geminiDir, (_, filename) => {
              if (this.closed) return;
              if (filename === 'projects.json') {
                this._loadProjects();
                this._scanProjects();
              }
            });
            w.on('error', () => {});
            this.watchers.set('__projects_parent__', w);
          } catch (e) {
            if (e.code === 'ENOSPC') this._startPolling();
          }
        }
        return;
      }

      const w = fs.watch(this.projectsFile, () => {
        if (this.closed) return;
        this._loadProjects();
        this._scanProjects();
      });
      w.on('error', () => {});
      this.watchers.set('__projects__', w);
    } catch (e) {
      if (e.code === 'ENOSPC') this._startPolling();
    }
  }

  /**
   * Wait for the tmp directory to be created.
   */
  _watchForCreation() {
    try {
      if (!fs.existsSync(this.geminiDir)) return;

      const w = fs.watch(this.geminiDir, (_, filename) => {
        if (this.closed) return;
        if (filename === 'tmp' && fs.existsSync(this.tmpDir)) {
          w.close();
          this.watchers.delete('__creation__');
          this._scanProjects();
          this._startIdleCheck();
        }
      });
      w.on('error', () => {});
      this.watchers.set('__creation__', w);
    } catch {
      // Directory doesn't exist
    }
  }

  /**
   * Scan all known project directories for active sessions.
   */
  _scanProjects() {
    // Scan all subdirectories of tmp/ (each is a project slug)
    let entries;
    try {
      entries = fs.readdirSync(this.tmpDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      const chatsDir = path.join(this.tmpDir, slug, 'chats');
      this._watchChatsDir(chatsDir, slug);
      this._scanChatsDir(chatsDir, slug);
    }

    // Also watch tmp/ for new project directories
    this._watchDir(this.tmpDir);
  }

  /**
   * Watch the tmp directory for new project subdirectories.
   */
  _watchDir(dirPath) {
    if (this.closed || this.watchers.has(dirPath)) return;

    try {
      const watcher = fs.watch(dirPath, (_, filename) => {
        if (this.closed || !filename) return;
        const fullPath = path.join(dirPath, filename);
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            const chatsDir = path.join(fullPath, 'chats');
            this._watchChatsDir(chatsDir, filename);
            this._scanChatsDir(chatsDir, filename);
          }
        } catch {
          // File/dir disappeared
        }
      });
      watcher.on('error', () => {
        this.watchers.delete(dirPath);
      });
      this.watchers.set(dirPath, watcher);
    } catch (e) {
      if (e.code === 'ENOSPC') this._startPolling();
    }
  }

  /**
   * Watch a project's chats/ directory for session file changes.
   */
  _watchChatsDir(chatsDir, slug) {
    if (this.closed || this.watchers.has(chatsDir)) return;
    if (!fs.existsSync(chatsDir)) {
      // Watch parent for chats/ creation
      const parentDir = path.dirname(chatsDir);
      if (fs.existsSync(parentDir) && !this.watchers.has('__chats_wait_' + slug)) {
        try {
          const w = fs.watch(parentDir, (_, filename) => {
            if (this.closed) return;
            if (filename === 'chats' && fs.existsSync(chatsDir)) {
              w.close();
              this.watchers.delete('__chats_wait_' + slug);
              this._watchChatsDir(chatsDir, slug);
              this._scanChatsDir(chatsDir, slug);
            }
          });
          w.on('error', () => {});
          this.watchers.set('__chats_wait_' + slug, w);
        } catch (e) {
          if (e.code === 'ENOSPC') this._startPolling();
        }
      }
      return;
    }

    try {
      const watcher = fs.watch(chatsDir, (_, filename) => {
        if (this.closed || !filename) return;
        if (filename.startsWith(SESSION_FILE_PREFIX) && filename.endsWith('.json')) {
          const fullPath = path.join(chatsDir, filename);
          const sessionId = this._deriveSessionId(fullPath);
          this._handleSessionChange(sessionId, fullPath, slug);
        }
      });
      watcher.on('error', () => {
        this.watchers.delete(chatsDir);
      });
      this.watchers.set(chatsDir, watcher);
    } catch (e) {
      if (e.code === 'ENOSPC') this._startPolling();
    }
  }

  /**
   * Scan a chats/ directory for recently-active session files.
   */
  _scanChatsDir(chatsDir, slug) {
    let entries;
    try {
      entries = fs.readdirSync(chatsDir);
    } catch {
      return;
    }

    const now = Date.now();
    const recentThreshold = 2 * 60 * 1000; // 2 minutes

    for (const filename of entries) {
      if (!filename.startsWith(SESSION_FILE_PREFIX) || !filename.endsWith('.json')) continue;

      const fullPath = path.join(chatsDir, filename);
      const sessionId = this._deriveSessionId(fullPath);
      if (this.sessions.has(sessionId)) continue;

      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (now - stat.mtimeMs > recentThreshold) continue;

      this._handleSessionChange(sessionId, fullPath, slug);
    }
  }

  /**
   * Derive a session ID from a file path.
   */
  _deriveSessionId(filePath) {
    const basename = path.basename(filePath, '.json');
    // Strip the session- prefix to get the UUID
    return basename.startsWith(SESSION_FILE_PREFIX)
      ? basename.slice(SESSION_FILE_PREFIX.length)
      : basename;
  }

  /**
   * Handle a session file change event.
   */
  _handleSessionChange(sessionId, filePath, slug) {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastModified = Date.now();
      return;
    }

    // Verify the file exists and is valid JSON
    let stat;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile()) return;
    } catch {
      return;
    }

    const info = this._readSessionInfo(filePath, slug);

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
      projectName: info.cwd ? path.basename(info.cwd) : slug,
      firstPrompt: info.firstPrompt || null,
      agentType: 'gemini',
    });
  }

  /**
   * Read session metadata from a Gemini session JSON file.
   */
  _readSessionInfo(filePath, slug) {
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const session = JSON.parse(data);

      let cwd = this.projectMap.get(slug) || null;
      let firstPrompt = null;

      if (session.messages && Array.isArray(session.messages)) {
        for (const msg of session.messages) {
          if (msg.type === 'user' && !firstPrompt) {
            const content = this._extractContent(msg.content);
            if (content) {
              firstPrompt = content.slice(0, 120);
              break;
            }
          }
        }
      }

      return { cwd, firstPrompt };
    } catch {
      return {};
    }
  }

  /**
   * Extract text content from Gemini's PartListUnion format.
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

  /**
   * Fall back to periodic scanning when fs.watch is unavailable (ENOSPC).
   */
  _startPolling() {
    if (this.closed || this.scanTimer) return;
    this.scanTimer = setInterval(() => {
      if (this.closed) return;
      this._loadProjects();
      if (fs.existsSync(this.tmpDir)) {
        this._scanProjects();
      }
    }, this.scanInterval);
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

module.exports = { GeminiScanner };
