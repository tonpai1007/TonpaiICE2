// vectorStore.js - Simple RAG (Retrieval-Augmented Generation) system

const { normalizeText } = require('./utils');
const { Logger } = require('./logger');

// ============================================================================
// VECTOR STORE CLASS
// ============================================================================

class VectorStore {
  constructor(name = 'VectorStore') {
    this.name = name;
    this.vectors = new Map();
    this.metadata = new Map();
  }

  // Simple TF-IDF based vectorization
  vectorize(text) {
    const words = normalizeText(text).split('');
    const vector = {};
    
    words.forEach(char => {
      vector[char] = (vector[char] || 0) + 1;
    });
    
    // Normalize
    const magnitude = Math.sqrt(
      Object.values(vector).reduce((sum, val) => sum + val * val, 0)
    );
    
    Object.keys(vector).forEach(key => {
      vector[key] /= magnitude || 1;
    });
    
    return vector;
  }

  // Cosine similarity between vectors
  cosineSimilarity(vec1, vec2) {
    const keys = new Set([...Object.keys(vec1), ...Object.keys(vec2)]);
    let dotProduct = 0;
    let mag1 = 0;
    let mag2 = 0;
    
    keys.forEach(key => {
      const v1 = vec1[key] || 0;
      const v2 = vec2[key] || 0;
      dotProduct += v1 * v2;
      mag1 += v1 * v1;
      mag2 += v2 * v2;
    });
    
    return dotProduct / (Math.sqrt(mag1) * Math.sqrt(mag2)) || 0;
  }

  // Add item to vector store
  addItem(id, text, metadata = {}) {
    const vector = this.vectorize(text);
    this.vectors.set(id, vector);
    this.metadata.set(id, { text, ...metadata });
  }

  // Search similar items
  search(query, topK = 5, threshold = 0.3) {
    const queryVector = this.vectorize(query);
    const results = [];
    
    this.vectors.forEach((vector, id) => {
      const similarity = this.cosineSimilarity(queryVector, vector);
      if (similarity >= threshold) {
        results.push({
          id,
          similarity,
          metadata: this.metadata.get(id)
        });
      }
    });
    
    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  clear() {
    this.vectors.clear();
    this.metadata.clear();
    Logger.info(`${this.name} cleared`);
  }

  size() {
    return this.vectors.size;
  }

  rebuild(items, textExtractor, metadataExtractor) {
    this.clear();
    
    items.forEach((item, index) => {
      const id = `${this.name}_${index}`;
      const text = textExtractor(item);
      const metadata = metadataExtractor(item, index);
      
      this.addItem(id, text, metadata);
    });
    
    Logger.success(`${this.name} rebuilt with ${this.size()} items`);
  }
}
class ImprovedVectorStore extends VectorStore {
  
  // Better Thai text tokenization
  tokenize(text) {
    const normalized = normalizeText(text);
    
    // Character bigrams for Thai
    const bigrams = [];
    for (let i = 0; i < normalized.length - 1; i++) {
      bigrams.push(normalized.substring(i, i + 2));
    }
    
    // Word tokens
    const words = text.split(/\s+/).map(normalizeText);
    
    // Combine both
    return [...new Set([...bigrams, ...words])].filter(t => t.length >= 2);
  }
  
  vectorize(text) {
    const tokens = this.tokenize(text);
    const vector = {};
    
    tokens.forEach(token => {
      vector[token] = (vector[token] || 0) + 1;
    });
    
    // TF-IDF normalization
    const magnitude = Math.sqrt(
      Object.values(vector).reduce((sum, val) => sum + val * val, 0)
    );
    
    Object.keys(vector).forEach(key => {
      vector[key] /= magnitude || 1;
    });
    
    return vector;
  }
  
  // Enhanced search with context
  search(query, topK = 5, minThreshold = 0.5) {
    const queryVector = this.vectorize(query);
    const results = [];
    
    this.vectors.forEach((vector, id) => {
      const similarity = this.cosineSimilarity(queryVector, vector);
      
      // Apply dynamic threshold based on query length
      const adaptiveThreshold = query.length < 10 ? 0.4 : minThreshold;
      
      if (similarity >= adaptiveThreshold) {
        results.push({
          id,
          similarity,
          metadata: this.metadata.get(id)
        });
      }
    });
    
    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }
}
// ============================================================================
// GLOBAL INSTANCES
// ============================================================================

const stockVectorStore = new VectorStore('StockRAG');
const customerVectorStore = new VectorStore('CustomerRAG');

module.exports = {
  VectorStore,
  stockVectorStore,
  customerVectorStore
};
