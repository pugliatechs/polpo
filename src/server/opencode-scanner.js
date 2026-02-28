/**
 * OpencodeScanner — discovers active OpenCode sessions by polling
 * the SQLite database at ~/.local/share/opencode/opencode.db.
 *
 * Unlike Claude/Codex/Gemini scanners that use fs.watch() on session files,
 * OpenCode stores everything in SQLite, so we poll with sqlite3 CLI.
 *
 * Emits:
 *   - session:discovered  { sessionId, cwd, projectName, firstPrompt, agentType }
 *   - session:inactive    { sessionId }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const EventEmitter = require('events');

const OPENCODE_DB = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

class OpencodeScanner extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} options.pollInterval    - ms between polls (default: 5s)
   * @param {number} options.idleTimeout     - ms before marking inactive (default: 10 min)
   * @param {number} options.recentThreshold - ms for "recently active" (default: 2 min)
   * @param {string} options.dbPath          - override DB path (for testing)
   */
  constructor(options = {}) {
    super();
    this.dbPath = options.dbPath || OPENCODE_DB;
    this.pollInterval = options.pollInterval || 5000;
    this.idleTimeout = options.idleTimeout || 10 * 60 * 1000;
    this.recentThreshold = options.recentThreshold || 2 * 60 * 1000;
    this.sessions = new Map(); // sessionId -> { lastSeen, cwd }
    this.pollTimer = null;
    this.closed = false;
    this._sqlite3Available = null;
  }

  start() {
    if (!this._checkSqlite3()) return;

    // Initial scan
    this._poll();

    // Start periodic polling
    this.pollTimer = setInterval(() => {
      if (!this.closed) this._poll();
    }, this.pollInterval);
  }

  stop() {
    this.closed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  _checkSqlite3() {
    if (this._sqlite3Available !== null) return this._sqlite3Available;
    try {
      execFileSync('sqlite3', ['--version'], { stdio: 'pipe', timeout: 5000 });
      this._sqlite3Available = true;
    } catch {
      this._sqlite3Available = false;
    }
    return this._sqlite3Available;
  }

  _query(sql) {
    if (!fs.existsSync(this.dbPath)) return [];
    try {
      const output = execFileSync('sqlite3', [
        '-readonly', '-json', this.dbPath, sql,
      ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, encoding: 'utf8' });
      return JSON.parse(output || '[]');
    } catch {
      return [];
    }
  }

  _poll() {
    const now = Date.now();
    const recentISO = new Date(now - this.recentThreshold).toISOString();

    const rows = this._query(
      `SELECT id, title, directory, updated_at
       FROM session
       WHERE updated_at > '${recentISO}' AND parent_id IS NULL`
    );

    const activeSessions = new Set();

    for (const row of rows) {
      const sessionId = row.id;
      activeSessions.add(sessionId);

      const existing = this.sessions.get(sessionId);
      if (existing) {
        existing.lastSeen = now;
        continue;
      }

      // New session discovered
      this.sessions.set(sessionId, {
        lastSeen: now,
        cwd: row.directory || null,
      });

      this.emit('session:discovered', {
        sessionId,
        transcriptPath: null, // No transcript file — data is in SQLite
        cwd: row.directory || process.cwd(),
        projectName: row.directory ? path.basename(row.directory) : 'opencode',
        firstPrompt: row.title || null,
        agentType: 'opencode',
      });
    }

    // Check for sessions that went idle
    for (const [sessionId, info] of this.sessions) {
      if (now - info.lastSeen > this.idleTimeout) {
        this.emit('session:inactive', { sessionId });
        this.sessions.delete(sessionId);
      }
    }
  }

  has(sessionId) {
    return this.sessions.has(sessionId);
  }
}

module.exports = { OpencodeScanner };
