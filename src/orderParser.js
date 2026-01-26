// src/orderParser.js - FIXED: Add missing extractProductKeywords function
const { Logger } = require('./logger');
const { generateWithGroq } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');
const { normalizeText } = require('./utils');

// ============================================================================
// MISSING FUNCTION - Add this at the top after imports
// ============================================================================

/**
 * Extract product keywords for matching
 * Similar to extractStockKeywords in stockAdjustment.js
 */
function extractProductKeywords(productName) {
  const keywords = new Set();
  const normalized = normalizeText(productName);
  
  // Add full normalized text
  keywords.add(normalized);
  
  // Tokenize by space
  const tokens = productName.split(/\s+/);
  tokens.forEach(token => {
    const norm = normalizeText(token);
    if (norm.length >= 2) {
      keywords.add(norm);
    }
  });
  
  // Common product variations (Thai products)
  const variations = {
    'น้ำแข็ง': ['นําเเข็ง', 'น้ำเเข็ง', 'ice', 'แข็ง', 'นํา'],
    'หลอด': ['tube', 'ท่อ'],
    'แผ่น': ['sheet', 'เเผ่น'],
    'บด': ['crushed', 'บด'],
    'ถุง': ['bag', 'ถุง', 'กระสอบ'],
    'โค้ก': ['coke', 'โค', 'coca', 'โคก'],
    'เป็ปซี่': ['pepsi', 'เป๊ปซี่', 'เปปซี่'],
    'น้ำดื่ม': ['water', 'น้ำ', 'drinking', 'นํา'],
    'ลัง': ['box', 'case', 'รัง', 'ลัง', 'crate'],
    'แพ็ค': ['pack', 'แพค', 'แพ็ค', 'โหล'],
    'สิงห์': ['singha', 'singh', 'singห์'],
    'ช้าง': ['chang', 'elephant'],
    'ลีโอ': ['leo'],
    'เบียร์': ['beer', 'เบีย']
  };
  
  for (const [key, vars] of Object.entries(variations)) {
    if (normalized.includes(normalizeText(key))) {
      vars.forEach(v => keywords.add(normalizeText(v)));
    }
  }
  
  return Array.from(keywords);
}

// ============================================================================
// PRE-PROCESS: แยกคำสั่งหลายแบบออกจากกัน
// ============================================================================

function splitMultipleIntents(text) {
  const lower = text.toLowerCase();
  
  // ✅ FIX: Define paidKeywords at the top
  const paidKeywords = /จ่าย(?:แล้ว|เงิน)|ชำระ(?:แล้ว|เงิน)|โอน(?:แล้ว|เงิน)|เงินสด/i;
  
  // ============================================================================
  // INTENT DETECTION FLAGS
  // ============================================================================
  
  const intents = {
    hasOrder: false,
    hasPayment: false,
    hasDelivery: false,
    hasCredit: false
  };
  
  // Order keywords
  if (/สั่ง|ซื้อ|เอา|ขอ|จอง/.test(lower)) {
    intents.hasOrder = true;
  }
  
  // Payment keywords
  const hasExplicitPaid = /จ่าย(?:แล้ว|เงิน)|ชำระ(?:แล้ว)|โอนแล้ว/i.test(text);
  const hasExplicitUnpaid = /เครดิต|ค้าง|ยังไม่จ่าย/i.test(text);

  if (hasExplicitPaid) {
    intents.paymentStatus = 'paid';
  } else if (hasExplicitUnpaid) {
    intents.paymentStatus = 'unpaid';
  } else {
    intents.paymentStatus = null;
  }
  
  // Delivery keywords
  if (/ส่ง|จัดส่ง|delivery|ผู้ส่ง/.test(lower)) {
    intents.hasDelivery = true;
  }
  
  // ============================================================================
  // ✅ FIX: BETTER PATTERNS - Voice-Optimized
  // ============================================================================
  
  const patterns = [
    // Pattern 1: "ส่งโดย X" or "โดย X ส่ง" - Extract delivery person FIRST
    {
      regex: /ส่ง(?:โดย|ให้)\s+(\S+)|(?:โดย|ให้)\s+(\S+)\s*ส่ง/i,
      extract: (match, fullText) => {
        const deliveryPerson = (match[1] || match[2] || '').trim();
        
        // Remove delivery part to get clean items
        const cleanText = fullText
          .replace(/ส่ง(?:โดย|ให้)\s+\S+/gi, '')
          .replace(/(?:โดย|ให้)\s+\S+\s*ส่ง/gi, '')
          .trim();
        
        // Now extract customer and items
        const orderMatch = cleanText.match(/((?:คุณ|พี่|น้อง|เจ๊|ร้าน)\s*\S+)\s*(?:สั่ง|เอา)\s+(.+)/i);
        
        if (orderMatch) {
          return {
            customer: orderMatch[1].trim(),
            itemsPart: orderMatch[2].trim(),
            deliveryPerson: deliveryPerson,
            hasPaid: paidKeywords.test(fullText),
            hasDelivery: true,
            confidence: 'high',
            pattern: 'delivery_extracted'
          };
        }
        
        // No clear customer - use first word before "สั่ง"
        const fallbackMatch = cleanText.match(/(\S+)\s*(?:สั่ง|เอา)\s+(.+)/i);
        if (fallbackMatch) {
          return {
            customer: fallbackMatch[1].trim(),
            itemsPart: fallbackMatch[2].trim(),
            deliveryPerson: deliveryPerson,
            hasPaid: paidKeywords.test(fullText),
            hasDelivery: true,
            confidence: 'medium',
            pattern: 'delivery_extracted_fallback'
          };
        }
        
        return null;
      }
    },
    
    // Pattern 2: "[Customer] สั่ง [items] จ่ายแล้ว ส่ง[person]"
    {
      regex: /((?:คุณ|พี่|น้อง|เจ๊|ร้าน)\s*\S+)\s*(?:สั่ง|เอา)\s+(.+)/i,
      extract: (match, fullText) => {
        const customer = match[1].trim();
        let itemsPart = match[2].trim();
        
        // Extract delivery person from items part
        let deliveryPerson = '';
        const deliveryMatch = itemsPart.match(/ส่ง(?:โดย|ให้)?\s*(\S+)|(?:โดย|ให้)\s*(\S+)\s*ส่ง/i);
        
        if (deliveryMatch) {
          deliveryPerson = (deliveryMatch[1] || deliveryMatch[2] || '').trim();
          // Remove delivery info from items
          itemsPart = itemsPart
            .replace(/ส่ง(?:โดย|ให้)?\s*\S+/gi, '')
            .replace(/(?:โดย|ให้)\s*\S+\s*ส่ง/gi, '')
            .trim();
        }
        
        return {
          customer,
          itemsPart,
          deliveryPerson,
          hasPaid: paidKeywords.test(fullText),
          hasDelivery: deliveryPerson !== '',
          confidence: 'high',
          pattern: 'customer_first'
        };
      }
    },
    
    // Pattern 3: Simple "[word] สั่ง [items]" - Could be customer OR product
    {
      regex: /(\S+)\s*(?:สั่ง|เอา)\s+(.+)/i,
      extract: (match, fullText) => {
        const firstWord = match[1].trim();
        let itemsPart = match[2].trim();
        
        // Extract delivery
        let deliveryPerson = '';
        const deliveryMatch = itemsPart.match(/ส่ง(?:โดย|ให้)?\s*(\S+)|(?:โดย|ให้)\s*(\S+)\s*ส่ง/i);
        
        if (deliveryMatch) {
          deliveryPerson = (deliveryMatch[1] || deliveryMatch[2] || '').trim();
          itemsPart = itemsPart
            .replace(/ส่ง(?:โดย|ให้)?\s*\S+/gi, '')
            .replace(/(?:โดย|ให้)\s*\S+\s*ส่ง/gi, '')
            .trim();
        }
        
        // ✅ FIX: Check if firstWord is likely a product name
        const productKeywords = ['น้ำแข็ง', 'โค้ก', 'เป๊ปซี่', 'สิงห์', 'ช้าง', 'น้ำ', 'เบียร์'];
        const isLikelyProduct = productKeywords.some(kw => firstWord.includes(kw));
        
        if (isLikelyProduct) {
          // "กาแฟ สั่ง น้ำแข็ง" → กาแฟ is PRODUCT, not customer
          // Put it back into items
          return {
            customer: 'ไม่ระบุ',
            itemsPart: `${firstWord} ${itemsPart}`.trim(),
            deliveryPerson,
            hasPaid: paidKeywords.test(fullText),
            hasDelivery: deliveryPerson !== '',
            confidence: 'low',
            pattern: 'product_first_detected'
          };
        }
        
        return {
          customer: firstWord,
          itemsPart,
          deliveryPerson,
          hasPaid: paidKeywords.test(fullText),
          hasDelivery: deliveryPerson !== '',
          confidence: 'medium',
          pattern: 'simple_order'
        };
      }
    }
  ];
  
  // ============================================================================
  // TRY PATTERNS IN ORDER
  // ============================================================================
  
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) {
      const extracted = pattern.extract(match, text);
      
      // Validate extraction
      if (extracted && extracted.itemsPart) {
        Logger.info(`🎯 Pattern matched: ${extracted.pattern}`);
        Logger.info(`   Customer: ${extracted.customer}`);
        Logger.info(`   Items: ${extracted.itemsPart}`);
        Logger.info(`   Payment: ${extracted.hasPaid ? 'PAID' : 'UNPAID'}`);
        Logger.info(`   Delivery: ${extracted.deliveryPerson || 'None'}`);
        
        return {
          ...extracted,
          type: 'order',
          intents: {
            ...intents,
            hasOrder: true,
            hasPayment: extracted.hasPaid !== undefined,
            hasDelivery: extracted.hasDelivery
          }
        };
      }
    }
  }
  
  return null;
}

// ============================================================================
// PAYMENT STATUS DETECTOR (More Robust)
// ============================================================================

function detectPaymentStatus(text) {
  const lower = text.toLowerCase();
  
  // Explicit unpaid
  if (/เครดิต|ค้าง(?:ชำระ)?|ยังไม่จ่าย|เอาไว้ก่อน/.test(lower)) {
    return { status: 'unpaid', confidence: 'high' };
  }
  
  // Explicit paid
  if (/จ่าย(?:แล้ว|เงิน)|ชำระ(?:แล้ว|เงิน)|เงินสด|โอน(?:แล้ว|เงิน)/.test(lower)) {
    return { status: 'paid', confidence: 'high' };
  }
  
  // Ambiguous - check position
  if (/จ่าย|ชำระ/.test(lower)) {
    // If "จ่าย" is near end of sentence → likely paid
    const paymentIndex = text.search(/จ่าย|ชำระ/);
    const nearEnd = paymentIndex > text.length * 0.6;
    
    return { 
      status: nearEnd ? 'paid' : 'unpaid', 
      confidence: 'medium' 
    };
  }
  
  return { status: null, confidence: 'none' };
}

// ============================================================================
// DELIVERY PERSON EXTRACTOR
// ============================================================================

function extractDeliveryPerson(text) {
  const patterns = [
    /ส่ง\s*(พี่|คุณ|น้อง)?\s*(\S+)/i,
    /จัดส่ง\s*(พี่|คุณ|น้อง)?\s*(\S+)/i,
    /(?:ให้|ใช้)\s*(พี่|คุณ|น้อง)?\s*(\S+)\s*ส่ง/i
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return {
        name: match[0].replace(/ส่ง|จัดส่ง/g, '').trim(),
        confidence: 'high'
      };
    }
  }
  
  return { name: null, confidence: 'none' };
}

// ============================================================================
// ENHANCED: ดึง Price Hints ที่แม่นยำขึ้น
// ============================================================================

function extractPriceHints(text) {
  const hints = [];
  
  // Pattern 1: "ราคา X บาท" หรือ "X บาท"
  const explicitMatches = text.matchAll(/([ก-๙a-z0-9\.\-\(\)]+)\s+(?:ราคา\s+)?(\d+)\s*(?:บาท|฿)/gi);
  for (const match of explicitMatches) {
    const productName = match[1].toLowerCase();
    hints.push({ 
      keyword: productName, 
      price: parseInt(match[2]),
      confidence: 'high',
      productKeywords: extractProductKeywords(productName)
    });
  }

  // Pattern 2: "[ชื่อสินค้า] [ราคา] [จำนวน]" - ต้องมีเลข 2 ตัว
  const tripleMatches = text.matchAll(/([ก-๙a-z0-9\s\.\-\(\)]+?)\s+(\d+)\s+(\d+)/gi);
  for (const match of tripleMatches) {
    const productName = match[1].trim();
    const num1 = parseInt(match[2]);
    const num2 = parseInt(match[3]);
    
    // Logic: ถ้า num1 > 10 แล้ว num2 <= 100 → num1 คือราคา
    if (num1 > 10 && num2 <= 100) {
      hints.push({ 
        keyword: productName.toLowerCase(), 
        price: num1,
        quantity: num2,
        confidence: 'medium',
        productKeywords: extractProductKeywords(productName)
      });
    }
    // ถ้า num2 > num1 มากๆ → num2 น่าจะเป็นราคา
    else if (num2 > num1 * 3) {
      hints.push({ 
        keyword: productName.toLowerCase(), 
        price: num2,
        quantity: num1,
        confidence: 'low',
        productKeywords: extractProductKeywords(productName)
      });
    }
  }

  return hints;
}

// ============================================================================
// IMPROVED: สร้างแค็ตตาล็อกแบบ Weighted
// ============================================================================

function buildSmartStockList(stockCache, priceHints) {
  let stockList = '';
  
  // Score each item
  const scoredItems = stockCache.map((item, idx) => {
    let score = 0;
    const itemLower = item.item.toLowerCase();
    const itemKeywords = extractProductKeywords(item.item);
    
    // Check against hints
    for (const hint of priceHints) {
      // Keyword overlap scoring
      const keywordOverlap = hint.productKeywords?.filter(k => 
        itemKeywords.includes(k) || itemLower.includes(k)
      ).length || 0;
      
      if (keywordOverlap > 0) {
        score += keywordOverlap * 15;
        
        // Exact name match
        if (itemLower.includes(hint.keyword) || hint.keyword.includes(itemLower.substring(0, 5))) {
          score += 20;
        }
        
        // Price match bonus
        if (item.price === hint.price) {
          score += 100;
        } else if (Math.abs(item.price - hint.price) <= hint.price * 0.15) {
          score += 40;
        }
        
        // Quantity hint bonus
        if (hint.quantity && item.stock >= hint.quantity) {
          score += 10;
        }
      }
    }
    
    // Stock availability bonus
    if (item.stock > 50) score += 3;
    if (item.stock > 100) score += 2;
    
    return { item, idx, score };
  });
  
  // Sort by score
  scoredItems.sort((a, b) => b.score - a.score);
  
  // Build catalog with priority section
  const priorityItems = scoredItems.filter(s => s.score >= 20);
  
  if (priorityItems.length > 0) {
    stockList += '🎯 [PRIORITY MATCHES]:\n';
    priorityItems.slice(0, 10).forEach(({ item, idx, score }) => {
      stockList += `ID:${idx} | ⭐${score} | ${item.item} | ${item.price}฿ | ${item.stock} ${item.unit}\n`;
    });
    stockList += '\n[ALL ITEMS]:\n';
  }
  
  // Show all items (limited to top 100 for context window)
  scoredItems.slice(0, 100).forEach(({ item, idx }) => {
    stockList += `ID:${idx} | ${item.item} | ${item.price}฿ | ${item.stock} ${item.unit}\n`;
  });
  
  return stockList;
}

// ... rest of the file remains the same ...

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = { 
  parseOrder,
  extractPriceHints,
  extractProductKeywords,  // ✅ Export the new function
  buildSmartStockList,
  splitMultipleIntents,
  detectPaymentStatus,
  extractDeliveryPerson
};
