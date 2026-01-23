// src/orderParser.js - FIXED: รองรับคำสั่งรวม + ชื่อสินค้าแม่นยำขึ้น
const { Logger } = require('./logger');
const { generateWithGroq } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');

// ============================================================================
// PRE-PROCESS: แยกคำสั่งหลายแบบออกจากกัน
// ============================================================================

function splitMultipleIntents(text) {
  const lower = text.toLowerCase();
  
  // Pattern 1: "[ชื่อ] ส่ง [สินค้า] แล้วก็ จ่าย"
  const patterns = [
    {
      regex: /(.+?)\s*ส่ง\s*(.+?)(?:\s+(?:แล้ว|เเล้ว))?(?:\s+(?:จ่าย|ชำระ|จ่ายเงิน))?(?:\s+(?:แล้ว|เเล้ว))?/i,
      extract: (match, fullText) => {
        const customer = match[1].trim();
        const itemsPart = match[2].trim();
        const hasPaid = /(?:จ่าย|ชำระ)/.test(fullText);
        
        return {
          customer,
          itemsPart,
          hasPaid,
          hasDelivery: true,
          type: 'order'
        };
      }
    },
    
    // Pattern 2: "[ชื่อ] สั่ง [สินค้า] จ่ายแล้ว"
    {
      regex: /(.+?)\s*(?:สั่ง|เอา|ขอ)\s*(.+?)(?:\s+(?:จ่าย|ชำระ))?(?:\s+(?:แล้ว|เเล้ว))?/i,
      extract: (match, fullText) => {
        const customer = match[1].trim();
        const itemsPart = match[2].trim();
        const hasPaid = /(?:จ่าย|ชำระ)/.test(fullText);
        
        return {
          customer,
          itemsPart,
          hasPaid,
          hasDelivery: false,
          type: 'order'
        };
      }
    }
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) {
      return pattern.extract(match, text);
    }
  }
  
  return null;
}

// ============================================================================
// ENHANCED: ดึง Price Hints ที่แม่นยำขึ้น
// ============================================================================

function extractPriceHints(text) {
  const hints = [];
  
  // Pattern 1: "ราคา X บาท" หรือ "X บาท"
  const explicitMatches = text.matchAll(/([ก-๙a-z0-9\.\-\(\)]+)\s+(?:ราคา\s+)?(\d+)\s*(?:บาท|฿)/gi);
  for (const match of explicitMatches) {
    hints.push({ 
      keyword: match[1].toLowerCase(), 
      price: parseInt(match[2]),
      confidence: 'high' 
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
        confidence: 'medium'
      });
    }
    // ถ้า num2 > num1 มากๆ → num2 น่าจะเป็นราคา
    else if (num2 > num1 * 3) {
      hints.push({ 
        keyword: productName.toLowerCase(), 
        price: num2,
        quantity: num1,
        confidence: 'low'
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
  
  // สร้าง priority score สำหรับแต่ละสินค้า
  const scoredItems = stockCache.map((item, idx) => {
    let score = 0;
    
    // ตรวจสอบว่าตรงกับ hint ไหม
    for (const hint of priceHints) {
      const itemLower = item.item.toLowerCase();
      
      // ชื่อตรงบางส่วน
      if (itemLower.includes(hint.keyword) || hint.keyword.includes(itemLower.substring(0, 3))) {
        score += 10;
        
        // ราคาตรง = โบนัสเยอะ
        if (item.price === hint.price) {
          score += 50;
        }
        // ราคาใกล้เคียง ±10%
        else if (Math.abs(item.price - hint.price) <= hint.price * 0.1) {
          score += 20;
        }
      }
    }
    
    // โบนัสสินค้ายอดนิยม (stock > 50)
    if (item.stock > 50) score += 2;
    
    return { item, idx, score };
  });
  
  // เรียงตาม score
  scoredItems.sort((a, b) => b.score - a.score);
  
  // แสดงผล: Priority items ก่อน
  const priorityItems = scoredItems.filter(s => s.score > 15);
  
  if (priorityItems.length > 0) {
    stockList += '🎯 [PRIORITY MATCHES - สินค้าที่ตรงกับคำสั่ง]:\n';
    priorityItems.forEach(({ item, idx }) => {
      stockList += `ID:${idx} | ⭐ ${item.item} | ${item.price}฿ | ${item.stock} ${item.unit}\n`;
    });
    stockList += '\n[OTHER ITEMS]:\n';
  }
  
  // แสดงสินค้าทั้งหมด (เรียงตาม score)
  scoredItems.forEach(({ item, idx }) => {
    stockList += `ID:${idx} | ${item.item} | ${item.price}฿ | ${item.stock} ${item.unit}\n`;
  });
  
  return stockList;
}

// ============================================================================
// ENHANCED: Boost Confidence with better logic
// ============================================================================

function boostConfidence(aiResult, mappedItems, userInput, customerCache, preProcessed) {
  let confidence = aiResult.confidence || 'low';
  const boostReasons = [];

  // 1. Exact Price Match
  const allExactMatch = mappedItems.every(item => item.matchConfidence === 'exact');
  if (allExactMatch && mappedItems.length > 0) {
    boostReasons.push('exact_price_match');
  }

  // 2. Customer Mentioned & Exists
  if (aiResult.customer && aiResult.customer !== 'ไม่ระบุ') {
    boostReasons.push('customer_mentioned');
    
    const customerExists = customerCache.some(c => 
      c.name.toLowerCase().includes(aiResult.customer?.toLowerCase())
    );
    if (customerExists) {
      boostReasons.push('known_customer');
    }
  }

  // 3. Stock Available
  const allInStock = mappedItems.every(item => item.stockItem.stock >= item.quantity);
  if (allInStock) {
    boostReasons.push('stock_available');
  }

  // 4. Clear Pattern (มีตัวเลขชัดเจน)
  if (/\d+\s+\d+/.test(userInput)) {
    boostReasons.push('clear_quantity_pattern');
  }
  
  // 5. Pre-processed มี payment/delivery info
  if (preProcessed?.hasPaid) {
    boostReasons.push('payment_confirmed');
  }

  // Boosting Logic
  if (confidence === 'medium' && boostReasons.length >= 3) {
    Logger.info(`🚀 Confidence: medium → high (${boostReasons.join(', ')})`);
    return 'high';
  }

  if (confidence === 'low' && boostReasons.length >= 4) {
    Logger.info(`🚀 Confidence: low → medium (${boostReasons.join(', ')})`);
    return 'medium';
  }

  return confidence;
}

// ============================================================================
// MAIN PARSE ORDER - MULTI-INTENT AWARE
// ============================================================================

async function parseOrder(userInput) {
  const stockCache = getStockCache();
  const customerCache = getCustomerCache();
  
  // 1. Pre-process: แยกคำสั่งหลายแบบ
  const preProcessed = splitMultipleIntents(userInput);
  
  // 2. Extract price hints
  const priceHints = extractPriceHints(userInput);
  Logger.info(`💡 Price hints found: ${JSON.stringify(priceHints)}`);
  
  // 3. Build smart catalog
  const smartCatalog = buildSmartStockList(stockCache, priceHints);

  // 4. Create AI prompt with multi-intent awareness
  const prompt = `คุณคือ AI ที่วิเคราะห์คำสั่งซื้อสินค้า

📦 คลังสินค้า (รายการที่มี ⭐ = แนะนำ):
${smartCatalog}

👥 ลูกค้า: ${customerCache.map(c => c.name).join(', ')}

💬 ข้อความ: "${userInput}"

${preProcessed ? `
🔍 ตรวจพบ:
- ลูกค้า: ${preProcessed.customer}
- สินค้า: ${preProcessed.itemsPart}
- จ่ายแล้ว: ${preProcessed.hasPaid ? 'ใช่' : 'ไม่'}
- ส่งแล้ว: ${preProcessed.hasDelivery ? 'ใช่' : 'ไม่'}
` : ''}

📋 กฎสำคัญ:
1. ถ้าเห็น "ส่ง" → deliveryPerson ต้องไม่ว่าง (ใส่ชื่อจาก customer)
2. ถ้าเห็น "จ่าย/ชำระ" → isPaid: true
3. Pattern "[ชื่อสินค้า] [ราคา] [จำนวน]":
   - เลขตัวแรก (>10) = ราคา
   - เลขตัวหลัง (<=100) = จำนวน
4. เลือกสินค้าที่มี ⭐ ก่อน (ราคาตรง)

ตอบเป็น JSON:
{
  "intent": "order",
  "customer": "ชื่อลูกค้า",
  "items": [{"stockId": 0, "quantity": 1}],
  "isPaid": false,
  "deliveryPerson": "",
  "confidence": "high|medium|low",
  "reasoning": "อธิบายเหตุผล"
}`;

  try {
    const aiResult = await generateWithGroq(prompt, true);
    
    // Map items
    const mappedItems = (aiResult.items || []).map(i => {
      const stockItem = stockCache[i.stockId];
      if (!stockItem) return null;
      
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
    const boostedConfidence = boostConfidence(
      aiResult, 
      mappedItems, 
      userInput, 
      customerCache,
      preProcessed
    );

    // Merge with pre-processed data
    const result = {
      ...aiResult,
      items: mappedItems,
      confidence: boostedConfidence,
      isPaid: preProcessed?.hasPaid || aiResult.isPaid || false,
      deliveryPerson: preProcessed?.hasDelivery 
        ? (aiResult.deliveryPerson || preProcessed.customer) 
        : (aiResult.deliveryPerson || ''),
      rawInput: userInput
    };
    
    Logger.success(`✅ Parsed: ${result.customer}, ${result.items.length} items, paid=${result.isPaid}, delivery=${result.deliveryPerson}`);

    return [result];

  } catch (error) {
    Logger.error('parseOrder failed', error);
    return [{ success: false, error: 'AI Error' }];
  }
}

// ============================================================================
// HELPER: Calculate Match Confidence
// ============================================================================

function calculateMatchConfidence(stockItem, priceHint) {
  if (!priceHint) return 'partial';
  
  if (stockItem.price === priceHint) {
    return 'exact';
  }
  
  // Fuzzy: ±10%
  if (Math.abs(stockItem.price - priceHint) <= (priceHint * 0.1)) {
    return 'fuzzy';
  }
  
  return 'partial';
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = { 
  parseOrder,
  extractPriceHints,
  buildSmartStockList,
  boostConfidence,
  calculateMatchConfidence,
  splitMultipleIntents
};