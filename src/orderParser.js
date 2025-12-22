// orderParser.js - Parse natural language orders using Gemini + RAG

const { Logger, PerformanceMonitor } = require('./logger');
const { normalizeText, similarity, calculateAdvancedSimilarity, retryWithBackoff } = require('./utils');
const { generateWithGemini, getGemini } = require('./aiServices');
const { stockVectorStore, customerVectorStore } = require('./vectorStore');
const { getStockCache, getCustomerCache } = require('./cacheManager');
const { ITEM_ALIASES } = require('./constants');

// ============================================================================
// MAIN PARSING FUNCTION
// ============================================================================

async function parseOrder(userInput) {
  const stockCache = getStockCache();
  
  if (stockCache.length === 0) {
    return {
      success: false,
      error: 'ยังไม่มีสินค้าในระบบ กรุณาเพิ่มสินค้าก่อน'
    };
  }

  try {
    PerformanceMonitor.start('parseOrder');
    
    const genAI = getGemini();
    if (genAI) {
      const result = await parseOrderWithGemini(userInput, stockCache);
      PerformanceMonitor.end('parseOrder');
      return result;
    } else {
      Logger.warn('Gemini not available, using fallback parser');
      const result = fallbackParserWithRAG(userInput, stockCache);
      PerformanceMonitor.end('parseOrder');
      return result;
    }
  } catch (error) {
    Logger.error('parseOrder error', error);
    PerformanceMonitor.end('parseOrder');
    return fallbackParserWithRAG(userInput, stockCache);
  }
}

// ============================================================================
// GEMINI PARSER
// ============================================================================

async function parseOrderWithGemini(userInput, stockCache) {
  try {
    Logger.info('Starting Gemini parse with RAG', userInput);

    // RAG: Get relevant context
    const ragResults = stockVectorStore.search(userInput, 15);
    
    const relevantStock = ragResults.length > 0 && ragResults[0].similarity > 0.3
      ? ragResults.map(r => stockCache[r.metadata.index])
      : stockCache;
    
    Logger.debug(`Using ${relevantStock.length} items for Gemini context`);
    
    // Build stock catalog
    const processedStock = preprocessStockForAI(relevantStock);
    const stockCatalog = processedStock.map((item, idx) => {
      let desc = `[${idx}] ${item.original}`;
      desc += ` | ${item.price}฿/${item.unit} | สต็อก ${item.stock}`;
      if (item.category && item.category !== 'อื่นๆ') desc += ` | ${item.category}`;
      return desc;
    }).join('\n');

    // Try customer RAG search
    let customerContext = '';
    const customerResults = customerVectorStore.search(userInput, 1);
    if (customerResults.length > 0 && customerResults[0].similarity > 0.5) {
      customerContext = `\n\n💡 ลูกค้าในระบบ: ${customerResults[0].metadata.name}`;
    }

    // Define response schema
    const schema = {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['order', 'add_stock', 'unclear'] },
        matched_stock_index: { 
          type: 'integer',
          description: `เลขดัชนี 0 ถึง ${processedStock.length - 1}`
        },
        quantity: { type: 'integer', description: 'จำนวนที่สั่ง' },
        customer: { type: 'string', description: 'ชื่อลูกค้า ถ้าไม่มี = "ไม่ระบุ"' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        reasoning: { type: 'string' }
      },
      required: ['action', 'matched_stock_index', 'quantity', 'customer', 'confidence', 'reasoning']
    };

    const prompt = `คุณคือ AI ผู้เชี่ยวชาญระบบ ERP ร้านขายน้ำแข็ง

📋 สินค้าที่เกี่ยวข้อง (เลือกจาก index 0-${processedStock.length - 1}):
${stockCatalog}${customerContext}

🎯 คำสั่ง: "${userInput}"

⚠️ กฎสำคัญ:
1. ตัวเลขท้ายชื่อสินค้า (เช่น "หลอดใหญ่ 45") = ราคา ไม่ใช่จำนวน
2. จำนวน = ตัวเลขแยกจากชื่อสินค้า เช่น "หลอด 2 อัน" → quantity: 2
3. ถ้ามีคำว่า "ลุง", "พี่", "คุณ" นำหน้า → นี่คือชื่อลูกค้า ไม่ใช่ส่วนของชื่อสินค้า
4. "หนึ่ง"=1, "สอง"=2, "สาม"=3, "สี่"=4, "ห้า"=5, ฯลฯ
5. **CRITICAL**: matched_stock_index ต้องอยู่ระหว่าง 0-${processedStock.length - 1} เท่านั้น!

ตอบเป็น JSON`;

    const result = await retryWithBackoff(async () => {
      return await generateWithGemini(prompt, schema);
    }, 2, 1000);

    // Validate result
    const localIndex = result.matched_stock_index;
    
    if (localIndex < 0 || localIndex >= processedStock.length) {
      Logger.error(`Invalid index: ${localIndex}, valid range: 0-${processedStock.length - 1}`);
      return fallbackParserWithRAG(userInput, stockCache);
    }

    const originalStockItem = relevantStock[localIndex];
    
    if (!originalStockItem) {
      Logger.error('Could not map back to original stock');
      return fallbackParserWithRAG(userInput, stockCache);
    }

    Logger.success(`Gemini+RAG: "${originalStockItem.item}" (confidence: ${result.confidence})`);

    return {
      success: true,
      action: result.action || 'order',
      stockItem: originalStockItem,
      matchedName: originalStockItem.item,
      quantity: result.quantity || 1,
      customer: result.customer || 'ไม่ระบุ',
      confidence: result.confidence || 'medium',
      reasoning: result.reasoning || '',
      usedRAG: true
    };

  } catch (error) {
    Logger.error('Gemini error', error);
    return fallbackParserWithRAG(userInput, stockCache);
  }
}

// ============================================================================
// FALLBACK PARSER WITH RAG
// ============================================================================

function fallbackParserWithRAG(text, stockCache) {
  PerformanceMonitor.start('fallbackParserWithRAG');
  Logger.info('Using RAG-enhanced fallback parser', text);
  
  const normalized = normalizeText(text);
  
  // Extract quantity
  const { quantity, matched: quantityStr } = extractQuantity(text);
  
  // Extract customer with RAG
  let customer = 'ไม่ระบุ';
  const customerResults = customerVectorStore.search(text, 1);
  if (customerResults.length > 0 && customerResults[0].similarity > 0.5) {
    customer = customerResults[0].metadata.name;
    Logger.success(`RAG matched customer: ${customer}`);
  } else {
    customer = extractCustomerName(text);
  }
  
  // Remove noise for product matching
  const searchText = text
    .toLowerCase()
    .replace(new RegExp(customer, 'gi'), '')
    .replace(quantityStr, '')
    .replace(/สั่ง|ซื้อ|เอา|ขอ|ส่ง|โดย|ให้|ถึง/gi, '')
    .trim();
  
  // Use RAG to find best matches
  const ragResults = stockVectorStore.search(searchText, 10);
  
  if (ragResults.length === 0) {
    PerformanceMonitor.end('fallbackParserWithRAG');
    return {
      success: false,
      error: 'ไม่พบสินค้าที่ตรงกัน ลองพิมพ์ชัดๆ นะคะ'
    };
  }

  const bestMatch = ragResults[0];
  const bestItem = stockCache[bestMatch.metadata.index];
  const bestScore = bestMatch.similarity * 100;

  Logger.info(`RAG best match: "${bestItem.item}" (score: ${bestScore.toFixed(1)})`);

  PerformanceMonitor.end('fallbackParserWithRAG');

  return {
    success: true,
    action: 'order',
    stockItem: bestItem,
    matchedName: bestItem.item,
    quantity,
    customer,
    confidence: bestScore > 70 ? 'high' : bestScore > 50 ? 'medium' : 'low',
    reasoning: `RAG match (score: ${bestScore.toFixed(1)})`,
    usedRAG: true
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function preprocessStockForAI(stockCache) {
  return stockCache.map((item, index) => {
    const pricePatterns = [
      /(\d+)\s*บาท$/,
      /(\d+)\s*฿$/,
      /\s+(\d+)$/,
      /(\d+)\s*$(?!\d)/
    ];
    
    let priceInName = null;
    let cleanName = item.item.trim();
    
    for (const pattern of pricePatterns) {
      const match = item.item.match(pattern);
      if (match) {
        priceInName = parseInt(match[1]);
        cleanName = item.item.replace(pattern, '').trim();
        break;
      }
    }
    
    return {
      original: item.item,
      clean: cleanName,
      price: item.price,
      unit: item.unit,
      stock: item.stock,
      sku: item.sku,
      cost: item.cost,
      category: item.category,
      hasPrice: priceInName !== null,
      priceInName,
      index
    };
  });
}

function extractQuantity(text) {
  const quantityPatterns = [
    /(\d+)\s*(?:ถุง|กั๊ก|ขวด|แพ็ค|อัน|ซอง|แผ่น|กล่อง)/i,
    /(?:สอง|ส)\s*(?:ถุง|กั๊ก)/i,
    /(?:สาม)\s*(?:ถุง|กั๊ก)/i,
    /(?:สี่)\s*(?:ถุง|กั๊ก)/i,
    /(?:ห้า|ห่า)\s*(?:ถุง|กั๊ก)/i
  ];
  
  const thaiNumbers = {
    'สอง': 2, 'ส': 2, 'สาม': 3, 'สี่': 4, 
    'ห้า': 5, 'ห่า': 5, 'หก': 6, 'เจ็ด': 7, 
    'แปด': 8, 'เก้า': 9, 'สิบ': 10
  };
  
  for (const pattern of quantityPatterns) {
    const match = text.match(pattern);
    if (match) {
      if (match[1]) {
        return { quantity: parseInt(match[1]), matched: match[0] };
      }
      for (const [word, num] of Object.entries(thaiNumbers)) {
        if (match[0].includes(word)) {
          return { quantity: num, matched: match[0] };
        }
      }
    }
  }
  
  return { quantity: 1, matched: '' };
}

function extractCustomerName(text) {
  const customerPatterns = [
    /^([ก-๙]+)\s+(?:สั่ง|ซื้อ|เอา|ขอ)/i,
    /(?:คุณ|เจ้|พี่|น้อง)\s*([ก-๙]+)/i,
    /ส่ง\s*(?:โดย|ให้)?\s*([ก-๙]+)/i,
  ];
  
  for (const pattern of customerPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  
  return 'ไม่ระบุ';
}

module.exports = {
  parseOrder
};
