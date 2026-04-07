/**
 * Hybrid search — merges vector similarity and BM25 keyword results.
 *
 * Ported from moltbot's hybrid search pattern.
 * Default weights: 70% vector, 30% keyword (BM25).
 */

/**
 * Build an FTS5 query from raw text.
 * Splits into words, wraps each in quotes, joins with OR.
 * @param {string} raw
 * @returns {string} FTS5 query string
 */
function buildFtsQuery(raw) {
  if (!raw) return '';
  var words = raw
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(function (w) { return w.length > 1; });
  if (words.length === 0) return '';
  return words.map(function (w) { return '"' + w + '"'; }).join(' OR ');
}

/**
 * Normalize BM25 rank to a 0-1 score.
 * FTS5 bm25() returns negative values where more negative = better match.
 * @param {number} rank - BM25 rank (negative)
 * @returns {number} Normalized score in [0, 1]
 */
function bm25RankToScore(rank) {
  // rank is negative; -20 is a strong match, 0 is no match
  return Math.max(0, Math.min(1, -rank / 20));
}

/**
 * Merge vector and keyword search results.
 *
 * @param {object} opts
 * @param {Array<{ id: number, score: number }>} opts.vector - Vector search results
 * @param {Array<{ id: number, rank: number }>} opts.keyword - FTS5 BM25 results
 * @param {number} [opts.vectorWeight=0.7] - Weight for vector scores
 * @param {number} [opts.textWeight=0.3] - Weight for keyword scores
 * @returns {Array<{ id: number, score: number }>} Merged and sorted results
 */
function mergeHybridResults(opts) {
  var vectorWeight = opts.vectorWeight != null ? opts.vectorWeight : 0.7;
  var textWeight = opts.textWeight != null ? opts.textWeight : 0.3;

  var scores = new Map();

  // Add vector scores
  if (opts.vector) {
    for (var i = 0; i < opts.vector.length; i++) {
      var v = opts.vector[i];
      var existing = scores.get(v.id) || 0;
      scores.set(v.id, existing + v.score * vectorWeight);
    }
  }

  // Add keyword scores
  if (opts.keyword) {
    for (var j = 0; j < opts.keyword.length; j++) {
      var k = opts.keyword[j];
      var kScore = bm25RankToScore(k.rank);
      var existingK = scores.get(k.id) || 0;
      scores.set(k.id, existingK + kScore * textWeight);
    }
  }

  // Sort by combined score descending
  var results = [];
  for (var entry of scores) {
    results.push({ id: entry[0], score: entry[1] });
  }
  results.sort(function (a, b) { return b.score - a.score; });

  return results;
}

module.exports = { buildFtsQuery, bm25RankToScore, mergeHybridResults };
