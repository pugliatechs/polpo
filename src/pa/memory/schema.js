/**
 * Memory SQLite schema — creates tables for conversations, memories, and FTS.
 */

/**
 * Ensure all required tables exist.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      content_type TEXT DEFAULT 'text',
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conv_chat_ts
      ON conversations (chat_id, timestamp);

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      embedding TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // FTS5 for keyword search on memories
  // Use IF NOT EXISTS by checking sqlite_master
  var hasFts = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories_fts'"
  ).get();

  if (!hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        key, content, content='memories', content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, key, content)
        VALUES (new.id, new.key, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, content)
        VALUES ('delete', old.id, old.key, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, content)
        VALUES ('delete', old.id, old.key, old.content);
        INSERT INTO memories_fts(rowid, key, content)
        VALUES (new.id, new.key, new.content);
      END;
    `);
  }
}

module.exports = { ensureSchema };
