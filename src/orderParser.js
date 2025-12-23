// ============================================================================
// IMPROVED ORDER PARSER - orderParser.js
// ============================================================================

const { Logger, PerformanceMonitor } = require('./logger');
const { normalizeText, similarity } = require('./utils');
const { generateWithGemini, getGemini } = require('./aiServices');
const { stockVectorStore, customerVectorStore } = require('./vectorStore');
const { getStockCache, getCustomerCache } = require('./cacheManager');

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
// GEMINI PARSER WITH ENHANCED PROMPTING
// ============================================================================

async function parseOrderWithGemini(userInput, stockCache) {
  try {
    Logger.info('Starting Gemini parse with customer context', userInput);

    // Step 1: Extract customer using RAG
    const customerResults = customerVectorStore.search(userInput, 3);
    let detectedCustomer = null;
    
    if (customerResults.length > 0 && customerResults[0].similarity > 0.5) {
      detectedCustomer = customerResults[0].metadata.name;
      Logger.success(`Customer detected: ${detectedCustomer} (${(customerResults[0].similarity * 100).toFixed(1)}%)`);
    }

    // Step 2: Get relevant products using RAG
    const productQuery = detectedCustomer 
      ? userInput.replace(new RegExp(detectedCustomer, 'gi'), '').trim()
      : userInput;
    
    const ragResults = stockVectorStore.search(productQuery, 10);
    
    const relevantStock = ragResults.length > 0 && ragResults[0].similarity > 0.3
      ? ragResults.map(r => stockCache[r.metadata.index])
      : stockCache.slice(0, 20); // Limit to top 20 if no good matches
    
    Logger.info(`Using ${relevantStock.length} products for context`);
    
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

    // Step 5: Define response schema
    const schema = {
      type: 'object',
      properties: {
        action: { 
          type: 'string', 
          enum: ['order', 'add_stock', 'unclear'],
          description: 'order = สั่งซื้อ, add_stock = เพิ่มสต็อก, unclear = ไม่เข้าใจ'
        },
        matched_stock_index: { 
          type: 'integer',
          description: `Index ของสินค้าที่เลือก (0-${relevantStock.length - 1})`
        },
        quantity: { 
          type: 'integer', 
          description: 'จำนวนที่สั่ง (ถ้าไม่มี = 1)'
        },
        customer: { 
          type: 'string', 
          description: 'ชื่อลูกค้า (ถ้าไม่มี = "ไม่ระบุ")'
        },
        confidence: { 
          type: 'string', 
          enum: ['high', 'medium', 'low'],
          description: 'high = มั่นใจมาก, medium = ปานกลาง, low = ไม่แน่ใจ'
        },
        reasoning: { 
          type: 'string',
          description: 'อธิบายว่าเลือกสินค้านี้เพราะอะไร'
        }
      },
      required: ['action', 'matched_stock_index', 'quantity', 'customer', 'confidence', 'reasoning']
    };

    // Step 6: Build enhanced prompt
    const prompt = `คุณคือ AI ผู้เชี่ยวชาญระบบคำสั่งซื้อร้านน้ำแข็ง

📋 รายการสินค้า (index: 0-${relevantStock.length - 1}):
${stockCatalog}${customerContext}

🎯 คำสั่งจากลูกค้า: "${userInput}"

⚠️ กฎสำคัญในการจับคู่สินค้า:
1. **จำนวน vs ราคา**: 
   - "น้ำแข็งหลอดใหญ่ 45" → ราคา 45 บาท (ไม่ใช่จำนวน 45 ถุง)
   - "น้ำแข็งหลอดใหญ่ 2 ถุง" → จำนวน 2 ถุง

2. **ชื่อลูกค้า**:
   - คำที่มี "พี่", "น้อง", "คุณ", "ลุง" นำหน้า = ชื่อลูกค้า
   - ถ้ามีชื่อที่ตรงกับลูกค้าในระบบ → ใช้ชื่อนั้น
   - ถ้าไม่มีชื่อ → ใช้ "ไม่ระบุ"

3. **การจับคู่สินค้า**:
   - ต้องจับคู่สินค้าที่ **ตรงที่สุด** กับคำสั่ง
   - ถ้าไม่มีคำว่า "หลอดใหญ่", "หลอดเล็ก", "เกร็ด" ระบุชัด → ห้ามเดา
   - ถ้าคำสั่งไม่ชัด → confidence = "low"

4. **ตัวเลข**:
   - ตัวเลขที่อยู่ติดกับหน่วยนับ (ถุง, กระสอบ, ขวด) = จำนวน
   - ตัวเลขที่อยู่ท้ายชื่อสินค้า = ราคา (ไม่ใช่จำนวน)

5. **matched_stock_index**:
   - ต้องอยู่ในช่วง 0-${relevantStock.length - 1} เท่านั้น!

ตัวอย่าง:
- "พี่กาแฟ สั่งน้ำแข็งหลอดใหญ่ 2 ถุง" → customer: "กาแฟ", quantity: 2
- "น้ำแข็ง 3 ถุง" → ไม่ระบุประเภท → confidence: "low"

ตอบเป็น JSON`;

    // Step 7: Call Gemini
    const result = await generateWithGemini(prompt, schema, 0.1);

    // Step 8: Validate response
    const localIndex = result.matched_stock_index;
    
    if (localIndex < 0 || localIndex >= relevantStock.length) {
      Logger.error(`Invalid index: ${localIndex}, valid: 0-${relevantStock.length - 1}`);
      return fallbackParserWithRAG(userInput, stockCache);
    }

    const matchedItem = relevantStock[localIndex];
    
    if (!matchedItem) {
      Logger.error('Could not map to stock item');
      return fallbackParserWithRAG(userInput, stockCache);
    }

    // Step 9: Use detected customer if available
    const finalCustomer = detectedCustomer || result.customer || 'ไม่ระบุ';

    Logger.success(`Gemini result: Customer="${finalCustomer}", Product="${matchedItem.item}", Qty=${result.quantity}, Confidence=${result.confidence}`);
    Logger.info(`Reasoning: ${result.reasoning}`);

    // Step 10: Warning if confidence is low
    let warning = null;
    if (result.confidence === 'low') {
      warning = '⚠️ ระบบไม่แน่ใจในสินค้าที่เลือก กรุณาตรวจสอบอีกครั้ง\n' +
                `เหตุผล: ${result.reasoning}`;
    }

    return {
      success: true,
      action: result.action || 'order',
      stockItem: matchedItem,
      matchedName: matchedItem.item,
      quantity: result.quantity || 1,
      customer: finalCustomer,
      confidence: result.confidence || 'medium',
      reasoning: result.reasoning || '',
      warning: warning,
      usedRAG: true
    };

  } catch (error) {
    Logger.error('Gemini parsing error', error);
    return fallbackParserWithRAG(userInput, stockCache);
  }
}

// ============================================================================
// FALLBACK PARSER WITH RAG
// ============================================================================

function fallbackParserWithRAG(text, stockCache) {
  PerformanceMonitor.start('fallbackParserWithRAG');
  Logger.info('Using fallback parser with RAG', text);
  
  // Extract customer using RAG
  let customer = 'ไม่ระบุ';
  const customerResults = customerVectorStore.search(text, 1);
  
  if (customerResults.length > 0 && customerResults[0].similarity > 0.5) {
    customer = customerResults[0].metadata.name;
    Logger.success(`Fallback: Customer matched - ${customer}`);
  }
  
  // Extract quantity
  const { quantity, matched: quantityStr } = extractQuantity(text);
  
  // Clean text for product search
  const searchText = text
    .toLowerCase()
    .replace(new RegExp(customer, 'gi'), '')
    .replace(quantityStr, '')
    .replace(/สั่ง|ซื้อ|เอา|ขอ|ส่ง|โดย|ให้|พี่|น้อง|คุณ|ลุง|ป้า/gi, '')
    .trim();
  
  // Use RAG to find products
  const ragResults = stockVectorStore.search(searchText, 5);
  
  if (ragResults.length === 0) {
    PerformanceMonitor.end('fallbackParserWithRAG');
    return {
      success: false,
      error: '❌ ไม่พบสินค้าที่ตรงกัน\n\nกรุณาพิมพ์ชื่อสินค้าให้ชัดเจน เช่น:\n• "น้ำแข็งหลอดใหญ่"\n• "น้ำแข็งเกร็ด"\n• "เบียร์ช้าง"'
    };
  }

  const bestMatch = ragResults[0];
  const bestItem = stockCache[bestMatch.metadata.index];
  const bestScore = bestMatch.similarity * 100;

  Logger.info(`Fallback: Best product = "${bestItem.item}" (score: ${bestScore.toFixed(1)})`);

  // Warning if score is low
  let warning = null;
  if (bestScore < 60) {
    warning = '⚠️ ระบบไม่แน่ใจในสินค้า กรุณาตรวจสอบ\n' +
              `คะแนนความตรง: ${bestScore.toFixed(1)}%`;
  }

  PerformanceMonitor.end('fallbackParserWithRAG');

  return {
    success: true,
    action: 'order',
    stockItem: bestItem,
    matchedName: bestItem.item,
    quantity,
    customer,
    confidence: bestScore > 70 ? 'high' : bestScore > 50 ? 'medium' : 'low',
    reasoning: `Fallback RAG match (${bestScore.toFixed(1)}%)`,
    warning: warning,
    usedRAG: true
  };
}

// ============================================================================
// HELPER: EXTRACT QUANTITY
// ============================================================================

function extractQuantity(text) {
  const thaiNumbers = {
    'หนึ่ง': 1, 'นึ่ง': 1, 'นึง': 1,
    'สอง': 2, 'ส': 2,
    'สาม': 3,
    'สี่': 4, 'สี': 4,
    'ห้า': 5,
    'หก': 6,
    'เจ็ด': 7,
    'แปด': 8,
    'เก้า': 9,
    'สิบ': 10
  };
  
  // Try digit with unit
  const digitMatch = text.match(/(\d+)\s*(?:ถุง|กระสอบ|แพ็ค|ขวด|อัน|กล่อง|กระป๋อง|ซอง)/i);
  if (digitMatch) {
    return { quantity: parseInt(digitMatch[1]), matched: digitMatch[0] };
  }
  
  // Try Thai numbers
  for (const [thai, num] of Object.entries(thaiNumbers)) {
    const pattern = new RegExp(`(${thai})\\s*(?:ถุง|กระสอบ|แพ็ค|ขวด|อัน|กล่อง)`, 'i');
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