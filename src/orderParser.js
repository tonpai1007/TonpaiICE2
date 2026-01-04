// orderParser.js - Smart Auto Parser with Confidence Boosting
const { Logger } = require('./logger');
const { generateWithGroq } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');

// ============================================================================
// SMART PARSING WITH CONFIDENCE BOOSTING
// ============================================================================

async function parseOrder(userInput) {
  const stockCache = getStockCache();
  const customerCache = getCustomerCache();
  
  if (stockCache.length === 0) {
    return { success: false, error: '❌ ไม่มีข้อมูลสต็อก' };
  }

  try {
    // 1. Build enhanced context
    const stockList = stockCache.map((item, idx) => 
      `[${idx}] ${item.item} | ${item.unit} | ${item.price}฿ | สต็อก:${item.stock}`
    ).join('\n');

    const customerList = customerCache.slice(0, 50).map(c => c.name).join(', ');

    // 2. Enhanced prompt with confidence rules
    const prompt = `
You are an expert Thai order parser. Extract order details with HIGH confidence.

STOCK CATALOG:
${stockList}

KNOWN CUSTOMERS: ${customerList}

USER INPUT: "${userInput}"

CONFIDENCE RULES (return "high" if ALL true):
1. Customer name is clearly mentioned OR matches known customer
2. Item name matches stock catalog clearly (fuzzy match OK)
3. Quantity is explicitly stated with number
4. No ambiguous words like "บางที", "คิดว่า", "อาจจะ"

FUZZY MATCHING:
- "น้ำแข็ง" = "น้ำแข็งหลอด", "น้ำแข็งก้อน"
- "เบียร์" = "เบียร์ลีโอ", "เบียร์ช้าง", "เบียร์สิงห์"
- Numbers: "ห้า"=5, "สิบ"=10, "สองสิบ"=20

OUTPUT JSON:
{
  "customer": "ชื่อลูกค้า or ไม่ระบุ",
  "items": [
    {
      "stockId": 0,
      "quantity": 2,
      "matchConfidence": "exact|fuzzy|guess"
    }
  ],
  "paymentStatus": "unpaid or credit",
  "confidence": "high or medium or low",
  "reasoning": "why this confidence level"
}

EXAMPLES:
Input: "สมชาย สั่งน้ำแข็ง 5 ถุง"
→ confidence: "high" (clear customer, clear item, clear quantity)

Input: "เอาเบียร์ 3"
→ confidence: "medium" (no customer, item needs clarification)

Input: "คุณแดง บอกว่าอาจจะเอาโค้กสักหน่อย"
→ confidence: "low" (ambiguous: "อาจจะ", "สักหน่อย")
`;

    const result = await generateWithGroq(prompt, true);

    // 3. Map stockId to actual items
    const mappedItems = [];
    if (result.items && Array.isArray(result.items)) {
      for (const item of result.items) {
        if (item.stockId >= 0 && item.stockId < stockCache.length) {
          mappedItems.push({
            stockItem: stockCache[item.stockId],
            quantity: item.quantity || 1,
            matchConfidence: item.matchConfidence || 'exact'
          });
        }
      }
    }

    // 4. CONFIDENCE BOOSTING: Check additional signals
    const boostedConfidence = boostConfidence(result, mappedItems, userInput, customerCache);

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
// CONFIDENCE BOOSTING LOGIC
// ============================================================================

function boostConfidence(aiResult, mappedItems, userInput, customerCache) {
  let confidence = aiResult.confidence || 'low';
  const boostReasons = [];

  // Check 1: All items have exact matches
  const allExactMatch = mappedItems.every(item => 
    item.matchConfidence === 'exact'
  );
  if (allExactMatch && mappedItems.length > 0) {
    boostReasons.push('exact_match');
  }

  // Check 2: Customer is in database
  const customerExists = customerCache.some(c => 
    c.name.toLowerCase().includes(aiResult.customer?.toLowerCase())
  );
  if (customerExists && aiResult.customer !== 'ไม่ระบุ') {
    boostReasons.push('known_customer');
  }

  // Check 3: Stock is available for all items
  const allInStock = mappedItems.every(item => 
    item.stockItem.stock >= item.quantity
  );
  if (allInStock) {
    boostReasons.push('stock_available');
  }

  // Check 4: Clear quantity words
  const hasQuantityWords = /\d+|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ/.test(userInput);
  if (hasQuantityWords) {
    boostReasons.push('clear_quantity');
  }

  // Check 5: No negative signals
  const negativeWords = ['บางที', 'คิดว่า', 'อาจจะ', 'ไม่แน่ใจ', 'หรือเปล่า'];
  const hasNegativeSignal = negativeWords.some(word => 
    userInput.toLowerCase().includes(word)
  );

  // BOOST LOGIC
  if (confidence === 'medium' && boostReasons.length >= 3) {
    Logger.info(`🚀 Confidence boosted: medium → high (${boostReasons.join(', ')})`);
    return 'high';
  }

  if (confidence === 'low' && boostReasons.length >= 4 && !hasNegativeSignal) {
    Logger.info(`🚀 Confidence boosted: low → medium (${boostReasons.join(', ')})`);
    return 'medium';
  }

  // DOWNGRADE if negative signals
  if (hasNegativeSignal && confidence === 'high') {
    Logger.warn(`⚠️ Confidence downgraded: high → medium (negative words)`);
    return 'medium';
  }

  return confidence;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = { parseOrder };