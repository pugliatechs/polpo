/**
 * Embedding provider abstraction — generates vector embeddings for text.
 *
 * Supports OpenAI (text-embedding-3-small) and a simple fallback
 * using character n-gram hashing for when no API key is available.
 */

/**
 * Create an embedding provider.
 * @param {object} config - { provider, model, apiKey }
 * @returns {{ embed: (text: string) => Promise<number[]>, dimensions: number }}
 */
function createEmbeddingProvider(config) {
  if (config.provider === 'openai' && config.apiKey) {
    return createOpenAIProvider(config);
  }
  // Fallback: simple hash-based embeddings (no API needed)
  return createHashProvider();
}

/**
 * OpenAI embeddings via REST API.
 */
function createOpenAIProvider(config) {
  var model = config.model || 'text-embedding-3-small';
  var apiKey = config.apiKey;
  var baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  var dimensions = 256; // Request smaller dimensions for efficiency

  return {
    dimensions: dimensions,
    embed: async function (text) {
      var response = await fetch(baseUrl + '/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          input: text.slice(0, 8000), // Limit input length
          model: model,
          dimensions: dimensions,
        }),
      });

      if (!response.ok) {
        throw new Error('Embedding failed (' + response.status + ')');
      }

      var data = await response.json();
      if (data.data && data.data[0] && data.data[0].embedding) {
        return data.data[0].embedding;
      }
      throw new Error('Unexpected embedding response format');
    },
  };
}

/**
 * Hash-based fallback embeddings — no API needed.
 * Uses character trigram hashing to produce a fixed-size vector.
 * Not as good as real embeddings but enables basic similarity search.
 */
function createHashProvider() {
  var dimensions = 128;

  return {
    dimensions: dimensions,
    embed: async function (text) {
      var vec = new Float64Array(dimensions);
      var lower = (text || '').toLowerCase();

      // Generate trigram hashes
      for (var i = 0; i < lower.length - 2; i++) {
        var trigram = lower.charCodeAt(i) * 31 * 31 +
          lower.charCodeAt(i + 1) * 31 +
          lower.charCodeAt(i + 2);
        var idx = Math.abs(trigram) % dimensions;
        vec[idx] += 1;
      }

      // L2 normalize
      var norm = 0;
      for (var j = 0; j < dimensions; j++) norm += vec[j] * vec[j];
      norm = Math.sqrt(norm) || 1;
      var result = new Array(dimensions);
      for (var k = 0; k < dimensions; k++) result[k] = vec[k] / norm;

      return result;
    },
  };
}

/**
 * Cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} Similarity in [-1, 1]
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  var dot = 0, normA = 0, normB = 0;
  for (var i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  var denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

module.exports = { createEmbeddingProvider, cosineSimilarity };
