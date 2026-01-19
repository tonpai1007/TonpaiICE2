// src/orderParser.js - FIXED: Support [Item] [Price] [Quantity] pattern
const { Logger } = require('./logger');
const { generateWithGroq } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function normalizeOrderInput(text) {
  // ลบคำเชื่อมที่ไม่จำเป็น เพื่อให้ Pattern จับง่ายขึ้น
  let normalized = text.replace(/\s*มี\s*/g, ' ').trim();
  normalized = normalized.replace(/\s+/g, ' '); // ลดช่องว่างซ้ำซ้อน
  return normalized;
}

function extractPriceHints(text) {
  const hints = [];
  
  // Pattern 1: ระบุคำว่า "บาท" ชัดเจน (เช่น "น้ำแข็ง 20 บาท")
  const explicitMatches = text.matchAll(/([ก-๙a-z0-9\.\-\(\)]+)\s+(\d+)\s*(?:บาท|฿)/gi);
  for (const match of explicitMatches) {
    hints.push({ keyword: match[1].toLowerCase(), price: parseInt(match[2]) });
  }

  // Pattern 2: ระบุแบบ "ชื่อ ราคา จำนวน" (เช่น "น้ำแข็ง 20 2 ถุง", "โค้ก 350 1 ลัง")
  // Regex นี้จะหา: [คำ] [เว้นวรรค] [เลขราคา] [เว้นวรรค] [เลขจำนวน]
  const patternMatches = text.matchAll(/([ก-๙a-z0-9\.\-\(\)]+)\s+(\d+)\s+(\d+)/gi);
  for (const match of patternMatches) {
    // match[1] = ชื่อ, match[2] = ราคา, match[3] = จำนวน (เราเอาแค่ราคาไปเป็น Hint)
    hints.push({ keyword: match[1].toLowerCase(), price: parseInt(match[2]) });
  }

  return hints;
}

function buildSmartStockList(stockCache, priceHints) {
  let stockList = '';
  
  // ถ้ามี Price Hints (ราคาที่จับได้จากเสียง) ให้เอารายการที่ราคาตรงกันขึ้นก่อน
  if (priceHints.length > 0) {
    stockList += '🎯 [PRIORITY MATCHES - รายการที่ราคาตรงกับที่พูด]:\n';
    let foundPriority = false;
    
    priceHints.forEach(hint => {
      stockCache.forEach((item, idx) => {
        // เช็คว่าชื่อคล้าย และ ราคาตรงเป๊ะ
        if (item.price === hint.price && item.item.toLowerCase().includes(hint.keyword)) {
          stockList += `ID:${idx} | ⭐ ${item.item} | ${item.price}฿ | สต็อก:${item.stock}\n`;
          foundPriority = true;
        }
      });
    });
    
    if (foundPriority) {
      stockList += '\n[ALL OTHER ITEMS - รายการอื่นๆ]:\n';
    }
  }
  
  // แสดงรายการทั้งหมด (หรือรายการที่เหลือ)
  stockCache.forEach((item, idx) => {
    stockList += `ID:${idx} | ${item.item} | ${item.price}฿ | สต็อก:${item.stock}\n`;
  });
  return stockList;
}

// ============================================================================
// BOOST CONFIDENCE
// ============================================================================

function boostConfidence(aiResult, mappedItems, userInput, customerCache) {
  let confidence = aiResult.confidence || 'low';
  const boostReasons = [];

  // 1. Exact Price Match (ราคาตรงเป๊ะ)
  const allExactMatch = mappedItems.every(item => item.matchConfidence === 'exact');
  if (allExactMatch && mappedItems.length > 0) boostReasons.push('exact_price_match');

  // 2. Customer Mentioned (ระบุลูกค้า)
  if (aiResult.customer && aiResult.customer !== 'ไม่ระบุ') {
    boostReasons.push('customer_mentioned');
    const customerExists = customerCache.some(c => 
      c.name.toLowerCase().includes(aiResult.customer?.toLowerCase())
    );
    if (customerExists) boostReasons.push('known_customer');
  }

  // 3. Stock Available (มีของ)
  const allInStock = mappedItems.every(item => item.stockItem.stock >= item.quantity);
  if (allInStock) boostReasons.push('stock_available');

  // 4. Clear Quantity Pattern (มีตัวเลขจำนวนชัดเจน)
  // เช็คว่ามีเลขที่เป็นจำนวน (Pattern: ราคาตามด้วยจำนวน หรือเลขเดี่ยวๆ)
  if (/\d+\s+\d+/.test(userInput) || /\d+/.test(userInput)) {
    boostReasons.push('clear_quantity_pattern');
  }

  // Logic การเพิ่มความมั่นใจ
  if (confidence === 'medium' && boostReasons.length >= 2) {
    Logger.info(`🚀 Confidence boosted: medium → high (${boostReasons.join(', ')})`);
    return 'high';
  }

  if (confidence === 'low' && boostReasons.length >= 3) {
    Logger.info(`🚀 Confidence boosted: low → medium (${boostReasons.join(', ')})`);
    return 'medium';
  }

  return confidence;
}

// ============================================================================
// CALCULATE MATCH CONFIDENCE
// ============================================================================

function calculateMatchConfidence(stockItem, priceHint) {
  if (priceHint && stockItem.price === priceHint) return 'exact';
  if (priceHint && Math.abs(stockItem.price - priceHint) <= (priceHint * 0.1)) return 'fuzzy';
  return 'partial';
}

// ============================================================================
// MAIN PARSE ORDER FUNCTION
// ============================================================================

async function parseOrder(userInput) {
  const stockCache = getStockCache();
  const customerCache = getCustomerCache();
  
  // 1. เตรียมข้อมูล
  const normalizedInput = normalizeOrderInput(userInput);
  const priceHints = extractPriceHints(normalizedInput); // หา Pattern ราคา
  const smartCatalog = buildSmartStockList(stockCache, priceHints); // สร้างแคตตาล็อกที่เน้นสินค้าตามราคา

  // 2. สร้าง Prompt สำหรับ AI
  const prompt = `คุณคือ AI อัจฉริยะวิเคราะห์คำสั่งซื้อ (Strict Pattern Matching)
คลังสินค้า (รายการที่มี ⭐ คือรายการที่ราคาตรงกับเสียงพูด - จงเลือกก่อน):
${smartCatalog}

ลูกค้าที่รู้จัก: ${customerCache.map(c => c.name).join(', ')}

ข้อความดิบ: "${userInput}"
ข้อความที่ปรับแต่ง: "${normalizedInput}"

🎯 กฏสำคัญ (Pattern Rules):
1. รูปแบบ "ชื่อสินค้า ราคา จำนวน" (สำคัญที่สุด):
   - ถ้าเจอเลข 2 ตัวติดกัน เช่น "น้ำแข็ง 20 2" -> หมายถึง ราคา=20, จำนวน=2
   - ต้องเลือก ID สินค้าที่มีราคาตรงกับเลขแรก (20) เท่านั้น!
2. ถ้ามีแค่ "ชื่อสินค้า จำนวน" (ไม่มีราคา):
   - ให้เลือกสินค้าที่ชื่อตรงที่สุด (ถ้ามีหลายราคา ให้เลือกตัวที่ขายนิยมสุดหรือตัวแรก)
3. แยกข้อความได้หลายคำสั่ง เช่น "น้ำแข็ง 20 5 เจ๊แดง แล้วก็ โค้ก 350 1 ลัง"

ตอบเป็น JSON ARRAY เท่านั้น:
[
  {
    "intent": "order|payment|stock_adj",
    "customer": "ชื่อลูกค้า",
    "items": [{"stockId": 0, "quantity": 1}],
    "confidence": "high|medium|low",
    "reasoning": "เช่น: เจอน้ำแข็งราคา 20 บาทตามที่ระบุ"
  }
]`;

  try {
    const results = await generateWithGroq(prompt, true);
    const parsedArray = Array.isArray(results) ? results : [results];

    return parsedArray.map(res => {
      // Map items กลับไปหา Stock จริง
      const mappedItems = (res.items || []).map(i => {
        const stockItem = stockCache[i.stockId];
        if (!stockItem) return null;
        
        // เช็คว่าสินค้านี้ตรงกับราคาที่เรา Hint ไปไหม
        const priceHint = priceHints.find(h => 
          stockItem.item.toLowerCase().includes(h.keyword)
        );
        
        return {
          stockItem: stockItem,
          quantity: i.quantity || 1,
          matchConfidence: calculateMatchConfidence(stockItem, priceHint?.price)
        };
      }).filter(i => i !== null);

      // Boost confidence
      const boostedConfidence = boostConfidence(res, mappedItems, normalizedInput, customerCache);

      return {
        ...res,
        items: mappedItems,
        confidence: boostedConfidence,
        rawInput: userInput
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
