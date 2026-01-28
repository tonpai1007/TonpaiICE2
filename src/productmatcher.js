// src/productMatcher.js - Centralized product matching

const { normalizeText } = require('./utils');
const { generateWithGroq } = require('./aiServices');
const { Logger } = require('./logger');

// ============================================================================
// SHARED: Extract Keywords (ใช้ร่วมกันทั้งระบบ)
// ============================================================================
function extractProductKeywords(name) {
  const normalized = normalizeText(name);
  const keywords = new Set([normalized]);
  
  // Tokenize
  const tokens = name.split(/\s+/);
  tokens.forEach(t => {
    const norm = normalizeText(t);
    if (norm.length >= 2) keywords.add(norm);
  });
  
  // Common variations (ครั้งเดียว)
  const variations = {
    'น้ำแข็ง': ['น้ำ', 'แข็ง', 'ice'],
    'โค้ก': ['โคก', 'coke', 'coca'],
    // ... rest
  };
  
  for (const [key, vars] of Object.entries(variations)) {
    if (normalized.includes(normalizeText(key))) {
      vars.forEach(v => keywords.add(normalizeText(v)));
    }
  }
  
  return Array.from(keywords);
}

// ============================================================================
// HYBRID MATCHER
// ============================================================================

class ProductMatcher {
  constructor() {
    this.cache = new Map(); // Cache AI results
  }

  async findProduct(query, stockCache, priceHint = null) {
    // ============================================
    // TIER 1: Exact Match (0ms, Free)
    // ============================================
    const exactMatch = stockCache.find(item => 
      item.item.toLowerCase() === query.toLowerCase()
    );
    
    if (exactMatch) {
      return { item: exactMatch, confidence: 'exact', method: 'local' };
    }

    // ============================================
    // TIER 2: Smart Local Search (1-5ms, Free)
    // ============================================
    const localMatches = this.smartLocalSearch(query, stockCache, priceHint);
    
    if (localMatches.length === 1 && localMatches[0].score > 800) {
      // High confidence local match
      return { 
        item: localMatches[0].item, 
        confidence: 'high', 
        method: 'local' 
      };
    }

    if (localMatches.length > 1) {
      // Multiple candidates - check cache first
      const cacheKey = `${query}|${priceHint}`;
      
      if (this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey);
        Logger.info('💨 Cache hit');
        return cached;
      }

      // ============================================
      // TIER 3: AI Disambiguation (500ms, costs tokens)
      // ============================================
      Logger.info('🤖 Using AI for disambiguation');
      
      const aiResult = await this.aiDisambiguate(
        query, 
        localMatches.slice(0, 5), // Only send top 5
        priceHint
      );
      
      // Cache the result
      this.cache.set(cacheKey, aiResult);
      
      return aiResult;
    }

    // ============================================
    // TIER 4: AI Full Search (last resort)
    // ============================================
    return await this.aiFallback(query, stockCache);
  }

  // ================================================================
  // LOCAL SEARCH (Fast, Free, Good enough 80% of time)
  // ================================================================
  smartLocalSearch(query, stockCache, priceHint) {
    const normalized = normalizeText(query);
    
    // Use pre-built index (from stockMatcher.js)
    const candidates = stockCache.filter(item => {
      const itemNorm = normalizeText(item.item);
      
      // Fast substring check
      if (itemNorm.includes(normalized) || normalized.includes(itemNorm)) {
        return true;
      }
      
      // Price match boost
      if (priceHint && Math.abs(item.price - priceHint) < 5) {
        return true;
      }
      
      return false;
    });

    // Score and rank
    return candidates
      .map(item => ({
        item,
        score: this.calculateScore(item, query, priceHint)
      }))
      .sort((a, b) => b.score - a.score);
  }

  // ================================================================
  // AI DISAMBIGUATION (Only when needed)
  // ================================================================
  async aiDisambiguate(query, topCandidates, priceHint) {
    const prompt = `มีสินค้า ${topCandidates.length} รายการที่คล้ายกับ "${query}":

${topCandidates.map((c, i) => 
  `${i}. ${c.item.item} - ${c.item.price}฿ (score: ${c.score})`
).join('\n')}

${priceHint ? `ราคาที่ผู้ใช้บอก: ${priceHint}฿` : ''}

เลือกรายการที่ตรงที่สุด ตอบแค่เลขที่ (0-${topCandidates.length - 1})`;

    const aiResponse = await generateWithGroq(prompt, false);
    const index = parseInt(aiResponse.trim());
    
    if (index >= 0 && index < topCandidates.length) {
      return {
        item: topCandidates[index].item,
        confidence: 'ai_selected',
        method: 'ai'
      };
    }

    // AI failed - use top local result
    return {
      item: topCandidates[0].item,
      confidence: 'fallback',
      method: 'local'
    };
  }

  async aiFallback(query, stockCache) {
    // Only use this if local search completely failed
    // Send only top 10 by stock availability
    const topByStock = stockCache
      .filter(i => i.stock > 0)
      .sort((a, b) => b.stock - a.stock)
      .slice(0, 10);

    // ... AI call with minimal context
  }

  calculateScore(item, query, priceHint) {
    let score = 0;
    const itemNorm = normalizeText(item.item);
    const queryNorm = normalizeText(query);
    
    if (itemNorm === queryNorm) score += 1000;
    else if (itemNorm.includes(queryNorm)) score += 500;
    else if (queryNorm.includes(itemNorm)) score += 300;
    
    if (priceHint) {
      if (item.price === priceHint) score += 200;
      else if (Math.abs(item.price - priceHint) <= 5) score += 100;
    }
    
    if (item.stock > 0) score += 20;
    
    return score;
  }
}

module.exports = {
  extractProductKeywords,
  ProductMatcher,
  productMatcher: new ProductMatcher()
};