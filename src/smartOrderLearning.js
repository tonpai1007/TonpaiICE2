// smartOrderLearning.js - FIXED: Read from correct columns
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
    this.CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
    this.predictionCache = new Map();
    this.cacheMaxAge = 5 * 60 * 1000; 
  }

  async loadOrderHistory() {
    const now = Date.now();
    
    if (this.customerPatterns.size > 0 && (now - this.lastLoaded) < this.CACHE_DURATION) {
      return; 
    }

    try {
      Logger.info('🧠 Loading order history from Sheets...');
      
      // ✅ FIX: Read correct columns A-I from คำสั่งซื้อ
      const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
      
      if (!orderRows || orderRows.length <= 1) {
        Logger.warn('⚠️ No order history found in Google Sheet');
        return;
      }

      Logger.info(`📄 Found ${orderRows.length - 1} orders, analyzing...`);

      // Take last 200 orders for learning
      const recentOrders = orderRows.slice(1).slice(-200);
      let newLearningCount = 0;
      let processedOrders = 0;

      for (const order of recentOrders) {
        // ✅ FIX: Read from correct columns
        const orderNo = order[0];           // Column A: Order number
        const timestamp = order[1];         // Column B: Date/time
        const customer = (order[2] || '').trim();  // Column C: Customer
        const itemName = (order[3] || '').trim();  // Column D: Product name
        const quantity = parseInt(order[4]) || 1;  // Column E: Quantity
        const paymentStatus = order[7] || '';      // Column H: Payment status
        
        // Skip invalid rows
        if (!customer || customer === 'ไม่ระบุ' || !itemName || !orderNo) {
          continue;
        }

        try {
          // Initialize customer pattern if new
          if (!this.customerPatterns.has(customer)) {
            this.customerPatterns.set(customer, {
              customer: customer,
              normalizedName: normalizeText(customer),
              orders: [],
              commonItems: new Map(),
              totalOrders: 0,
              totalSpent: 0,
              isPaidCustomer: false
            });
            newLearningCount++;
          }

          const pattern = this.customerPatterns.get(customer);
          pattern.totalOrders++;
          
          // Track if customer pays on time
          if (paymentStatus === 'จ่ายแล้ว') {
            pattern.isPaidCustomer = true;
          }

          // ✅ FIX: Build item data from single row (not JSON array)
          const itemKey = normalizeText(itemName);
          
          if (!pattern.commonItems.has(itemKey)) {
            pattern.commonItems.set(itemKey, {
              name: itemName,
              count: 0,
              quantities: [],
              avgQuantity: 0
            });
          }
          
          const itemData = pattern.commonItems.get(itemKey);
          itemData.count++;
          itemData.quantities.push(quantity);
          
          // Calculate running average
          itemData.avgQuantity = Math.round(
            itemData.quantities.reduce((a, b) => a + b, 0) / itemData.quantities.length
          );

          // Store order history (keep last 20 per customer)
          pattern.orders.push({
            orderNo: orderNo,
            items: [{ item: itemName, quantity: quantity }],
            timestamp: timestamp
          });
          
          if (pattern.orders.length > 20) {
            pattern.orders.shift();
          }
          
          processedOrders++;
          
        } catch (parseError) {
          Logger.warn(`⚠️ Failed to process order #${orderNo}: ${parseError.message}`);
        }
      }

      this.lastLoaded = now;
      
      Logger.success(`✅ Smart Learning Complete:`);
      Logger.success(`   • ${newLearningCount} new customers learned`);
      Logger.success(`   • ${processedOrders} orders processed`);
      Logger.success(`   • ${this.customerPatterns.size} total customers in memory`);
      Logger.success(`   • ${this.getTotalPatterns()} unique product patterns`);

    } catch (error) {
      Logger.error('❌ Failed to load order history', error);
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
    
    // Limit cache size
    if (this.predictionCache.size > 100) {
      const firstKey = this.predictionCache.keys().next().value;
      this.predictionCache.delete(firstKey);
    }
    
    return result;
  }

  _predictOrderInternal(customerName, parsedItems) {
    const customerPattern = this.findCustomerByName(customerName);
    
    if (!customerPattern) {
      return { 
        success: false, 
        reason: 'customer_not_found', 
        confidence: 'none' 
      };
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
          message: `${customerPattern.customer} มักสั่ง: ${suggestions.map(s => `${s.name} (${s.avgQuantity})`).join(', ')}`
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
          
          enhancedItems.push({
            ...item,
            historical: true,
            orderedBefore: historical.count,
            avgQuantity: historical.avgQuantity,
            suggestedQuantity: item.quantity || historical.avgQuantity
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
        isPaidCustomer: customerPattern.isPaidCustomer,
        message: `${customerPattern.customer} เคยสั่ง ${matchCount}/${parsedItems.length} รายการนี้ (${customerPattern.totalOrders} ครั้ง)`
      };
    }

    return { 
      success: false, 
      reason: 'no_pattern_match', 
      confidence: 'low' 
    };
  }

  getMostCommonItems(customerPattern, limit = 5) {
    const items = Array.from(customerPattern.commonItems.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map(item => ({
        name: item.name,
        count: item.count,
        avgQuantity: item.avgQuantity
      }));

    return items;
  }

  getTotalPatterns() {
    return Array.from(this.customerPatterns.values())
      .reduce((sum, p) => sum + p.commonItems.size, 0);
  }

  getStats() {
    return {
      customersLearned: this.customerPatterns.size,
      totalPatterns: this.getTotalPatterns(),
      totalOrders: Array.from(this.customerPatterns.values())
        .reduce((sum, p) => sum + p.totalOrders, 0),
      lastLoaded: new Date(this.lastLoaded).toISOString()
    };
  }

  // ✅ NEW: Get customer insights
  getCustomerInsights(customerName) {
    const pattern = this.findCustomerByName(customerName);
    
    if (!pattern) {
      return null;
    }

    const topItems = this.getMostCommonItems(pattern, 3);
    
    return {
      customer: pattern.customer,
      totalOrders: pattern.totalOrders,
      topItems: topItems,
      isPaidCustomer: pattern.isPaidCustomer,
      uniqueProducts: pattern.commonItems.size
    };
  }
}

// Singleton instance
const smartLearner = new SmartOrderLearner();

module.exports = {
  smartLearner,
  SmartOrderLearner
};