// orderParser.js - COMPLETE: With all required imports
const { Logger } = require('./logger');
const { generateWithGroq } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');
const { normalizeText } = require('./utils');

// ============================================================================
// INPUT NORMALIZATION
// ============================================================================

function normalizeOrderInput(text) {
  // Transform "น้ำแข็งมี 5 ถุง" → "น้ำแข็ง 5 ถุง"
  // Transform "น้ำแข็ง มี 5" → "น้ำแข็ง 5"
  let normalized = text.replace(/\s*มี\s*/g, ' ').trim();
  
  // Remove extra spaces
  normalized = normalized.replace(/\s+/g, ' ');
  
  Logger.info(`📝 Normalized: "${text}" → "${normalized}"`);
  return normalized;
}

// ============================================================================
// EXTRACT PRICE HINTS
// ============================================================================

function extractPriceHints(text) {
  const hints = [];
  
  // Pattern: "บด 40 บาท" → {keyword: "บด", price: 40}
  const matches = text.matchAll(/([ก-๙a-z]+)\s+(\d+)\s*(?:บาท|฿)/gi);
  
  for (const match of matches) {
    hints.push({
      keyword: match[1].toLowerCase(),
      price: parseInt(match[2])
    });
  }
  
  if (hints.length > 0) {
    Logger.info(`💡 Price hints extracted: ${JSON.stringify(hints)}`);
  }
  
  return hints;
}

// ============================================================================
// BUILD SMART STOCK LIST
// ============================================================================

function buildSmartStockList(stockCache, priceHints) {
  // Group items by price when hints exist
  const grouped = new Map();
  
  stockCache.forEach((item, idx) => {
    const key = `${item.price}฿`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push({ item, idx });
  });
  
  let stockList = '';
  
  // If price hints exist, prioritize those prices
  if (priceHints.length > 0) {
    stockList += '🎯 PRICE-MATCHED ITEMS (use these first):\n';
    
    priceHints.forEach(hint => {
      const matchingItems = grouped.get(`${hint.price}฿`) || [];
      matchingItems.forEach(({ item, idx }) => {
        if (item.item.toLowerCase().includes(hint.keyword)) {
          stockList += `[${idx}] ⭐ ${item.item} | ${item.unit} | ${item.price}฿ | สต็อก:${item.stock}\n`;
        }
      });
    });
    
    stockList += '\nALL OTHER ITEMS:\n';
  }
  
  // Regular list
  stockCache.forEach((item, idx) => {
    stockList += `[${idx}] ${item.item} | ${item.unit} | ${item.price}฿ | สต็อก:${item.stock}\n`;
  });
  
  return stockList;
}

// ============================================================================
// MAIN PARSE ORDER FUNCTION
// ============================================================================

async function parseOrder(userInput) {
  const stockCache = getStockCache();
  const customerCache = getCustomerCache();
  
  if (stockCache.length === 0) return { success: false, error: '❌ สต็อกว่างเปล่าเหมือนสมองนายเลย!' };

  try {
    const stockContext = stockCache.map((item, idx) => 
      `ID:${idx} | ${item.item} | ราคา:${item.price}฿ | สต็อก:${item.stock}`
    ).join('\n');

    const prompt = `คุณเป็น AI อัจฉริยะที่ทำหน้าที่แยกแยะคำสั่งซื้อจาก "คำพูด" หรือ "ข้อความ" ของคนไทย
และนี่คือข้อมูลสต็อกปัจจุบัน:
${stockContext}

ลูกค้าที่รู้จัก: ${customerCache.map(c => c.name).join(', ')}

ข้อความจากผู้ใช้: "${userInput}"

หน้าที่ของคุณ:
1. วิเคราะห์เจตนา (Intent): เขาสั่งของ, ปรับสต็อก หรือแค่ทักทาย?
2. ใช้ Fuzzy Matching ขั้นสูง: "บด" อาจหมายถึง "น้ำแข็งบด", "ลีโอ" หมายถึง "เบียร์ลีโอ"
3. แยกแยะราคา: ถ้าเขาบอกว่า "บด 40" ให้หาอันที่ราคา 40฿ จริงๆ
4. เข้าใจภาษาพูด: "เอาถุงใหญ่สอง" = { quantity: 2, item: "ถุงใหญ่" }

ตอบกลับเป็น JSON เท่านั้น:
{
  "customer": "ชื่อลูกค้า (ถ้ามี)",
  "items": [{ "stockId": index, "quantity": number, "matchConfidence": "exact/fuzzy" }],
  "paymentStatus": "unpaid/credit",
  "confidence": "high/medium/low",
  "reasoning": "อธิบายสั้นๆ ว่าทำไมถึงเข้าใจแบบนั้น"
}`;

    const result = await generateWithGroq(prompt, true);
    result.rawInput = userInput; 

    const mappedItems = [];
    const matchDetails = [];
    
    if (result.items && Array.isArray(result.items)) {
      for (const item of result.items) {
        if (item.stockId >= 0 && item.stockId < stockCache.length) {
          const stockItem = stockCache[item.stockId];
          
          // Track how item was matched
          const matchInfo = {
            item: stockItem.item,
            method: item.priceMatchUsed ? 'price' : 'name',
            confidence: item.matchConfidence
          };
          
          if (item.mentionedPrice) {
            matchInfo.mentionedPrice = item.mentionedPrice;
            matchInfo.actualPrice = stockItem.price;
            matchInfo.priceMatch = item.mentionedPrice === stockItem.price;
          }
          
          matchDetails.push(matchInfo);
          
          mappedItems.push({
            stockItem: stockItem,
            quantity: item.quantity || 1,
            matchConfidence: item.matchConfidence || 'exact'
          });
        }
      }
    }

    const boostedConfidence = boostConfidence(result, mappedItems, normalizedInput, customerCache);

    if (matchDetails.length > 0) {
      Logger.info(`🎯 Match details: ${JSON.stringify(matchDetails)}`);
    }

    Logger.info(
      `📝 Parsed: ${mappedItems.length} items | ` +
      `Base: ${result.confidence} → Boosted: ${boostedConfidence} | ` +
      `Reason: ${result.reasoning}`
    );

    return {
      success: mappedItems.length > 0,
      customer: result.customer || 'ไม่ระบุ',
      items: mappedItems,
      paymentStatus: result.paymentStatus || 'unpaid',
      confidence: boostedConfidence,
      baseConfidence: result.confidence,
      reasoning: result.reasoning,
      matchDetails: matchDetails,
      rawInput: userInput,
      action: 'order'
    };

  } catch (error) {
    Logger.error('Parse failed', error);
    return {
      success: false,
      error: '❌ AI ไม่เข้าใจคำสั่ง',
      confidence: 'low'
    };
  }
}

// ============================================================================
// BOOST CONFIDENCE
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
// EXPORTS
// ============================================================================

module.exports = { 
  parseOrder,
  normalizeOrderInput,
  extractPriceHints,
  buildSmartStockList
};
