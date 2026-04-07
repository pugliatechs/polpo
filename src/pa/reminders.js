/**
 * Reminder service — persistent reminders with Telegram delivery.
 *
 * Stores reminders in SQLite (via the PA memory DB) and checks
 * every 30 seconds for due reminders. Delivered via Telegram.
 *
 * Supports:
 *   - Absolute times: "2026-04-08 09:00", "tomorrow 3pm"
 *   - Relative times: "in 30 minutes", "in 2 hours"
 *   - Natural language parsed by the caller (handlers.js uses the agent)
 */

/**
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} db - SQLite database
 * @param {function} onDue - Called when a reminder fires: (reminder) => void
 */
class ReminderService {
  constructor(opts) {
    this.db = opts.db;
    this.onDue = opts.onDue || function () {};
    this._timer = null;
    this._ensureTable();
  }

  _ensureTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        text TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        fired INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due
        ON reminders (fired, due_at);
    `);
  }

  /**
   * Add a reminder.
   * @param {string} chatId - Telegram chat ID
   * @param {string} text - Reminder text
   * @param {number} dueAt - Unix timestamp in ms when the reminder fires
   * @returns {{ id: number, text: string, dueAt: number }}
   */
  add(chatId, text, dueAt) {
    var now = Date.now();
    if (dueAt <= now) {
      throw new Error('Due time must be in the future');
    }
    var result = this.db.prepare(
      'INSERT INTO reminders (chat_id, text, due_at, created_at) VALUES (?, ?, ?, ?)'
    ).run(String(chatId), text, dueAt, now);
    return { id: Number(result.lastInsertRowid), text: text, dueAt: dueAt };
  }

  /**
   * List pending (unfired) reminders for a chat.
   * @param {string} chatId
   * @returns {Array<{ id: number, text: string, due_at: number }>}
   */
  list(chatId) {
    return this.db.prepare(
      'SELECT id, text, due_at FROM reminders WHERE chat_id = ? AND fired = 0 ORDER BY due_at ASC'
    ).all(String(chatId));
  }

  /**
   * Remove a reminder by ID.
   * @param {number} id
   * @returns {boolean}
   */
  remove(id) {
    var result = this.db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * Check for and fire due reminders.
   */
  _checkDue() {
    var now = Date.now();
    var due = this.db.prepare(
      'SELECT id, chat_id, text, due_at FROM reminders WHERE fired = 0 AND due_at <= ? ORDER BY due_at ASC LIMIT 20'
    ).all(now);

    for (var i = 0; i < due.length; i++) {
      var reminder = due[i];
      // Mark as fired first (prevents double-firing on slow callback)
      this.db.prepare('UPDATE reminders SET fired = 1 WHERE id = ?').run(reminder.id);
      try {
        this.onDue(reminder);
      } catch (err) {
        console.error('[pa-reminders] Delivery error:', err.message);
      }
    }
  }

  /**
   * Start the polling timer.
   */
  start() {
    if (this._timer) return;
    var self = this;
    // Check every 30 seconds
    this._timer = setInterval(function () {
      try { self._checkDue(); } catch (err) {
        console.error('[pa-reminders] Check error:', err.message);
      }
    }, 30000);
    // Also check immediately
    try { this._checkDue(); } catch {}
  }

  /**
   * Stop the polling timer.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Clean up old fired reminders (older than 7 days).
   */
  cleanup() {
    var cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    this.db.prepare('DELETE FROM reminders WHERE fired = 1 AND due_at < ?').run(cutoff);
  }
}

/**
 * Parse simple relative time strings into milliseconds from now.
 * Supports: "in 5 minutes", "in 2 hours", "in 1 day", "30m", "2h", "1d"
 * @param {string} input
 * @returns {number|null} Timestamp in ms, or null if unparseable
 */
function parseRelativeTime(input) {
  if (!input) return null;
  var lower = input.toLowerCase().trim();

  // "in N unit" pattern
  var match = lower.match(/^(?:in\s+)?(\d+)\s*(m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?|d(?:ays?)?|s(?:ec(?:ond)?s?)?)$/);
  if (match) {
    var n = parseInt(match[1], 10);
    var unit = match[2].charAt(0);
    var ms = 0;
    if (unit === 's') ms = n * 1000;
    else if (unit === 'm') ms = n * 60 * 1000;
    else if (unit === 'h') ms = n * 60 * 60 * 1000;
    else if (unit === 'd') ms = n * 24 * 60 * 60 * 1000;
    if (ms > 0) return Date.now() + ms;
  }

  // Try native Date.parse for absolute times
  var parsed = Date.parse(input);
  if (!isNaN(parsed) && parsed > Date.now()) {
    return parsed;
  }

  return null;
}

/**
 * Format a timestamp as a human-readable relative time.
 * @param {number} ms - Timestamp in ms
 * @returns {string}
 */
function formatDueTime(ms) {
  var diff = ms - Date.now();
  if (diff <= 0) return 'now';
  if (diff < 60000) return Math.round(diff / 1000) + 's';
  if (diff < 3600000) return Math.round(diff / 60000) + 'min';
  if (diff < 86400000) {
    var h = Math.floor(diff / 3600000);
    var m = Math.round((diff % 3600000) / 60000);
    return h + 'h' + (m > 0 ? ' ' + m + 'min' : '');
  }
  var d = Math.floor(diff / 86400000);
  return d + 'd';
}

module.exports = { ReminderService, parseRelativeTime, formatDueTime };
