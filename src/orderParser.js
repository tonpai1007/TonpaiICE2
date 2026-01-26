// src/orderParser.js - IMPROVED: Keyword-based structure for voice input
const { Logger } = require('./logger');
const { generateWithGroq } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');
const { normalizeText } = require('./utils');

// ============================================================================
// KEYWORD-BASED PARSER - Voice-Optimized Structure
// ============================================================================

/**
 * Parse with explicit keywords for better voice recognition:
 * Format: "[ลูกค้า] ชื่อ [สั่ง] สินค้า [ราคา] XX [จำนวน] YY [ส่งโดย] ผู้ส่ง [จ่ายแล้ว]"
 * 
 * Examples:
 * - "ลูกค้า คุณสมชาย สั่ง น้ำแข็งหลอด ราคา 60 จำนวน 2"
 * - "ลูกค้า ร้านอาหาร สั่ง โค้ก 30 จำนวน 5 ส่งโดย พี่แดง"
 * - "ลูกค้า คุณนิด สั่ง เบียร์สิงห์ 50 จำนวน 10 จ่ายแล้ว"
 */
function parseWithKeywords(text) {
  const lower = text.toLowerCase();
  const result = {
    customer: null,
    items: [],
    deliveryPerson: null,
    isPaid: false,
    confidence: 'low',
    method: 'keyword'
  };

  // ========================================================================
  // 1. EXTRACT CUSTOMER - Keywords: "ลูกค้า", "customer"
  // ========================================================================
  
  const customerPatterns = [
    /ลูกค้า\s+([^สั่ง]+?)(?=\s*สั่ง|\s*$)/i,
    /customer\s+([^order]+?)(?=\s*order|\s*สั่ง|\s*$)/i,
    /^([ก-๙]+)\s+สั่ง/i // Fallback: "ชื่อ สั่ง..."
  ];

  for (const pattern of customerPatterns) {
    const match = text.match(pattern);
    if (match) {
      result.customer = match[1].trim();
      Logger.info(`✅ Customer found: "${result.customer}"`);
      break;
    }
  }

  // ========================================================================
  // 2. EXTRACT ITEMS - Keywords: "สั่ง", "order", "เอา"
  // ========================================================================
  
  // Find the section between "สั่ง" and optional keywords like "ส่งโดย", "จ่าย"
  const orderSection = extractOrderSection(text);
  
  if (orderSection) {
    Logger.info(`📦 Order section: "${orderSection}"`);
    result.items = parseItemsFromSection(orderSection);
  }

  // ========================================================================
  // 3. EXTRACT DELIVERY - Keywords: "ส่งโดย", "ส่ง", "delivery"
  // ========================================================================
  
  const deliveryPatterns = [
    /ส่งโดย\s+([^\s,]+)/i,
    /ส่ง\s+([^\s,]+)/i,
    /delivery\s+([^\s,]+)/i
  ];

  for (const pattern of deliveryPatterns) {
    const match = text.match(pattern);
    if (match) {
      result.deliveryPerson = match[1].trim();
      Logger.info(`🚚 Delivery: "${result.deliveryPerson}"`);
      break;
    }
  }

  // ========================================================================
  // 4. EXTRACT PAYMENT - Keywords: "จ่ายแล้ว", "ชำระแล้ว", "paid"
  // ========================================================================
  
  if (/จ่ายแล้ว|ชำระแล้ว|paid|เงินสด/i.test(text)) {
    result.isPaid = true;
    Logger.info(`💰 Payment: PAID`);
  }

  // Calculate confidence
  result.confidence = calculateKeywordConfidence(result);

  return result;
}

// ============================================================================
// HELPER: Extract order section between keywords
// ============================================================================

function extractOrderSection(text) {
  // Pattern: Everything between "สั่ง" and ("ส่งโดย" OR "จ่าย" OR end)
  const patterns = [
    /สั่ง\s+(.+?)(?=\s*ส่งโดย|\s*ส่ง\s+[ก-๙]|\s*จ่าย|\s*$)/i,
    /order\s+(.+?)(?=\s*delivery|\s*paid|\s*$)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

// ============================================================================
// HELPER: Parse items from order section
// ============================================================================

function parseItemsFromSection(section) {
  const items = [];
  
  // Split by common delimiters: comma, "และ", "กับ"
  const parts = section.split(/,|และ|กับ|\n/);
  
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const item = parseIndividualItem(trimmed);
    if (item) {
      items.push(item);
    }
  }

  return items;
}

// ============================================================================
// HELPER: Parse individual item
// Format: "สินค้า [ราคา] XX [จำนวน] YY" or "สินค้า XX YY"
// ============================================================================

function parseIndividualItem(text) {
  Logger.info(`🔍 Parsing item: "${text}"`);
  
  // Pattern 1: "สินค้า ราคา 60 จำนวน 2"
  let match = text.match(/(.+?)\s+ราคา\s+(\d+)\s+จำนวน\s+(\d+)/i);
  if (match) {
    return {
      productName: match[1].trim(),
      price: parseInt(match[2]),
      quantity: parseInt(match[3]),
      pattern: 'explicit_keywords'
    };
  }

  // Pattern 2: "สินค้า 60 2" (price quantity)
  match = text.match(/(.+?)\s+(\d+)\s+(\d+)/);
  if (match) {
    const num1 = parseInt(match[2]);
    const num2 = parseInt(match[3]);
    
    // Logic: larger number is usually price
    if (num1 > num2 && num1 > 10) {
      return {
        productName: match[1].trim(),
        price: num1,
        quantity: num2,
        pattern: 'price_first'
      };
    } else if (num2 > num1 && num2 > 10) {
      return {
        productName: match[1].trim(),
        price: num2,
        quantity: num1,
        pattern: 'quantity_first'
      };
    }
  }

  // Pattern 3: "สินค้า จำนวน 5" (no price)
  match = text.match(/(.+?)\s+จำนวน\s+(\d+)/i);
  if (match) {
    return {
      productName: match[1].trim(),
      price: null,
      quantity: parseInt(match[2]),
      pattern: 'quantity_only'
    };
  }

  // Pattern 4: Just "สินค้า" (no numbers)
  if (!/\d/.test(text)) {
    return {
      productName: text.trim(),
      price: null,
      quantity: 1,
      pattern: 'name_only'
    };
  }

  Logger.warn(`⚠️ Could not parse item: "${text}"`);
  return null;
}

// ============================================================================
// HELPER: Calculate confidence based on keyword matches
// ============================================================================

function calculateKeywordConfidence(result) {
  let score = 0;

  if (result.customer && result.customer !== 'ไม่ระบุ') score += 25;
  if (result.items.length > 0) score += 30;
  if (result.items.every(i => i.price !== null)) score += 25;
  if (result.items.every(i => i.quantity > 0)) score += 10;
  if (result.deliveryPerson) score += 5;
  if (result.isPaid !== undefined) score += 5;

  if (score >= 80) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

// ============================================================================
// STOCK MATCHING - Improved fuzzy search
// ============================================================================

function fuzzyMatchStockItem(productName, price, stockCache) {
  const normalized = normalizeText(productName);
  const candidates = [];

  // Score each stock item
  for (let i = 0; i < stockCache.length; i++) {
    const stock = stockCache[i];
    const stockNorm = normalizeText(stock.item);
    let score = 0;

    // Name similarity
    if (stockNorm.includes(normalized)) score += 50;
    if (normalized.includes(stockNorm)) score += 40;
    
    // Token overlap
    const productTokens = productName.split(/\s+/).map(t => normalizeText(t));
    const stockTokens = stock.item.split(/\s+/).map(t => normalizeText(t));
    const overlap = productTokens.filter(t => stockTokens.includes(t)).length;
    score += overlap * 15;

    // Price match
    if (price !== null) {
      if (stock.price === price) {
        score += 100; // Exact price match is huge bonus
      } else if (Math.abs(stock.price - price) <= price * 0.1) {
        score += 50; // Within 10%
      }
    }

    // Stock availability
    if (stock.stock > 0) score += 5;

    if (score > 0) {
      candidates.push({ stock, score, index: i });
    }
  }

  // Sort by score
  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    Logger.warn(`❌ No match found for: "${productName}"`);
    return null;
  }

  // Check if top match is clear winner
  if (candidates.length >= 2) {
    const scoreDiff = candidates[0].score - candidates[1].score;
    if (scoreDiff < 30) {
      Logger.warn(`⚠️ Ambiguous match for "${productName}": ${candidates[0].stock.item} vs ${candidates[1].stock.item}`);
      return {
        ambiguous: true,
        matches: candidates.slice(0, 5).map(c => c.stock)
      };
    }
  }

  Logger.success(`✅ Matched "${productName}" → ${candidates[0].stock.item} (score: ${candidates[0].score})`);
  
  return {
    ambiguous: false,
    stock: candidates[0].stock,
    index: candidates[0].index,
    score: candidates[0].score
  };
}

// ============================================================================
// MAIN PARSE ORDER - Hybrid approach
// ============================================================================

async function parseOrder(userInput) {
  const stockCache = getStockCache();
  const customerCache = getCustomerCache();

  Logger.info(`🎯 Parsing: "${userInput}"`);

  // Step 1: Try keyword-based parsing first
  const keywordResult = parseWithKeywords(userInput);

  // Step 2: Map items to stock
  const mappedItems = [];
  const ambiguousItems = [];

  for (const item of keywordResult.items) {
    const matchResult = fuzzyMatchStockItem(
      item.productName,
      item.price,
      stockCache
    );

    if (!matchResult) {
      // No match found
      continue;
    }

    if (matchResult.ambiguous) {
      ambiguousItems.push({
        keyword: item.productName,
        quantity: item.quantity,
        possibleMatches: matchResult.matches
      });
    } else {
      mappedItems.push({
        stockItem: matchResult.stock,
        quantity: item.quantity,
        matchConfidence: matchResult.score >= 100 ? 'exact' : 
                        matchResult.score >= 50 ? 'high' : 'medium'
      });
    }
  }

  // Step 3: Handle disambiguation
  if (ambiguousItems.length > 0) {
    return [{
      intent: 'disambiguation',
      customer: keywordResult.customer || 'ไม่ระบุ',
      ambiguousItems: ambiguousItems,
      confidence: 'low'
    }];
  }

  // Step 4: Check if we have valid items
  if (mappedItems.length === 0) {
    Logger.warn('⚠️ No items matched');
    return [{
      success: false,
      error: 'ไม่พบสินค้าที่ต้องการสั่ง',
      suggestion: 'ลองพิมพ์: "ลูกค้า [ชื่อ] สั่ง [สินค้า] ราคา [XX] จำนวน [YY]"'
    }];
  }

  // Step 5: Build result
  const result = {
    intent: 'order',
    customer: keywordResult.customer || 'ไม่ระบุ',
    items: mappedItems,
    isPaid: keywordResult.isPaid,
    deliveryPerson: keywordResult.deliveryPerson || '',
    confidence: keywordResult.confidence,
    rawInput: userInput,
    method: 'keyword_based'
  };

  Logger.success(`✅ Parsed order:
  Customer: ${result.customer}
  Items: ${result.items.length}
  Payment: ${result.isPaid ? 'PAID' : 'UNPAID'}
  Delivery: ${result.deliveryPerson || 'None'}`);

  return [result];
}

// ============================================================================
// FALLBACK: Simple extraction for testing
// ============================================================================

function extractProductKeywords(productName) {
  const keywords = new Set();
  const normalized = normalizeText(productName);
  
  keywords.add(normalized);
  
  const tokens = productName.split(/\s+/);
  tokens.forEach(token => {
    const norm = normalizeText(token);
    if (norm.length >= 2) {
      keywords.add(norm);
    }
  });
  
  const variations = {
    'น้ำแข็ง': ['ice', 'แข็ง'],
    'หลอด': ['tube'],
    'โค้ก': ['coke', 'coca'],
    'เป๊ปซี่': ['pepsi'],
    'สิงห์': ['singha'],
    'ช้าง': ['chang'],
    'ลีโอ': ['leo']
  };
  
  for (const [key, vars] of Object.entries(variations)) {
    if (normalized.includes(normalizeText(key))) {
      vars.forEach(v => keywords.add(normalizeText(v)));
    }
  }
  
  return Array.from(keywords);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  parseOrder,
  parseWithKeywords,
  fuzzyMatchStockItem,
  extractProductKeywords,
  parseItemsFromSection,
  parseIndividualItem
};
