// ============================================================================
// REVOLUTIONARY ORDER PARSER - Multi-Item + Delivery Person Detection
// ============================================================================

const { Logger, PerformanceMonitor } = require('./logger');
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
// GEMINI MULTI-ITEM PARSER WITH DELIVERY PERSON
// ============================================================================

async function parseOrderWithGemini(userInput, stockCache) {
  try {
    Logger.info('Starting Gemini multi-item parse', userInput);

    // Step 1: Extract customer using RAG
    const customerResults = customerVectorStore.search(userInput, 5);
    let detectedCustomer = null;
    
    if (customerResults.length > 0 && customerResults[0].similarity > 0.5) {
      detectedCustomer = customerResults[0].metadata.name;
      Logger.success(`Customer: ${detectedCustomer} (${(customerResults[0].similarity * 100).toFixed(1)}%)`);
    }

    // Step 2: Get relevant products using RAG
    const productQuery = detectedCustomer 
      ? userInput.replace(new RegExp(detectedCustomer, 'gi'), '').trim()
      : userInput;
    
    const ragResults = stockVectorStore.search(productQuery, 15);
    
    const relevantStock = ragResults.length > 0 && ragResults[0].similarity > 0.3
      ? ragResults.map(r => stockCache[r.metadata.index])
      : stockCache.slice(0, 30);
    
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

    // Step 5: Enhanced schema for multi-item + delivery person
    const schema = {
      type: 'object',
      properties: {
        action: { 
          type: 'string', 
          enum: ['order', 'add_stock', 'unclear'],
          description: 'order = สั่งซื้อ, add_stock = เพิ่มสต็อก, unclear = ไม่เข้าใจ'
        },
        customer: { 
          type: 'string', 
          description: 'ชื่อลูกค้า (ถ้าไม่มี = "ไม่ระบุ")'
        },
        delivery_person: {
          type: 'string',
          description: 'ชื่อผู้ส่ง (ถ้ามีคำว่า "ส่งโดย", "โดย", "ให้...ส่ง" ตามด้วยชื่อ, ถ้าไม่มี = "")'
        },
        items: {
          type: 'array',
          description: 'รายการสินค้าทั้งหมดที่สั่ง (อาจมีหลายรายการ)',
          items: {
            type: 'object',
            properties: {
              matched_stock_index: {
                type: 'integer',
                description: `Index ของสินค้า (0-${relevantStock.length - 1})`
              },
              quantity: {
                type: 'integer',
                description: 'จำนวนที่สั่ง'
              },
              confidence: {
                type: 'string',
                enum: ['high', 'medium', 'low']
              },
              reasoning: {
                type: 'string',
                description: 'เหตุผลที่เลือกสินค้านี้'
              }
            },
            required: ['matched_stock_index', 'quantity', 'confidence', 'reasoning']
          }
        },
        payment_status: {
          type: 'string',
          enum: ['cash', 'credit'],
          description: 'cash = จ่ายปกติ, credit = เครดิต (ถ้ามีคำว่า "เครดิต")'
        }
      },
      required: ['action', 'customer', 'delivery_person', 'items', 'payment_status']
    };

    // Step 6: Build enhanced prompt
    const prompt = `คุณคือ AI ผู้เชี่ยวชาญระบบคำสั่งซื้อร้านน้ำแข็ง

📋 รายการสินค้า (index: 0-${relevantStock.length - 1}):
${stockCatalog}${customerContext}

🎯 คำสั่งจากลูกค้า: "${userInput}"

⚠️ กฎสำคัญ:

1. **ชื่อลูกค้า**:
   - หาชื่อคนที่สั่งของ (อาจมี "พี่", "น้อง", "คุณ" นำหน้า)
   - ถ้าตรงกับลูกค้าในระบบ → ใช้ชื่อนั้น
   - ถ้าไม่มี → "ไม่ระบุ"

2. **ผู้ส่ง (delivery_person)**:
   - หาคำว่า "ส่งโดย", "โดย", "ให้...ส่ง", "ฝาก...ส่ง"
   - ตัวอย่าง: "ส่งโดยพี่หมู" → delivery_person: "พี่หมู"
   - ตัวอย่าง: "ให้น้องแดงส่ง" → delivery_person: "น้องแดง"
   - ถ้าไม่มี → ""

3. **รายการสินค้า (MULTI-ITEM)**:
   - ดูทั้งหมดในคำสั่ง อาจมีหลายรายการ
   - แต่ละรายการต้องมี: สินค้า + จำนวน
   - ตัวอย่าง: "น้ำแข็งหลอด 2 ถุง กับ เบียร์ 5 กระป๋อง"
     → items: [
          {matched_stock_index: X, quantity: 2, ...},
          {matched_stock_index: Y, quantity: 5, ...}
        ]

4. **การจับคู่สินค้า**:
   - ต้องจับคู่ที่แม่นยำที่สุด
   - "น้ำแข็งหลอดใหญ่" ≠ "น้ำแข็งหลอดเล็ก"
   - "น้ำแข็งแผ่น" ≠ "น้ำแข็งเกร็ด"
   - ถ้าไม่ระบุชัดเจน → confidence: "low"

5. **จำนวน**:
   - ตัวเลข + หน่วยนับ (ถุง, กระสอบ, ขวด) = จำนวน
   - ไม่มีระบุ = 1

6. **การชำระเงิน**:
   - มีคำว่า "เครดิต" → payment_status: "credit"
   - ไม่มี → payment_status: "cash"

ตัวอย่าง 1:
Input: "พี่กาแฟ สั่งน้ำแข็งหลอดใหญ่ 2 ถุง กับ เบียร์ช้าง 3 กระป๋อง ส่งโดยพี่หมู"
Output: {
  customer: "กาแฟ",
  delivery_person: "พี่หมู",
  items: [
    {matched_stock_index: X, quantity: 2, confidence: "high"},
    {matched_stock_index: Y, quantity: 3, confidence: "high"}
  ],
  payment_status: "cash"
}

ตัวอย่าง 2:
Input: "คุณสมชาย น้ำแข็ง 5 ถุง เครดิต"
Output: {
  customer: "สมชาย",
  delivery_person: "",
  items: [{matched_stock_index: Z, quantity: 5, confidence: "low"}],
  payment_status: "credit"
}

ตอบเป็น JSON`;

    // Step 7: Call Gemini
    const result = await generateWithGemini(prompt, schema, 0.05);

    // Step 8: Validate ALL items
    if (!result.items || result.items.length === 0) {
      Logger.error('No items returned from Gemini');
      return fallbackParserWithRAG(userInput, stockCache);
    }

    const validatedItems = [];
    let hasError = false;

    for (const item of result.items) {
      const localIndex = item.matched_stock_index;
      
      if (localIndex < 0 || localIndex >= relevantStock.length) {
        Logger.error(`Invalid index: ${localIndex}`);
        hasError = true;
        break;
      }

      const matchedItem = relevantStock[localIndex];
      if (!matchedItem) {
        Logger.error('Could not map to stock item');
        hasError = true;
        break;
      }

      validatedItems.push({
        stockItem: matchedItem,
        quantity: item.quantity || 1,
        confidence: item.confidence || 'medium',
        reasoning: item.reasoning || ''
      });

      Logger.success(`Item: ${matchedItem.item} x${item.quantity} (${item.confidence})`);
    }

    if (hasError) {
      return fallbackParserWithRAG(userInput, stockCache);
    }

    // Step 9: Use detected customer
    const finalCustomer = detectedCustomer || result.customer || 'ไม่ระบุ';
    const deliveryPerson = result.delivery_person || '';

    Logger.success(`Order: Customer="${finalCustomer}", Delivery="${deliveryPerson}", Items=${validatedItems.length}`);

    // Step 10: Build warning if needed
    let warning = null;
    const lowConfItems = validatedItems.filter(i => i.confidence === 'low');
    if (lowConfItems.length > 0) {
      warning = `⚠️ ระบบไม่แน่ใจในสินค้า ${lowConfItems.length} รายการ กรุณาตรวจสอบ:\n` +
                lowConfItems.map(i => `• ${i.stockItem.item}: ${i.reasoning}`).join('\n');
    }

    return {
      success: true,
      action: result.action || 'order',
      customer: finalCustomer,
      deliveryPerson: deliveryPerson,
      paymentStatus: result.payment_status || 'cash',
      items: validatedItems,
      warning: warning,
      usedRAG: true
    };

  } catch (error) {
    Logger.error('Gemini parsing error', error);
    return fallbackParserWithRAG(userInput, stockCache);
  }
}

// ============================================================================
// FALLBACK PARSER (SINGLE ITEM ONLY)
// ============================================================================

function fallbackParserWithRAG(text, stockCache) {
  PerformanceMonitor.start('fallbackParserWithRAG');
  Logger.info('Using fallback parser (single item only)', text);
  
  // Extract customer
  let customer = 'ไม่ระบุ';
  const customerResults = customerVectorStore.search(text, 1);
  
  if (customerResults.length > 0 && customerResults[0].similarity > 0.5) {
    customer = customerResults[0].metadata.name;
    Logger.success(`Fallback: Customer = ${customer}`);
  }
  
  // Extract delivery person
  let deliveryPerson = '';
  const deliveryMatch = text.match(/(?:ส่งโดย|โดย|ให้|ฝาก)(.+?)(?:ส่ง|นำ|เอา|$)/i);
  if (deliveryMatch) {
    deliveryPerson = deliveryMatch[1].trim().replace(/พี่|น้อง|คุณ/gi, '').trim();
    Logger.success(`Fallback: Delivery = ${deliveryPerson}`);
  }
  
  // Extract quantity
  const { quantity, matched: quantityStr } = extractQuantity(text);
  
  // Clean text for product search
  const searchText = text
    .toLowerCase()
    .replace(new RegExp(customer, 'gi'), '')
    .replace(quantityStr, '')
    .replace(/สั่ง|ซื้อ|เอา|ขอ|ส่ง|โดย|ให้|พี่|น้อง|คุณ|ลุง|ป้า|เครดิต/gi, '')
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

  Logger.info(`Fallback: Best = "${bestItem.item}" (${bestScore.toFixed(1)}%)`);

  let warning = null;
  if (bestScore < 60) {
    warning = `⚠️ ระบบไม่แน่ใจในสินค้า (${bestScore.toFixed(1)}%)`;
  }

  PerformanceMonitor.end('fallbackParserWithRAG');

  return {
    success: true,
    action: 'order',
    customer: customer,
    deliveryPerson: deliveryPerson,
    paymentStatus: text.toLowerCase().includes('เครดิต') ? 'credit' : 'cash',
    items: [
      {
        stockItem: bestItem,
        quantity: quantity,
        confidence: bestScore > 70 ? 'high' : bestScore > 50 ? 'medium' : 'low',
        reasoning: `Fallback RAG match (${bestScore.toFixed(1)}%)`
      }
    ],
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