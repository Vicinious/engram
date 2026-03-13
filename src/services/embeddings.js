/**
 * Embeddings Service - Semantic vector embeddings for memories
 * Uses all-MiniLM-L6-v2 for 384-dimensional embeddings
 */

const { pipeline } = require('@xenova/transformers');

// Model configuration
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

// Singleton pipeline (lazy loaded)
let embedder = null;
let modelLoading = false;
let modelLoadPromise = null;

/**
 * Initialize the embedding model (lazy loaded on first use)
 */
async function getEmbedder() {
  if (embedder) return embedder;
  
  if (modelLoading) {
    return modelLoadPromise;
  }
  
  modelLoading = true;
  console.log('[embeddings] Loading model:', MODEL_NAME);
  
  modelLoadPromise = pipeline('feature-extraction', MODEL_NAME, {
    quantized: true  // Use quantized model for speed
  }).then(pipe => {
    embedder = pipe;
    console.log('[embeddings] Model loaded successfully');
    return embedder;
  });
  
  return modelLoadPromise;
}

/**
 * Generate embedding for text
 * @param {string} text - Text to embed
 * @returns {Promise<Float32Array>} - 384-dimensional embedding vector
 */
async function embed(text) {
  const pipe = await getEmbedder();
  
  // Truncate very long text (model max is ~512 tokens)
  const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
  
  const output = await pipe(truncated, {
    pooling: 'mean',
    normalize: true
  });
  
  // Return as Float32Array
  return new Float32Array(output.data);
}

/**
 * Generate embeddings for multiple texts (batch)
 * @param {string[]} texts - Array of texts to embed
 * @returns {Promise<Float32Array[]>} - Array of embedding vectors
 */
async function embedBatch(texts) {
  const pipe = await getEmbedder();
  
  const results = [];
  for (const text of texts) {
    const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
    const output = await pipe(truncated, {
      pooling: 'mean',
      normalize: true
    });
    results.push(new Float32Array(output.data));
  }
  
  return results;
}

/**
 * Compute cosine similarity between two vectors
 * @param {Float32Array} a - First vector
 * @param {Float32Array} b - Second vector
 * @returns {number} - Similarity score (0-1, higher is more similar)
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error('Vectors must have same length');
  }
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  // Vectors are already normalized, so this simplifies
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Find most similar vectors from a set
 * @param {Float32Array} query - Query vector
 * @param {Array<{id: number, vector: Float32Array}>} candidates - Candidate vectors with IDs
 * @param {number} topK - Number of results to return
 * @param {number} minScore - Minimum similarity threshold
 * @returns {Array<{id: number, score: number}>} - Sorted results
 */
function findSimilar(query, candidates, topK = 10, minScore = 0.3) {
  const scores = candidates.map(({ id, vector }) => ({
    id,
    score: cosineSimilarity(query, vector)
  }));
  
  return scores
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Serialize embedding to Buffer for SQLite storage
 * @param {Float32Array} embedding - Embedding vector
 * @returns {Buffer} - Buffer for storage
 */
function serializeEmbedding(embedding) {
  return Buffer.from(embedding.buffer);
}

/**
 * Deserialize embedding from SQLite Buffer
 * @param {Buffer} buffer - Stored buffer
 * @returns {Float32Array} - Embedding vector
 */
function deserializeEmbedding(buffer) {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}

/**
 * Check if two texts are semantically similar (for deduplication)
 * @param {string} text1 - First text
 * @param {string} text2 - Second text
 * @param {number} threshold - Similarity threshold (default 0.85)
 * @returns {Promise<boolean>} - True if similar
 */
async function areSimilar(text1, text2, threshold = 0.85) {
  const [emb1, emb2] = await embedBatch([text1, text2]);
  return cosineSimilarity(emb1, emb2) >= threshold;
}

module.exports = {
  embed,
  embedBatch,
  cosineSimilarity,
  findSimilar,
  serializeEmbedding,
  deserializeEmbedding,
  areSimilar,
  EMBEDDING_DIM,
  MODEL_NAME
};
