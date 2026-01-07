// orderParser.js - ENHANCED: Use price as a matching hint

async function parseOrder(userInput) {
  const stockCache = getStockCache();
  const customerCache = getCustomerCache();
  
  if (stockCache.length === 0) {
    return { success: false, error: '❌ ไม่มีข้อมูลสต็อก' };
  }

  try {
    const normalizedInput = normalizeOrderInput(userInput);
    
    // Extract price hints from input
    const priceHints = extractPriceHints(userInput);
    
    // Enhanced stock list with price-based grouping
    const stockList = buildSmartStockList(stockCache, priceHints);

    const customerList = customerCache.slice(0, 50).map(c => c.name).join(', ');

    const prompt = `You are an expert Thai order parser with SMART PRICE MATCHING.

STOCK CATALOG WITH PRICE HINTS:
${stockList}

KNOWN CUSTOMERS: ${customerList}

USER INPUT: "${normalizedInput}"

CRITICAL PRICE MATCHING RULES:
1. If user mentions price (e.g., "บด 40 บาท"), find the stock item that EXACTLY matches that price
2. Example: "บด 40" should match "บดหยาบ" (40฿) NOT "บดละเอียด" (30฿)
3. If no exact price match, use closest match by name
4. Set "priceMatchUsed": true if you used price to disambiguate

OUTPUT JSON:
{
  "customer": "ชื่อลูกค้า หรือ ไม่ระบุ",
  "items": [
    {
      "stockId": 0,
      "quantity": 2,
      "matchConfidence": "exact|fuzzy|guess",
      "priceMatchUsed": false,
      "mentionedPrice": 40
    }
  ],
  "paymentStatus": "unpaid or credit",
  "confidence": "high or medium or low",
  "reasoning": "why this confidence level"
}`;

    const result = await generateWithGroq(prompt, true);

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

    Logger.info(`🎯 Match details: ${JSON.stringify(matchDetails)}`);

    return {
      success: mappedItems.length > 0,
      customer: result.customer || 'ไม่ระบุ',
      items: mappedItems,
      paymentStatus: result.paymentStatus || 'unpaid',
      confidence: boostedConfidence,
      baseConfidence: result.confidence,
      reasoning: result.reasoning,
      matchDetails: matchDetails, // For debugging
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
  
  Logger.info(`💡 Price hints extracted: ${JSON.stringify(hints)}`);
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

module.exports = { 
  parseOrder,
  extractPriceHints,
  buildSmartStockList
};
