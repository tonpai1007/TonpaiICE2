// orderParser.js - FIXED: Integrated confidence boosting
const { Logger } = require('./logger');
const { generateWithGroq } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function normalizeOrderInput(text) {
  let normalized = text.replace(/\s*มี\s*/g, ' ').trim();
  normalized = normalized.replace(/\s+/g, ' ');
  return normalized;
}

function extractPriceHints(text) {
  const hints = [];
  const matches = text.matchAll(/([ก-๙a-z]+)\s+(\d+)\s*(?:บาท|฿)/gi);
  for (const match of matches) {
    hints.push({ keyword: match[1].toLowerCase(), price: parseInt(match[2]) });
  }
  return hints;
}

function buildSmartStockList(stockCache, priceHints) {
  let stockList = '';
  if (priceHints.length > 0) {
    stockList += '🎯 [PRIORITY MATCHES - รายการที่ราคาตรงกับที่พูด]:\n';
    priceHints.forEach(hint => {
      stockCache.forEach((item, idx) => {
        if (item.price === hint.price && item.item.includes(hint.keyword)) {
          stockList += `ID:${idx} | ⭐ ${item.item} | ${item.price}฿ | สต็อก:${item.stock}\n`;
        }
      });
    });
    stockList += '\n[ALL OTHER ITEMS]:\n';
  }
  
  stockCache.forEach((item, idx) => {
    stockList += `ID:${idx} | ${item.item} | ${item.price}฿ | สต็อก:${item.stock}\n`;
  });
  return stockList;
}

// ============================================================================
// BOOST CONFIDENCE (Now properly integrated)
// ============================================================================

function boostConfidence(aiResult, mappedItems, userInput, customerCache) {
  let confidence = aiResult.confidence || 'low';
  const boostReasons = [];

  // Check for exact matches
  const allExactMatch = mappedItems.every(item => 
    item.matchConfidence === 'exact'
  );
  if (allExactMatch && mappedItems.length > 0) {
    boostReasons.push('exact_match');
  }

  // Check customer mentioned
  const customerMentioned = aiResult.customer && aiResult.customer !== 'ไม่ระบุ';
  if (customerMentioned) {
    boostReasons.push('customer_mentioned');
    
    const customerExists = customerCache.some(c => 
      c.name.toLowerCase().includes(aiResult.customer?.toLowerCase())
    );
    if (customerExists) {
      boostReasons.push('known_customer');
    }
  }

  // Check stock availability
  const allInStock = mappedItems.every(item => 
    item.stockItem.stock >= item.quantity
  );
  if (allInStock) {
    boostReasons.push('stock_available');
  }

  // Check clear quantity
  const hasQuantityWords = /\d+|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ/.test(userInput);
  if (hasQuantityWords) {
    boostReasons.push('clear_quantity');
  }

  // Check negative signals
  const negativeWords = ['บางที', 'คิดว่า', 'อาจจะ', 'ไม่แน่ใจ', 'หรือเปล่า'];
  const hasNegativeSignal = negativeWords.some(word => 
    userInput.toLowerCase().includes(word)
  );

  // Apply boosts
  if (confidence === 'medium' && boostReasons.length >= 3) {
    Logger.info(`🚀 Confidence boosted: medium → high (${boostReasons.join(', ')})`);
    return 'high';
  }

  if (confidence === 'low' && boostReasons.length >= 4 && !hasNegativeSignal) {
    Logger.info(`🚀 Confidence boosted: low → medium (${boostReasons.join(', ')})`);
    return 'medium';
  }

  if (hasNegativeSignal && confidence === 'high') {
    Logger.warn(`⚠️ Confidence downgraded: high → medium (negative words)`);
    return 'medium';
  }

  return confidence;
}

// ============================================================================
// CALCULATE MATCH CONFIDENCE
// ============================================================================

function calculateMatchConfidence(stockItem, priceHint) {
  // If price hint matches exactly, it's exact match
  if (priceHint && stockItem.price === priceHint) {
    return 'exact';
  }
  
  // If price hint is within 10%, it's fuzzy match
  if (priceHint && Math.abs(stockItem.price - priceHint) <= (priceHint * 0.1)) {
    return 'fuzzy';
  }
  
  // Otherwise, partial match
  return 'partial';
}

// ============================================================================
// MAIN PARSE ORDER FUNCTION (FIXED)
// ============================================================================

async function parseOrder(userInput) {
  const stockCache = getStockCache();
  const customerCache = getCustomerCache();
  
  // Prepare data with helpers
  const normalizedInput = normalizeOrderInput(userInput);
  const priceHints = extractPriceHints(userInput);
  const smartCatalog = buildSmartStockList(stockCache, priceHints);

  const prompt = `คุณคือ AI อัจฉริยะวิเคราะห์คำสั่งซื้อไทย (Multi-Order Parser)
คลังสินค้า (จัดลำดับตามราคาที่ระบุมา):
${smartCatalog}

ลูกค้าที่รู้จัก: ${customerCache.map(c => c.name).join(', ')}

ข้อความดิบ: "${userInput}"
ข้อความที่ปรับแต่ง: "${normalizedInput}"

หน้าที่:
1. แยกข้อความออกเป็น "ARRAY ของชุดคำสั่ง"
2. รองรับหลายร้าน/หลายไอเทม เช่น "น้ำแข็ง 2 ถุง เจ๊แดง แล้วก็โค้ก 5 ขวด พี่ใหม่"
3. วิเคราะห์ Intent: 'order', 'payment', 'stock_adj'
4. ใช้ Price Hints: ถ้ามีระบุราคามา ให้จับคู่ ID สินค้าที่มีราคานั้นเท่านั้น

ตอบเป็น JSON ARRAY เท่านั้น:
[
  {
    "intent": "order|payment|stock_adj",
    "customer": "ชื่อลูกค้า",
    "items": [{"stockId": 0, "quantity": 1}],
    "confidence": "high|medium|low",
    "reasoning": "อธิบายสั้นๆ"
  }
]`;

  try {
    const results = await generateWithGroq(prompt, true);
    const parsedArray = Array.isArray(results) ? results : [results];

    // ✅ FIX: Properly map items and boost confidence
    return parsedArray.map(res => {
      // Map items with match confidence
      const mappedItems = (res.items || []).map(i => {
        const stockItem = stockCache[i.stockId];
        if (!stockItem) return null;
        
        // Find if this item had a price hint
        const priceHint = priceHints.find(h => 
          stockItem.item.toLowerCase().includes(h.keyword)
        );
        
        return {
          stockItem: stockItem,
          quantity: i.quantity || 1,
          matchConfidence: calculateMatchConfidence(stockItem, priceHint?.price)
        };
      }).filter(i => i !== null);

      // ✅ FIX: Apply confidence boosting
      const boostedConfidence = boostConfidence(res, mappedItems, userInput, customerCache);

      return {
        ...res,
        items: mappedItems,
        confidence: boostedConfidence,
        rawInput: userInput,
        priceHints: priceHints // Include for reference
      };
    });
  } catch (error) {
    Logger.error('Multi-parse failed', error);
    return [{ success: false, error: 'AI Error' }];
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = { 
  parseOrder,
  normalizeOrderInput,
  extractPriceHints,
  buildSmartStockList,
  boostConfidence,
  calculateMatchConfidence
};
