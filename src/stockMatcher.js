// stockMatcher.js - HIGH-PERFORMANCE fuzzy matching with caching

const { normalizeText } = require('./utils');
const { Logger } = require('./logger');

// ============================================================================
// PERFORMANCE-OPTIMIZED STOCK MATCHER
// ============================================================================


 class StockMatcher {
  constructor() {
    this.index = null;
    this.lastStockHash = null;
  }

  // ========================================================================
  // BUILD INVERTED INDEX (O(n) preprocessing, O(1) lookup)
  // ========================================================================
  
  buildIndex(stockCache) {
    const startTime = Date.now();
    this.keywordIndex.clear();
    
    stockCache.forEach((item, idx) => {
      const keywords = this.extractKeywords(item.item);
      
      keywords.forEach(keyword => {
        if (!this.keywordIndex.has(keyword)) {
          this.keywordIndex.set(keyword, []);
        }
        this.keywordIndex.get(keyword).push({
          idx,
          item,
          keyword
        });
      });
    });
    
    const duration = Date.now() - startTime;
    Logger.success(`🔍 Index built: ${this.keywordIndex.size} keywords in ${duration}ms`);
  }

  // ========================================================================
  // EXTRACT KEYWORDS (with Thai support)
  // ========================================================================
  
  extractKeywords(text) {
    const keywords = new Set();
    const normalized = normalizeText(text);
    
    // Add full normalized text
    keywords.add(normalized);
    
    // Add 2-character prefixes (for Thai)
    for (let i = 0; i <= normalized.length - 2; i++) {
      keywords.add(normalized.substring(i, i + 2));
    }
    
    // Add 3-character prefixes
    for (let i = 0; i <= normalized.length - 3; i++) {
      keywords.add(normalized.substring(i, i + 3));
    }
    
    // Add tokens (space-separated)
    const tokens = text.split(/\s+/);
    tokens.forEach(token => {
      const norm = normalizeText(token);
      if (norm.length >= 2) {
        keywords.add(norm);
      }
    });
    
    // Product-specific variations
    this.addVariations(normalized, keywords);
    
    return Array.from(keywords);
  }

  // ========================================================================
  // PRODUCT VARIATIONS (extensible)
  // ========================================================================
  
  addVariations(normalized, keywords) {
    const variations = {
      'นําเเข็ง': ['น้ำแข็ง', 'ice', 'แข็ง'],
      'โคก': ['โค้ก', 'coke', 'coca'],
      'เปปซี่': ['pepsi', 'เป็ปซี่'],
      'สิงห์': ['singha', 'singh'],
      'ช้าง': ['chang', 'elephant'],
      'ลีโอ': ['leo']
    };
    
    for (const [pattern, vars] of Object.entries(variations)) {
      if (normalized.includes(normalizeText(pattern))) {
        vars.forEach(v => keywords.add(normalizeText(v)));
      }
    }
  }

  // ========================================================================
  // SMART SEARCH with Caching (O(log n) average case)
  // ========================================================================
  
  search(query, options = {}) {
    const {
      priceHint = null,
      unitHint = null,
      maxResults = 10,
      minScore = 20
    } = options;
    
    // Check cache
    const cacheKey = `${query}|${priceHint}|${unitHint}`;
    if (this.searchCache.has(cacheKey)) {
      Logger.debug(`💨 Cache hit: ${query}`);
      return this.searchCache.get(cacheKey);
    }
    
    const startTime = Date.now();
    const queryKeywords = this.extractKeywords(query);
    const candidateMap = new Map();
    
    // Phase 1: Use inverted index to find candidates (O(k) where k = keywords)
    queryKeywords.forEach(keyword => {
      const matches = this.keywordIndex.get(keyword) || [];
      matches.forEach(match => {
        if (!candidateMap.has(match.idx)) {
          candidateMap.set(match.idx, {
            item: match.item,
            idx: match.idx,
            keywordMatches: 0
          });
        }
        candidateMap.get(match.idx).keywordMatches++;
      });
    });
    
    // Phase 2: Score candidates
    const scoredMatches = Array.from(candidateMap.values()).map(candidate => {
      const score = this.calculateScore(
        candidate.item,
        query,
        queryKeywords,
        candidate.keywordMatches,
        priceHint,
        unitHint
      );
      
      return {
        item: candidate.item,
        score,
        idx: candidate.idx
      };
    });
    
    // Phase 3: Filter and sort
    const results = scoredMatches
      .filter(m => m.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
    
    const duration = Date.now() - startTime;
    Logger.debug(`⚡ Search "${query}": ${results.length} results in ${duration}ms`);
    
    // Cache result
    if (this.searchCache.size >= this.maxCacheSize) {
      const firstKey = this.searchCache.keys().next().value;
      this.searchCache.delete(firstKey);
    }
    this.searchCache.set(cacheKey, results);
    
    return results;
  }

  // ========================================================================
  // SCORING ALGORITHM (weighted features)
  // ========================================================================
  
  calculateScore(item, query, queryKeywords, keywordMatches, priceHint, unitHint) {
    let score = 0;
    const itemNorm = normalizeText(item.item);
    const queryNorm = normalizeText(query);
    
    // 1. Exact match = instant win
    if (itemNorm === queryNorm) {
      return 10000;
    }
    
    // 2. Keyword overlap (O(1) thanks to preprocessing)
    score += keywordMatches * 50;
    
    // 3. Substring matches
    if (itemNorm.includes(queryNorm)) {
      score += 500;
      if (itemNorm.startsWith(queryNorm)) {
        score += 100; // Prefix bonus
      }
    } else if (queryNorm.includes(itemNorm)) {
      score += 300;
    }
    
    // 4. Common subsequence length (lightweight version)
    const lcs = this.longestCommonSubstring(itemNorm, queryNorm);
    score += lcs * 30;
    
    // 5. Price matching
    if (priceHint) {
      const priceDiff = Math.abs(item.price - priceHint);
      if (priceDiff === 0) {
        score += 300;
      } else if (priceDiff <= priceHint * 0.1) {
        score += 150;
      } else if (priceDiff <= priceHint * 0.2) {
        score += 75;
      }
    }
    
    // 6. Unit matching
    if (unitHint) {
      const itemUnit = normalizeText(item.unit || '');
      if (itemUnit.includes(unitHint) || itemNorm.includes(unitHint)) {
        score += 200;
      }
    }
    
    // 7. Length penalty (prefer specific matches)
    const lengthDiff = Math.abs(itemNorm.length - queryNorm.length);
    score -= Math.min(lengthDiff * 3, 100);
    
    // 8. Stock availability
    if (item.stock > 0) {
      score += 20;
    }
    if (item.stock > 50) {
      score += 10; // Popular items bonus
    }
    
    return Math.max(0, score);
  }

  // ========================================================================
  // OPTIMIZED LCS (O(n*m) but with early termination)
  // ========================================================================
  
  longestCommonSubstring(s1, s2) {
    if (s1.length === 0 || s2.length === 0) return 0;
    
    let maxLen = 0;
    const shorter = s1.length < s2.length ? s1 : s2;
    const longer = s1.length < s2.length ? s2 : s1;
    
    // Early termination if lengths are very different
    if (longer.length > shorter.length * 3) {
      return 0;
    }
    
    for (let i = 0; i < shorter.length; i++) {
      for (let j = 0; j < longer.length; j++) {
        let len = 0;
        while (
          i + len < shorter.length &&
          j + len < longer.length &&
          shorter[i + len] === longer[j + len]
        ) {
          len++;
        }
        if (len > maxLen) maxLen = len;
      }
    }
    
    return maxLen;
  }

  // ========================================================================
  // CLEAR CACHE
  // ========================================================================
  
  clearCache() {
    this.searchCache.clear();
    Logger.info('🗑️ Search cache cleared');
  }

  // ========================================================================
  // STATS
  // ========================================================================
  
  getStats() {
    return {
      indexSize: this.keywordIndex.size,
      cacheSize: this.searchCache.size,
      cacheHitRate: this.cacheHits / Math.max(1, this.cacheHits + this.cacheMisses)
    };
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

const stockMatcher = new StockMatcher();

// ============================================================================
// CONVENIENCE FUNCTION (backward compatible)
// ============================================================================

function fuzzyMatchStock(searchTerm, stockCache, priceHint = null, unitHint = null) {
  // Rebuild index if needed
  if (stockMatcher.keywordIndex.size === 0 && stockCache.length > 0) {
    stockMatcher.buildIndex(stockCache);
  }
  
  const results = stockMatcher.search(searchTerm, {
    priceHint,
    unitHint,
    maxResults: 10,
    minScore: 20
  });
  
  // Convert to old format
  return results.map(r => ({
    item: r.item,
    score: r.score
  }));
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  StockMatcher,
  stockMatcher,
  fuzzyMatchStock
};
