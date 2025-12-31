// orderParser.js - FIXED: Resilient Order Parser with Graceful Degradation

const { Logger, PerformanceMonitor } = require('./logger');
const { normalizeText, similarity } = require('./utils');
const { 
  generateWithGemini, 
  isGeminiAvailable, 
  shouldUseGemini 
} = require('./aiServices');
const { stockVectorStore, customerVectorStore } = require('./vectorStore');
const { getStockCache, getCustomerCache } = require('./cacheManager');

// ============================================================================
// MAIN PARSING FUNCTION - WITH SERVICE HEALTH CHECK
// ============================================================================

async function parseOrder(userInput) {
  const stockCache = getStockCache();
  
  if (stockCache.length === 0) {
    return {
      success: false,
      error: '❌ ยังไม่มีสินค้าในระบบ กรุณาเพิ่มสินค้าก่อน'
    };
  }

  try {
    PerformanceMonitor.start('parseOrder');
    
    // Strategy: Check if Gemini is available, otherwise use RAG fallback
    if (shouldUseGemini()) {
      Logger.info('🧠 Using Gemini AI Parser');
      try {
        const result = await parseOrderWithGemini(userInput, stockCache);
        PerformanceMonitor.end('parseOrder');
        return result;
      } catch (geminiError) {
        // If Gemini fails, log the error and fall back to RAG
        Logger.warn(`⚠️ Gemini parsing failed: ${geminiError.message}`);
        Logger.info('🔄 Falling back to RAG parser...');
        
        if (geminiError.code === 'QUOTA_EXCEEDED') {
          Logger.warn('💢 Gemini quota exceeded - using RAG fallback');
        }
        
        const result = fallbackParserWithRAG(userInput, stockCache);
        PerformanceMonitor.end('parseOrder');
        return result;
      }
    } else {
      Logger.info('📊 Using RAG-only parser (Gemini unavailable)');
      const result = fallbackParserWithRAG(userInput, stockCache);
      PerformanceMonitor.end('parseOrder');
      return result;
    }
  } catch (error) {
    Logger.error('❌ parseOrder critical failure', error);
    PerformanceMonitor.end('parseOrder');
    
    // Last resort: basic fallback
    return fallbackParserWithRAG(userInput, stockCache);
  }
}

// ============================================================================
// GEMINI PARSER - ENHANCED ERROR HANDLING
// ============================================================================

async function parseOrderWithGemini(userInput, stockCache) {
  try {
    Logger.info('🔍 Starting Gemini parse with customer context');

    // Step 1: Extract customer using RAG
    const customerResults = customerVectorStore.search(userInput, 3);
    let detectedCustomer = null;
    
    if (customerResults.length > 0 && customerResults[0].similarity > 0.5) {
      detectedCustomer = customerResults[0].metadata.name;
      Logger.success(`✅ Customer detected: ${detectedCustomer} (${(customerResults[0].similarity * 100).toFixed(1)}%)`);
    }

    // Step 2: Get relevant products using RAG
    const productQuery = detectedCustomer 
      ? userInput.replace(new RegExp(detectedCustomer, 'gi'), '').trim()
      : userInput;
    
    const ragResults = stockVectorStore.search(productQuery, 15); // Increased from 10 to 15
    
    const relevantStock = ragResults.length > 0 && ragResults[0].similarity > 0.3
      ? ragResults.map(r => stockCache[r.metadata.index])
      : stockCache.slice(0, 30); // Increased fallback from 20 to 30
    
    Logger.info(`📦 Using ${relevantStock.length} products for context`);
    
    // Step 3: Build stock catalog
    const stockCatalog = relevantStock.map((item, idx) => {
      return `[${idx}] ${item.item} | ${item.price}฿/${item.unit} | สต็อก: ${item.stock}`;
    }).join('\n');

    // Step 4: Build customer context
    let customerContext = '';
    if (detectedCustomer) {
      customerContext = `\n\n✅ ลูกค้าที่ตรวจพบ: "${detectedCustomer}"`;
    } else if (customerResults.length > 0) {
      const suggestions = customerResults.slice(0, 3).map(c => c.metadata.name).join(', ');
      customerContext = `\n\n💡 ลูกค้าที่คล้ายกัน: ${suggestions}`;
    }

    // Step 5: Multi-item detection prompt
    const detectionPrompt = `คุณคือ AI ตรวจจับคำสั่งซื้อที่อาจมีหลายรายการ

📝 คำสั่ง: "${userInput}"

ตรวจสอบว่ามี:
1. หลายสินค้า (เช่น "น้ำแข็ง 2 ถุง กับเบียร์ 5 กระป๋อง")
2. คำว่า "กับ", "และ", "แล้วก็", "อีก", "เพิ่ม"

ตอบเป็น JSON:
{
  "isMultiItem": true/false,
  "itemCount": จำนวนสินค้า,
  "splitSuggestion": ["รายการ 1", "รายการ 2", ...]
}`;

    // Check if multi-item order
    const detectionSchema = {
      type: 'object',
      properties: {
        isMultiItem: { type: 'boolean' },
        itemCount: { type: 'integer' },
        splitSuggestion: { type: 'array', items: { type: 'string' } }
      },
      required: ['isMultiItem', 'itemCount']
    };

    let detection;
    try {
      detection = await generateWithGemini(detectionPrompt, detectionSchema, 0.1);
    } catch (detectionError) {
      Logger.warn('⚠️ Multi-item detection failed, assuming single item');
      detection = { isMultiItem: false, itemCount: 1 };
    }

    Logger.info(`🔎 Detection: Multi-item=${detection.isMultiItem}, Count=${detection.itemCount}`);

    // Handle multi-item order - FIXED: Pass stockCache and customer
    if (detection.isMultiItem && detection.itemCount > 1) {
      return await parseMultiItemOrder(
        userInput, 
        stockCache, 
        detection, 
        detectedCustomer,
        relevantStock // Pass the relevant stock context
      );
    }

    // Single item parsing
    const schema = {
      type: 'object',
      properties: {
        action: { 
          type: 'string', 
          enum: ['order', 'add_stock', 'unclear']
        },
        matched_stock_index: { type: 'integer' },
        quantity: { type: 'integer' },
        customer: { type: 'string' },
        deliveryPerson: { type: 'string' },
        paymentStatus: { 
          type: 'string',
          enum: ['cash', 'credit', 'unpaid']
        },
        confidence: { 
          type: 'string', 
          enum: ['high', 'medium', 'low']
        },
        reasoning: { type: 'string' }
      },
      required: ['action', 'matched_stock_index', 'quantity', 'customer', 'confidence', 'reasoning']
    };

    const prompt = `คุณคือ AI ผู้เชี่ยวชาญระบบคำสั่งซื้อร้านน้ำแข็ง

📋 รายการสินค้า (index: 0-${relevantStock.length - 1}):
${stockCatalog}${customerContext}

🎯 คำสั่งจากลูกค้า: "${userInput}"

⚠️ กฎสำคัญ:
1. จำนวน vs ราคา: "น้ำแข็ง 45" = ราคา 45฿, "น้ำแข็ง 2 ถุง" = จำนวน 2
2. ชื่อลูกค้า: หาคำนำหน้า พี่/น้อง/คุณ
3. matched_stock_index ต้องอยู่ใน 0-${relevantStock.length - 1}
4. ⚠️ สำคัญมาก: ถ้าไม่พบสินค้าในรายการ ให้ใส่ -1 และตั้ง action='unclear'
5. การชำระ: หาคำว่า "เครดิต" = credit, "จ่ายแล้ว" = cash, ไม่มี = unpaid
6. ผู้ส่ง: หา "ส่ง[ชื่อ]" หรือ "โดย[ชื่อ]"

ตอบเป็น JSON`;

    const result = await generateWithGemini(prompt, schema, 0.1);

    // 🔥 FIX: Handle -1 index (product not found)
    const localIndex = result.matched_stock_index;
    
    if (localIndex === -1 || result.action === 'unclear') {
      Logger.warn(`⚠️ Gemini couldn't find product in catalog - falling back to RAG`);
      throw new Error('PRODUCT_NOT_FOUND');
    }
    
    if (localIndex < 0 || localIndex >= relevantStock.length) {
      Logger.error(`❌ Invalid index: ${localIndex} (valid range: 0-${relevantStock.length - 1})`);
      throw new Error('INVALID_INDEX');
    }

    const matchedItem = relevantStock[localIndex];
    const finalCustomer = detectedCustomer || result.customer || 'ไม่ระบุ';

    Logger.success(`✅ Parsed: ${finalCustomer} | ${matchedItem.item} x${result.quantity}`);

    return {
      success: true,
      action: result.action || 'order',
      stockItem: matchedItem,
      matchedName: matchedItem.item,
      quantity: result.quantity || 1,
      customer: finalCustomer,
      deliveryPerson: result.deliveryPerson || '',
      paymentStatus: result.paymentStatus || 'unpaid',
      confidence: result.confidence || 'medium',
      reasoning: result.reasoning || '',
      warning: result.confidence === 'low' ? '⚠️ ระบบไม่แน่ใจ กรุณาตรวจสอบ' : null,
      usedAI: true
    };

  } catch (error) {
    Logger.error('❌ Gemini parsing error', error);
    
    // Re-throw with code for upstream handling
    if (error.message === 'PRODUCT_NOT_FOUND' || error.message === 'INVALID_INDEX') {
      throw new Error('GEMINI_PARSE_FAILED');
    }
    
    if (error.code === 'SERVICE_UNAVAILABLE' || 
        error.code === 'QUOTA_EXCEEDED' ||
        error.code === 'TIMEOUT') {
      throw error;
    }
    
    // For other errors, use fallback
    throw new Error('GEMINI_PARSE_FAILED');
  }
}

// ============================================================================
// MULTI-ITEM ORDER PARSER - FIXED
// ============================================================================

async function parseMultiItemOrder(userInput, stockCache, detection, detectedCustomer, relevantStock = null) {
  Logger.info(`🔄 Parsing ${detection.itemCount} items...`);
  
  const items = [];
  let deliveryPerson = '';
  let paymentStatus = 'unpaid';
  
  // Extract global info
  if (userInput.toLowerCase().includes('เครดิต')) paymentStatus = 'credit';
  if (userInput.toLowerCase().includes('จ่ายแล้ว')) paymentStatus = 'cash';
  
  const deliveryMatch = userInput.match(/(?:ส่ง|โดย)\s*([ก-๙a-zA-Z]+)/);
  if (deliveryMatch) deliveryPerson = deliveryMatch[1];
  
  // Parse each item using RAG fallback (more reliable for sub-items)
  for (const itemText of detection.splitSuggestion || []) {
    try {
      Logger.info(`🧠 Parsing sub-item: "${itemText}"`);
      
      // Use RAG fallback for sub-items to avoid recursive Gemini calls
      const itemResult = fallbackParserWithRAG(itemText, stockCache);
      
      if (itemResult.success && itemResult.stockItem) {
        items.push({
          stockItem: itemResult.stockItem,
          quantity: itemResult.quantity
        });
        Logger.success(`✅ Parsed: ${itemResult.stockItem.item} x${itemResult.quantity}`);
      } else {
        Logger.warn(`⚠️ Failed to parse item: "${itemText}" - ${itemResult.error || 'unknown error'}`);
      }
    } catch (itemError) {
      Logger.warn(`⚠️ Exception parsing item: ${itemText}`, itemError);
    }
  }
  
  // If no items were parsed successfully, throw error
  if (items.length === 0) {
    Logger.error('❌ No items successfully parsed from multi-item order');
    throw new Error('MULTI_ITEM_PARSE_FAILED');
  }
  
  Logger.success(`✅ Parsed ${items.length} items successfully`);
  
  return {
    success: true,
    action: 'order',
    items: items,
    customer: detectedCustomer || 'ไม่ระบุ',
    deliveryPerson: deliveryPerson,
    paymentStatus: paymentStatus,
    confidence: 'medium',
    reasoning: `Multi-item order detected (${items.length} items)`,
    usedAI: true,
    isMultiItem: true
  };
}

// ============================================================================
// FALLBACK PARSER WITH RAG
// ============================================================================

function fallbackParserWithRAG(text, stockCache) {
  PerformanceMonitor.start('fallbackParserWithRAG');
  Logger.info('📊 Using RAG fallback parser');
  
  // Extract customer
  let customer = 'ไม่ระบุ';
  const customerResults = customerVectorStore.search(text, 1);
  if (customerResults.length > 0 && customerResults[0].similarity > 0.5) {
    customer = customerResults[0].metadata.name;
  }
  
  // Extract quantity
  const { quantity, matched: quantityStr } = extractQuantity(text);
  
  // Clean text
  const searchText = text
    .toLowerCase()
    .replace(new RegExp(customer, 'gi'), '')
    .replace(quantityStr, '')
    .replace(/สั่ง|ซื้อ|เอา|ขอ|ส่ง|โดย|ให้|พี่|น้อง|คุณ/gi, '')
    .trim();
  
  // Search products
  const ragResults = stockVectorStore.search(searchText, 5);
  
  if (ragResults.length === 0) {
    PerformanceMonitor.end('fallbackParserWithRAG');
    return {
      success: false,
      error: '❌ ไม่พบสินค้า กรุณาระบุชื่อสินค้าที่ชัดเจน'
    };
  }

  const bestMatch = ragResults[0];
  const bestItem = stockCache[bestMatch.metadata.index];
  const bestScore = bestMatch.similarity * 100;

  Logger.info(`📦 Best match: ${bestItem.item} (${bestScore.toFixed(1)}%)`);

  PerformanceMonitor.end('fallbackParserWithRAG');

  return {
    success: true,
    action: 'order',
    stockItem: bestItem,
    matchedName: bestItem.item,
    quantity,
    customer,
    deliveryPerson: '',
    paymentStatus: 'unpaid',
    confidence: bestScore > 70 ? 'high' : bestScore > 50 ? 'medium' : 'low',
    reasoning: `RAG fallback (${bestScore.toFixed(1)}%)`,
    warning: bestScore < 60 ? '⚠️ ระบบไม่แน่ใจ กรุณาตรวจสอบ' : null,
    usedAI: false
  };
}

// ============================================================================
// HELPER: EXTRACT QUANTITY
// ============================================================================

function extractQuantity(text) {
  const thaiNumbers = {
    'หนึ่ง': 1, 'นึ่ง': 1, 'สอง': 2, 'สาม': 3, 'สี่': 4, 
    'ห้า': 5, 'หก': 6, 'เจ็ด': 7, 'แปด': 8, 'เก้า': 9, 'สิบ': 10
  };
  
  // Try digit with unit
  const digitMatch = text.match(/(\d+)\s*(?:ถุง|กระสอบ|แพ็ค|ขวด|อัน|กล่อง|กระป๋อง)/i);
  if (digitMatch) {
    return { quantity: parseInt(digitMatch[1]), matched: digitMatch[0] };
  }
  
  // Try Thai numbers
  for (const [thai, num] of Object.entries(thaiNumbers)) {
    const pattern = new RegExp(`(${thai})\\s*(?:ถุง|กระสอบ|แพ็ค|ขวด)`, 'i');
    const match = text.match(pattern);
    if (match) {
      return { quantity: num, matched: match[0] };
    }
  }
  
  return { quantity: 1, matched: '' };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  parseOrder
};