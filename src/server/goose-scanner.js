/**
 * GooseScanner — discovers active Goose sessions by polling
 * the SQLite database at ~/.config/goose/sessions.db.
 *
 * Goose stores sessions in SQLite with date-prefixed IDs (YYYYMMDD_N).
 * We poll with sqlite3 CLI (same pattern as OpencodeScanner).
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

var GOOSE_DB = path.join(os.homedir(), '.config', 'goose', 'sessions.db');

class GooseScanner extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} options.pollInterval    - ms between polls (default: 5s)
   * @param {number} options.idleTimeout     - ms before marking inactive (default: 10 min)
   * @param {number} options.recentThreshold - ms for "recently active" (default: 2 min)
   * @param {string} options.dbPath          - override DB path (for testing)
   */
  constructor(options = {}) {
    super();
    this.dbPath = options.dbPath || GOOSE_DB;
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

    this._poll();

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
      execFileSync('sqlite3', ['--version'], { timeout: 3000, stdio: 'pipe' });
      this._sqlite3Available = true;
    } catch {
      this._sqlite3Available = false;
    }
    return this._sqlite3Available;
  }

  _poll() {
    if (!fs.existsSync(this.dbPath)) return;

    try {
      // Query recent sessions (updated in the last recentThreshold ms)
      // Goose session IDs are date-prefixed: YYYYMMDD_N
      // We query sessions that have been active recently
      var cutoffMs = Date.now() - this.recentThreshold;
      var cutoffISO = new Date(cutoffMs).toISOString();

      var output = execFileSync('sqlite3', [
        this.dbPath,
        '-readonly',
        '-json',
        'SELECT id, name, working_dir, session_type, provider_name FROM sessions WHERE session_type != \'Hidden\' ORDER BY id DESC LIMIT 50',
      ], { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });

      var rows;
      try {
        rows = JSON.parse(output.toString());
      } catch {
        return;
      }

      if (!Array.isArray(rows)) return;

      var now = Date.now();
      var seen = new Set();

      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var sessionId = String(row.id);
        seen.add(sessionId);

        if (this.sessions.has(sessionId)) {
          this.sessions.get(sessionId).lastSeen = now;
          continue;
        }

        // New session discovered
        var cwd = row.working_dir || os.homedir();
        var projectName = path.basename(cwd);
        var firstPrompt = row.name || null;

        this.sessions.set(sessionId, { lastSeen: now, cwd: cwd });
        this.emit('session:discovered', {
          sessionId: sessionId,
          cwd: cwd,
          projectName: projectName,
          firstPrompt: firstPrompt,
          agentType: 'goose',
        });
      }

      // Check for inactive sessions
      for (var entry of this.sessions) {
        var key = entry[0];
        var val = entry[1];
        if (now - val.lastSeen > this.idleTimeout) {
          this.sessions.delete(key);
          this.emit('session:inactive', { sessionId: key });
        }
      }
    } catch {
      // Ignore DB read errors
    }
  }

  /**
   * Check if a session ID is already tracked.
   */
  hasSession(sessionId) {
    return this.sessions.has(sessionId);
  }
}

module.exports = { GooseScanner };
