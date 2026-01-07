// smartOrderLearning.js - Learn from past orders to improve accuracy
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { normalizeText } = require('./utils');
const { getSheetData } = require('./googleServices');
const { getStockCache } = require('./cacheManager');

// ============================================================================
// CUSTOMER ORDER HISTORY ANALYZER
// ============================================================================

class SmartOrderLearner {
  constructor() {
    this.customerPatterns = new Map();
    this.lastLoaded = 0;
    this.CACHE_DURATION = 10 * 60 * 1000; // 10 minutes refresh for Sheet
  }

  // HELPER: Convert Map to Object for JSON saving
  _serializeMap(map) {
    return JSON.stringify(Array.from(map.entries()));
  }

  // HELPER: Convert Object back to Map for loading
  _deserializeMap(jsonStr) {
    return new Map(JSON.parse(jsonStr));
  }

  async saveCache() {
    try {
      const data = this._serializeMap(this.customerPatterns);
      await fs.writeFile(CACHE_FILE, data, 'utf8');
      Logger.info('💾 Smart memory saved to disk');
    } catch (error) {
      Logger.error('Failed to save smart cache', error);
    }
  }

  async loadCacheFromFile() {
    try {
      // Check if file exists
      await fs.access(CACHE_FILE);
      
      const data = await fs.readFile(CACHE_FILE, 'utf8');
      this.customerPatterns = this._deserializeMap(data);
      Logger.success(`📂 Loaded ${this.customerPatterns.size} customer patterns from disk`);
      return true;
    } catch (error) {
      Logger.info('No local cache found, starting fresh');
      return false;
    }
  }

  async loadOrderHistory() {
    const now = Date.now();
    
    // 1. Try loading from disk first (if empty)
    if (this.customerPatterns.size === 0) {
      await this.loadCacheFromFile();
    }

    // 2. Check if we need to refresh from Sheets (Time based)
    if (this.customerPatterns.size > 0 && (now - this.lastLoaded) < this.CACHE_DURATION) {
      return;
    }

    try {
      Logger.info('🧠 Syncing order history from Sheets...');
      
      const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
      
      if (orderRows.length <= 1) {
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
          }

          const pattern = this.customerPatterns.get(customer);
          pattern.totalOrders++;

          // Track each item
          lineItems.forEach(item => {
            const itemName = item.item;
            const key = normalizeText(itemName);
            
            // Re-map internal commonItems if it was loaded from JSON (it might be a plain object, we need to fix it)
            if (!(pattern.commonItems instanceof Map)) {
                pattern.commonItems = new Map(JSON.parse(JSON.stringify(pattern.commonItems))); 
            }

            if (!pattern.commonItems.has(key)) {
              pattern.commonItems.set(key, {
                name: itemName,
                count: 0,
                quantities: []
              });
              newLearningCount++;
            }
            
            const itemData = pattern.commonItems.get(key);
            itemData.count++;
            itemData.quantities.push(item.quantity);
          });

          // Store full order pattern
          pattern.orders.push({
            items: lineItems.map(i => ({
              item: i.item,
              quantity: i.quantity,
              unit: i.unit
            })),
            timestamp: order[1]
          });
          
          // Keep only last 20 orders per customer to save RAM
          if (pattern.orders.length > 20) pattern.orders.shift();

        } catch (parseError) {
          // Ignore bad rows
        }
      }

      this.lastLoaded = now;
      
      if (newLearningCount > 0) {
        await this.saveCache(); // SAVE TO DISK
        Logger.success(`✅ Learned/Updated patterns for ${this.customerPatterns.size} customers`);
      }

    } catch (error) {
      Logger.error('Failed to load order history', error);
    }
  }
  // ============================================================================
  // SMART MATCHING: Find customer by fuzzy name match
  // ============================================================================

  findCustomerByName(inputName) {
    if (!inputName || inputName === 'ไม่ระบุ') return null;

    const normalized = normalizeText(inputName);
    let bestMatch = null;
    let bestScore = 0;

    for (const [customer, pattern] of this.customerPatterns.entries()) {
      const score = this.calculateNameSimilarity(normalized, pattern.normalizedName);
      
      if (score > bestScore && score >= 0.7) { // 70% similarity threshold
        bestScore = score;
        bestMatch = pattern;
      }
    }

    if (bestMatch) {
      Logger.info(`🎯 Found customer match: "${inputName}" → "${bestMatch.customer}" (${(bestScore * 100).toFixed(0)}%)`);
    }

    return bestMatch;
  }

  calculateNameSimilarity(str1, str2) {
    // Simple similarity: longest common substring ratio
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

  // ============================================================================
  // PREDICT ORDER: Based on customer history
  // ============================================================================

  predictOrder(customerName, parsedItems = []) {
    const customerPattern = this.findCustomerByName(customerName);
    if (!customerPattern) return { success: false, reason: 'customer_not_found', confidence: 0 };

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
    // If items were parsed, boost confidence if they match history
    if (parsedItems && parsedItems.length > 0) {
      let matchCount = 0;
      const enhancedItems = [];

      for (const item of parsedItems) {
        const itemKey = normalizeText(item.stockItem.item);
        const historical = customerPattern.commonItems.get(itemKey);
        
        if (historical) {
          matchCount++;
          
          // Get average quantity from history
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
        return { success: false, reason: 'no_pattern_match', confidence: 'low' };
        }
      }

      const matchRate = matchCount / parsedItems.length;
      let confidence = 'low';
      
      if (matchRate >= 0.8) confidence = 'high';      // 80%+ match
      else if (matchRate >= 0.5) confidence = 'medium'; // 50%+ match

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

    return {
      success: false,
      reason: 'no_pattern_match',
      confidence: 'low'
    };
    
  }

 getMostCommonItems(customerPattern, limit = 3) {
    // Ensure Map conversion if needed (safety check)
    let itemsMap = customerPattern.commonItems;
    if (!(itemsMap instanceof Map)) itemsMap = new Map(Object.entries(itemsMap));

    const items = Array.from(itemsMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map(item => ({
        name: item.name,
        count: item.count,
        avgQuantity: Math.round(item.quantities.reduce((a, b) => a + b, 0) / item.quantities.length)
      }));
    return items;
  }
  // ============================================================================
  // FIND EXACT ORDER MATCH: Check if input matches previous order exactly
  // ============================================================================

  findExactOrderMatch(customerName, items) {
    const customerPattern = this.findCustomerByName(customerName);
    
    if (!customerPattern) return null;

    // Check recent orders (last 10)
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

    // Create normalized item maps
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

    // Check if all items match
    for (const [key, qty] of map1.entries()) {
      if (map2.get(key) !== qty) return false;
    }

    return true;
  }

  // ============================================================================
  // GET STATISTICS
  // ============================================================================

  getStats() {
    return {
      customersLearned: this.customerPatterns.size,
      totalPatterns: Array.from(this.customerPatterns.values())
        .reduce((sum, p) => sum + p.commonItems.size, 0),
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
