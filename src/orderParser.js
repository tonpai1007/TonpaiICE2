// ============================================================================
// ULTRA-ACCURATE ORDER PARSER
// ============================================================================

const { Logger, PerformanceMonitor } = require('./logger');
const { generateWithGemini, getGemini } = require('./aiServices');
const { stockVectorStore, customerVectorStore } = require('./vectorStore');
const { getStockCache, getCustomerCache } = require('./cacheManager');

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
// GEMINI PARSER - ULTRA ACCURATE
// ============================================================================

async function parseOrderWithGemini(userInput, stockCache) {
  try {
    Logger.info('Starting ultra-accurate Gemini parse', userInput);

    // Step 1: Get ALL customers for better matching
    const customerCache = getCustomerCache();
    const customerResults = customerVectorStore.search(userInput, 10);
    
    let detectedCustomer = null;
    let highestCustomerScore = 0;
    
    // Find best customer match
    for (const result of customerResults) {
      if (result.similarity > highestCustomerScore) {
        highestCustomerScore = result.similarity;
        detectedCustomer = result.metadata.name;
      }
    }
    
    if (detectedCustomer && highestCustomerScore > 0.45) {
      Logger.success(`Customer: ${detectedCustomer} (${(highestCustomerScore * 100).toFixed(1)}%)`);
    } else {
      detectedCustomer = null;
    }

    // Step 2: Get TOP 20 relevant products using RAG
    const productQuery = detectedCustomer 
      ? userInput.replace(new RegExp(detectedCustomer, 'gi'), '').trim()
      : userInput;
    
    const ragResults = stockVectorStore.search(productQuery, 20);
    
    const relevantStock = ragResults.length > 0 && ragResults[0].similarity > 0.25
      ? ragResults.map(r => stockCache[r.metadata.index])
      : stockCache.slice(0, 40);
    
    Logger.info(`Using ${relevantStock.length} products for context`);
    
    // Step 3: Build detailed stock catalog
    const stockCatalog = relevantStock.map((item, idx) => {
      return `[${idx}] ${item.item} (${item.category}) | ${item.price}฿/${item.unit} | สต็อก: ${item.stock}`;
    }).join('\n');

    // Step 4: Build customer list
    const customerList = customerCache.slice(0, 20).map(c => c.name).join(', ');

    // Step 5: Enhanced schema
    const schema = {
      type: 'object',
      properties: {
        action: { 
          type: 'string', 
          enum: ['order', 'add_stock', 'unclear']
        },
        customer: { 
          type: 'string',
          description: 'ชื่อลูกค้าที่ชัดเจนที่สุด หรือ "ไม่ระบุ"'
        },
        delivery_person: {
          type: 'string',
          description: 'ชื่อผู้ส่ง (ถ้ามีคำว่า "ส่งโดย", "ให้...ส่ง") หรือ ""'
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              matched_stock_index: { type: 'integer' },
              quantity: { type: 'integer' },
              confidence: {
                type: 'string',
                enum: ['high', 'medium', 'low']
              },
              reasoning: { type: 'string' }
            },
            required: ['matched_stock_index', 'quantity', 'confidence', 'reasoning']
          }
        },
        payment_status: {
          type: 'string',
          enum: ['cash', 'credit']
        }
      },
      required: ['action', 'customer', 'delivery_person', 'items', 'payment_status']
    };

    // Step 6: Ultra-precise prompt
    const prompt = `คุณคือ AI ผู้เชี่ยวชาญระบบคำสั่งซื้อร้านน้ำแข็ง ที่มีความแม่นยำสูงสุด

📋 รายการสินค้าทั้งหมด (index: 0-${relevantStock.length - 1}):
${stockCatalog}

👥 รายชื่อลูกค้าในระบบ:
${customerList}
${detectedCustomer ? `\n✅ ระบบตรวจพบว่าน่าจะเป็น: "${detectedCustomer}" (ความมั่นใจ ${(highestCustomerScore * 100).toFixed(0)}%)` : ''}

🎯 คำสั่งจากลูกค้า: "${userInput}"

⚠️ กฎการวิเคราะห์ที่เข้มงวด:

1. **ชื่อลูกค้า (CRITICAL)**:
   - ต้องหาชื่อที่ชัดเจนที่สุด
   - ชื่อที่ขึ้นต้นด้วย "พี่", "น้อง", "คุณ", "ลุง", "ป้า" = ลูกค้า
   - ตัวอย่าง: "พี่กาแฟ" → customer: "กาแฟ" หรือ "พี่กาแฟ"
   - ถ้าไม่แน่ใจ → ใช้ชื่อที่ระบบตรวจพบ
   - ไม่มีเลย → "ไม่ระบุ"

2. **ผู้ส่ง (delivery_person)**:
   - หาคำว่า: "ส่งโดย X", "ให้ X ส่ง", "โดย X", "ฝาก X ส่ง"
   - ตัวอย่าง: 
     - "ส่งโดยพี่หมู" → "พี่หมู"
     - "ให้น้องแดงส่ง" → "น้องแดง"
     - "โดยลุงเล็ก" → "ลุงเล็ก"
   - ไม่มี → ""

3. **การจับคู่สินค้า (ULTRA PRECISE)**:
   - ต้องตรงทุกคำ ไม่เดา
   - "น้ำแข็งหลอดใหญ่" ≠ "น้ำแข็งหลอดเล็ก" (ห้ามสลับ!)
   - "น้ำแข็งแผ่น" ≠ "น้ำแข็งเกร็ด" (ห้ามสลับ!)
   - "น้ำแข็งบดละเอียด" ≠ "น้ำแข็งบดหยาบ" (ห้ามสลับ!)
   - ถ้าลูกค้าพูด "น้ำแข็ง" อย่างเดียว (ไม่ระบุประเภท):
     → confidence: "low"
     → reasoning: "ลูกค้าไม่ระบุประเภทน้ำแข็งชัดเจน"

4. **จำนวน**:
   - ตัวเลข + หน่วยนับ (ถุง, กระสอบ, ขวด, กระป๋อง) = จำนวน
   - "2 ถุง" → quantity: 2
   - "สามกระป๋อง" → quantity: 3
   - ไม่ระบุ → quantity: 1

5. **Multi-Item Detection**:
   - หาคำว่า "กับ", "และ", "แล้วก็", "อีก"
   - ตัวอย่าง: "น้ำแข็ง 2 ถุง กับ เบียร์ 5 กระป๋อง"
     → items: [{...}, {...}]

6. **Payment Status**:
   - มีคำว่า "เครดิต" → "credit"
   - ไม่มี → "cash"

ตัวอย่างที่ถูกต้อง:

Input: "พี่กาแฟ สั่งน้ำแข็งหลอดใหญ่ 2 ถุง ส่งโดยพี่หมู"
Output: {
  customer: "กาแฟ",
  delivery_person: "พี่หมู",
  items: [{
    matched_stock_index: (index ของ "น้ำแข็งหลอดใหญ่"),
    quantity: 2,
    confidence: "high",
    reasoning: "ระบุประเภทชัดเจน: หลอดใหญ่"
  }]
}

Input: "คุณสมชาย น้ำแข็ง 3 ถุง"
Output: {
  customer: "สมชาย",
  delivery_person: "",
  items: [{
    matched_stock_index: (เลือกน้ำแข็งที่เป็นไปได้มากที่สุด),
    quantity: 3,
    confidence: "low",
    reasoning: "ไม่ระบุประเภทน้ำแข็ง (หลอดใหญ่/เล็ก/เกร็ด/แผ่น)"
  }]
}

⚠️ CRITICAL: matched_stock_index ต้องอยู่ในช่วง 0-${relevantStock.length - 1} เท่านั้น!

ตอบเป็น JSON`;

    // Step 7: Call Gemini with very low temperature
    const result = await generateWithGemini(prompt, schema, 0.01);

    // Step 8: Validate
    if (!result.items || result.items.length === 0) {
      Logger.error('No items returned');
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
        hasError = true;
        break;
      }

      validatedItems.push({
        stockItem: matchedItem,
        quantity: item.quantity || 1,
        confidence: item.confidence || 'medium',
        reasoning: item.reasoning || ''
      });

      Logger.success(`✓ ${matchedItem.item} x${item.quantity} (${item.confidence})`);
    }

    if (hasError) {
      return fallbackParserWithRAG(userInput, stockCache);
    }

    const finalCustomer = detectedCustomer || result.customer || 'ไม่ระบุ';
    const deliveryPerson = result.delivery_person || '';

    Logger.success(`✓ Customer="${finalCustomer}", Delivery="${deliveryPerson}", Items=${validatedItems.length}`);

    let warning = null;
    const lowConfItems = validatedItems.filter(i => i.confidence === 'low');
    if (lowConfItems.length > 0) {
      warning = `⚠️ ระบบไม่แน่ใจในสินค้า ${lowConfItems.length} รายการ:\n` +
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
// FALLBACK PARSER
// ============================================================================

function fallbackParserWithRAG(text, stockCache) {
  PerformanceMonitor.start('fallbackParserWithRAG');
  Logger.info('Using fallback parser', text);
  
  const customerResults = customerVectorStore.search(text, 1);
  let customer = 'ไม่ระบุ';
  
  if (customerResults.length > 0 && customerResults[0].similarity > 0.5) {
    customer = customerResults[0].metadata.name;
  }
  
  let deliveryPerson = '';
  const deliveryMatch = text.match(/(?:ส่งโดย|โดย|ให้|ฝาก)(.+?)(?:ส่ง|นำ|เอา|$)/i);
  if (deliveryMatch) {
    deliveryPerson = deliveryMatch[1].trim().replace(/พี่|น้อง|คุณ|ลุง|ป้า/gi, '').trim();
  }
  
  const { quantity } = extractQuantity(text);
  
  const searchText = text
    .toLowerCase()
    .replace(new RegExp(customer, 'gi'), '')
    .replace(/สั่ง|ซื้อ|เอา|ขอ|ส่ง|โดย|ให้|พี่|น้อง|คุณ|ลุง|ป้า|เครดิต|\d+/gi, '')
    .trim();
  
  const ragResults = stockVectorStore.search(searchText, 5);
  
  if (ragResults.length === 0) {
    PerformanceMonitor.end('fallbackParserWithRAG');
    return {
      success: false,
      error: '❌ ไม่พบสินค้า กรุณาพิมพ์ชื่อสินค้าให้ชัดเจน'
    };
  }

  const bestMatch = ragResults[0];
  const bestItem = stockCache[bestMatch.metadata.index];
  const bestScore = bestMatch.similarity * 100;

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
        reasoning: `Fallback (${bestScore.toFixed(1)}%)`
      }
    ],
    warning: bestScore < 60 ? `⚠️ ระบบไม่แน่ใจ (${bestScore.toFixed(1)}%)` : null,
    usedRAG: true
  };
}

function extractQuantity(text) {
  const thaiNumbers = {
    'หนึ่ง': 1, 'นึ่ง': 1, 'สอง': 2, 'สาม': 3, 'สี่': 4, 
    'ห้า': 5, 'หก': 6, 'เจ็ด': 7, 'แปด': 8, 'เก้า': 9, 'สิบ': 10
  };
  
  const digitMatch = text.match(/(\d+)\s*(?:ถุง|กระสอบ|แพ็ค|ขวด|อัน|กล่อง|กระป๋อง|ซอง)/i);
  if (digitMatch) {
    return { quantity: parseInt(digitMatch[1]), matched: digitMatch[0] };
  }
  
  for (const [thai, num] of Object.entries(thaiNumbers)) {
    const pattern = new RegExp(`(${thai})\\s*(?:ถุง|กระสอบ|แพ็ค|ขวด|อัน|กล่อง)`, 'i');
    const match = text.match(pattern);
    if (match) {
      return { quantity: num, matched: match[0] };
    }
  }
  
  return { quantity: 1, matched: '' };
}

module.exports = { parseOrder };