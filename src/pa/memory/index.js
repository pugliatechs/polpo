/**
 * MemoryManager — persistent conversation history and user memories.
 *
 * Uses node:sqlite (built into Node 22+) with FTS5 for keyword search
 * and optional vector embeddings for semantic search.
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { ensureSchema } = require('./schema');
const { createEmbeddingProvider, cosineSimilarity } = require('./embeddings');
const { buildFtsQuery, mergeHybridResults } = require('./hybrid');

class MemoryManager {
  /**
   * @param {object} opts
   * @param {string} opts.dbPath - SQLite file path (or ':memory:')
   * @param {object} [opts.embedding] - { provider, model, apiKey }
   */
  constructor(opts) {
    this.dbPath = opts.dbPath || ':memory:';
    this.db = null;
    this.embeddingProvider = null;
    this._embeddingConfig = opts.embedding || {};
  }

  /**
   * Initialize the database and embedding provider.
   */
  init() {
    // Ensure parent directory exists for file-based DBs
    if (this.dbPath !== ':memory:') {
      var dir = path.dirname(this.dbPath);
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);
    // Enable WAL mode for better concurrent read performance
    this.db.exec('PRAGMA journal_mode=WAL');
    ensureSchema(this.db);

    this.embeddingProvider = createEmbeddingProvider(this._embeddingConfig);
  }

  // ---- Conversations ----

  /**
   * Save a conversation message.
   * @param {string} chatId
   * @param {string} role - 'user' | 'assistant' | 'system'
   * @param {string} content
   * @param {string} [contentType='text']
   */
  saveMessage(chatId, role, content, contentType) {
    this.db.prepare(
      'INSERT INTO conversations (chat_id, role, content, content_type, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(String(chatId), role, content, contentType || 'text', Date.now());
  }

  /**
   * Get recent conversation history for a chat.
   * @param {string} chatId
   * @param {number} [limit=50]
   * @returns {Array<{ role: string, content: string, content_type: string, timestamp: number }>}
   */
  getHistory(chatId, limit) {
    if (!limit) limit = 50;
    var rows = this.db.prepare(
      'SELECT role, content, content_type, timestamp FROM conversations WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(String(chatId), limit);
    // Return in chronological order
    return rows.reverse();
  }

  /**
   * Get total message count for a chat.
   * @param {string} chatId
   * @returns {number}
   */
  getMessageCount(chatId) {
    var row = this.db.prepare(
      'SELECT COUNT(*) as count FROM conversations WHERE chat_id = ?'
    ).get(String(chatId));
    return row ? row.count : 0;
  }

  /**
   * Prune old messages beyond a limit per chat.
   * @param {string} chatId
   * @param {number} keepLast - Number of most recent messages to keep
   */
  pruneHistory(chatId, keepLast) {
    this.db.prepare(
      'DELETE FROM conversations WHERE chat_id = ? AND id NOT IN (SELECT id FROM conversations WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?)'
    ).run(String(chatId), String(chatId), keepLast);
  }

  // ---- Memories ----

  /**
   * Add or update a memory entry.
   * @param {string} key - Unique identifier
   * @param {string} content - Memory content
   */
  async addMemory(key, content) {
    var now = Date.now();
    var embedding = null;

    if (this.embeddingProvider) {
      try {
        var vec = await this.embeddingProvider.embed(content);
        embedding = JSON.stringify(vec);
      } catch {
        // Proceed without embedding
      }
    }

    var existing = this.db.prepare('SELECT id FROM memories WHERE key = ?').get(key);
    if (existing) {
      this.db.prepare(
        'UPDATE memories SET content = ?, embedding = ?, updated_at = ? WHERE key = ?'
      ).run(content, embedding, now, key);
    } else {
      this.db.prepare(
        'INSERT INTO memories (key, content, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(key, content, embedding, now, now);
    }
  }

  /**
   * Remove a memory by key.
   * @param {string} key
   * @returns {boolean} true if a memory was deleted
   */
  removeMemory(key) {
    var result = this.db.prepare('DELETE FROM memories WHERE key = ?').run(key);
    return result.changes > 0;
  }

  /**
   * Get a memory by key.
   * @param {string} key
   * @returns {{ key: string, content: string, created_at: number, updated_at: number } | null}
   */
  getMemory(key) {
    return this.db.prepare(
      'SELECT key, content, created_at, updated_at FROM memories WHERE key = ?'
    ).get(key) || null;
  }

  /**
   * List all memories.
   * @param {number} [limit=100]
   * @returns {Array<{ key: string, content: string, updated_at: number }>}
   */
  listMemories(limit) {
    return this.db.prepare(
      'SELECT key, content, updated_at FROM memories ORDER BY updated_at DESC LIMIT ?'
    ).all(limit || 100);
  }

  /**
   * Search memories using hybrid vector + keyword search.
   * @param {string} query
   * @param {number} [limit=10]
   * @returns {Promise<Array<{ key: string, content: string, score: number }>>}
   */
  async search(query, limit) {
    if (!limit) limit = 10;
    var results = [];

    // Keyword search via FTS5
    var ftsQuery = buildFtsQuery(query);
    var keywordResults = [];
    if (ftsQuery) {
      try {
        keywordResults = this.db.prepare(
          'SELECT m.id, m.key, m.content, rank FROM memories_fts fts JOIN memories m ON m.id = fts.rowid WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?'
        ).all(ftsQuery, limit * 3);
      } catch {
        // FTS query may fail on certain inputs
      }
    }

    // Vector search
    var vectorResults = [];
    if (this.embeddingProvider) {
      try {
        var queryVec = await this.embeddingProvider.embed(query);
        var allMemories = this.db.prepare(
          'SELECT id, key, content, embedding FROM memories WHERE embedding IS NOT NULL'
        ).all();

        for (var i = 0; i < allMemories.length; i++) {
          var mem = allMemories[i];
          try {
            var memVec = JSON.parse(mem.embedding);
            var score = cosineSimilarity(queryVec, memVec);
            if (score > 0.1) {
              vectorResults.push({ id: mem.id, key: mem.key, content: mem.content, score: score });
            }
          } catch {
            // Skip malformed embeddings
          }
        }
      } catch {
        // Embedding failed — use keyword results only
      }
    }

    // Merge results
    if (vectorResults.length > 0 || keywordResults.length > 0) {
      var merged = mergeHybridResults({
        vector: vectorResults.map(function (r) { return { id: r.id, score: r.score }; }),
        keyword: keywordResults.map(function (r) { return { id: r.id, rank: r.rank }; }),
      });

      // Build lookup map
      var lookup = new Map();
      vectorResults.forEach(function (r) { lookup.set(r.id, r); });
      keywordResults.forEach(function (r) { if (!lookup.has(r.id)) lookup.set(r.id, r); });

      for (var j = 0; j < Math.min(merged.length, limit); j++) {
        var entry = lookup.get(merged[j].id);
        if (entry) {
          results.push({ key: entry.key, content: entry.content, score: merged[j].score });
        }
      }
    }

    return results;
  }

  /**
   * Get relevant context for a query (formatted for system prompt injection).
   * @param {string} query
   * @param {number} [limit=5]
   * @returns {Promise<string>} Formatted context string
   */
  async getRelevantContext(query, limit) {
    var results = await this.search(query, limit || 5);
    if (results.length === 0) return '';

    var lines = results.map(function (r) {
      return '- [' + r.key + '] ' + r.content;
    });
    return 'Relevant memories:\n' + lines.join('\n');
  }

  /**
   * Close the database.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = { MemoryManager };
