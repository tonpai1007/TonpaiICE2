// smartOrderLearning.js - FIXED: Removed filesystem dependency (not needed)
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { normalizeText } = require('./utils');
const { getSheetData } = require('./googleServices');

// ============================================================================
// CUSTOMER ORDER HISTORY ANALYZER
// ============================================================================

class SmartOrderLearner {
  constructor() {
    this.customerPatterns = new Map();
    this.lastLoaded = 0;
    this.CACHE_DURATION = 10 * 60 * 1000; // 10 minutes - refresh from Sheets
    this.predictionCache = new Map();
    this.cacheMaxAge = 5 * 60 * 1000; 
  }

  async loadOrderHistory() {
    const now = Date.now();
    
    // Check if we need to refresh from Sheets
    if (this.customerPatterns.size > 0 && (now - this.lastLoaded) < this.CACHE_DURATION) {
      return; // Use existing in-memory cache
    }

    try {
      Logger.info('🧠 Loading order history from Sheets...');
      
      const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
      
      if (orderRows.length <= 1) {
        Logger.warn('No order history found');
        return;
      }

      // Analyze last 100 orders
      const recentOrders = orderRows.slice(1).slice(-100);
      let newLearningCount = 0;

      for (const order of recentOrders) {
        const customer = (order[2] || '').trim();
        const lineItemsJson = order[7] || '[]';
        
        if (!customer || customer === 'ไม่ระบุ') continue;

        try {
          const lineItems = JSON.parse(lineItemsJson);
          
          if (!this.customerPatterns.has(customer)) {
            this.customerPatterns.set(customer, {
              customer: customer,
              normalizedName: normalizeText(customer),
              orders: [],
              commonItems: new Map(),
              totalOrders: 0
            });
            newLearningCount++;
          }

          const pattern = this.customerPatterns.get(customer);
          pattern.totalOrders++;

          // Track each item
          lineItems.forEach(item => {
            const itemName = item.item;
            const key = normalizeText(itemName);
            
            if (!pattern.commonItems.has(key)) {
              pattern.commonItems.set(key, {
                name: itemName,
                count: 0,
                quantities: []
              });
            }
            
            const itemData = pattern.commonItems.get(key);
            itemData.count++;
            itemData.quantities.push(item.quantity);
          });

          // Store full order pattern (keep last 20 per customer)
          pattern.orders.push({
            items: lineItems.map(i => ({
              item: i.item,
              quantity: i.quantity,
              unit: i.unit
            })),
            timestamp: order[1]
          });
          
          if (pattern.orders.length > 20) {
            pattern.orders.shift();
          }

        } catch (parseError) {
          // Skip invalid orders
        }
      }

      this.lastLoaded = now;
      
      if (newLearningCount > 0) {
        Logger.success(`✅ Learned patterns for ${newLearningCount} new customers`);
      }
      
      Logger.success(`📊 Total: ${this.customerPatterns.size} customers, ${this.getTotalPatterns()} patterns`);

    } catch (error) {
      Logger.error('Failed to load order history', error);
    }
  }

  // ============================================================================
  // SMART MATCHING
  // ============================================================================

  findCustomerByName(inputName) {
    if (!inputName || inputName === 'ไม่ระบุ') return null;

    const normalized = normalizeText(inputName);
    let bestMatch = null;
    let bestScore = 0;

    for (const [customer, pattern] of this.customerPatterns.entries()) {
      const score = this.calculateNameSimilarity(normalized, pattern.normalizedName);
      
      if (score > bestScore && score >= 0.7) {
        bestScore = score;
        bestMatch = pattern;
      }
    }

    if (bestMatch) {
      Logger.info(`🎯 Found customer: "${inputName}" → "${bestMatch.customer}" (${(bestScore * 100).toFixed(0)}%)`);
    }

    return bestMatch;
  }

  calculateNameSimilarity(str1, str2) {
    let longest = 0;
    const len1 = str1.length;
    const len2 = str2.length;

    for (let i = 0; i < len1; i++) {
      for (let j = 0; j < len2; j++) {
        let k = 0;
        while (i + k < len1 && j + k < len2 && str1[i + k] === str2[j + k]) {
          k++;
        }
        if (k > longest) longest = k;
      }
    }

    return longest / Math.max(len1, len2);
  }
  predictOrder(customerName, parsedItems = []) {
    const cacheKey = `${customerName}_${JSON.stringify(parsedItems.map(i => i.stockItem?.item))}`;
    const cached = this.predictionCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < this.cacheMaxAge) {
      return cached.result;
    }
    
    const result = this._predictOrderInternal(customerName, parsedItems);
    
    this.predictionCache.set(cacheKey, {
      result,
      timestamp: Date.now()
    });
    
    return result;
  }


  // ============================================================================
  // PREDICT ORDER
  // ============================================================================

  _predictOrderInternal(customerName, parsedItems) {
    const customerPattern = this.findCustomerByName(customerName);
    
    if (!customerPattern) {
      return { success: false, reason: 'customer_not_found', confidence: 0 };
    }

    // No items parsed - suggest common items
    if (!parsedItems || parsedItems.length === 0) {
      const suggestions = this.getMostCommonItems(customerPattern);
      
      if (suggestions.length > 0) {
        return {
          success: true,
          confidence: 'medium',
          reason: 'common_items_suggested',
          customer: customerPattern.customer,
          suggestedItems: suggestions,
          message: `${customerPattern.customer} มักสั่ง: ${suggestions.map(s => s.name).join(', ')}`
        };
      }
    }

    // Items parsed - check match rate
    if (parsedItems && parsedItems.length > 0) {
      let matchCount = 0;
      const enhancedItems = [];

      for (const item of parsedItems) {
        const itemKey = normalizeText(item.stockItem.item);
        const historical = customerPattern.commonItems.get(itemKey);
        
        if (historical) {
          matchCount++;
          
          const avgQty = Math.round(
            historical.quantities.reduce((a, b) => a + b, 0) / historical.quantities.length
          );
          
          enhancedItems.push({
            ...item,
            historical: true,
            orderedBefore: historical.count,
            avgQuantity: avgQty,
            suggestedQuantity: item.quantity || avgQty
          });
        } else {
          enhancedItems.push({
            ...item,
            historical: false
          });
        }
      }

      const matchRate = matchCount / parsedItems.length;
      let confidence = 'low';
      
      if (matchRate >= 0.8) confidence = 'high';
      else if (matchRate >= 0.5) confidence = 'medium';

      return {
        success: true,
        confidence: confidence,
        reason: 'historical_match',
        customer: customerPattern.customer,
        items: enhancedItems,
        matchRate: matchRate,
        totalOrders: customerPattern.totalOrders,
        message: `${customerPattern.customer} เคยสั่ง ${matchCount}/${parsedItems.length} รายการนี้ (${customerPattern.totalOrders} ครั้ง)`
      };
    }

    return { success: false, reason: 'no_pattern_match', confidence: 'low' };
  }

  getMostCommonItems(customerPattern, limit = 3) {
    const items = Array.from(customerPattern.commonItems.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map(item => ({
        name: item.name,
        count: item.count,
        avgQuantity: Math.round(
          item.quantities.reduce((a, b) => a + b, 0) / item.quantities.length
        )
      }));

    return items;
  }

  // ============================================================================
  // EXACT ORDER MATCH
  // ============================================================================

  findExactOrderMatch(customerName, items) {
    const customerPattern = this.findCustomerByName(customerName);
    if (!customerPattern) return null;

    const recentOrders = customerPattern.orders.slice(-10);

    for (const order of recentOrders) {
      if (this.ordersMatch(order.items, items)) {
        return {
          matched: true,
          confidence: 'high',
          reason: 'exact_repeat_order',
          customer: customerPattern.customer,
          items: order.items,
          message: `🎯 ตรงกับออเดอร์เดิมของ ${customerPattern.customer} เป๊ะ!`
        };
      }
    }

    return null;
  }

  ordersMatch(order1, order2) {
    if (order1.length !== order2.length) return false;

    const map1 = new Map();
    const map2 = new Map();

    order1.forEach(item => {
      const key = normalizeText(item.item);
      map1.set(key, item.quantity);
    });

    order2.forEach(item => {
      const key = normalizeText(item.stockItem?.item || item.item);
      map2.set(key, item.quantity);
    });

    for (const [key, qty] of map1.entries()) {
      if (map2.get(key) !== qty) return false;
    }

    return true;
  }

  // ============================================================================
  // STATS
  // ============================================================================

  getTotalPatterns() {
    return Array.from(this.customerPatterns.values())
      .reduce((sum, p) => sum + p.commonItems.size, 0);
  }

  getStats() {
    return {
      customersLearned: this.customerPatterns.size,
      totalPatterns: this.getTotalPatterns(),
      lastLoaded: this.lastLoaded
    };
  }
}

// Singleton instance
const smartLearner = new SmartOrderLearner();

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  smartLearner,
  SmartOrderLearner
};
