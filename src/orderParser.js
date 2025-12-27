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
    
    // STRICTER THRESHOLD: Only accept customer matches above 60%
    const CUSTOMER_MATCH_THRESHOLD = 0.60; // Raised from 0.45
    
    // Find best customer match
    for (const result of customerResults) {
      if (result.similarity > highestCustomerScore) {
        highestCustomerScore = result.similarity;
        detectedCustomer = result.metadata.name;
      }
    }
    
    // Only use if confidence is high enough
    if (detectedCustomer && highestCustomerScore > CUSTOMER_MATCH_THRESHOLD) {
      Logger.success(`Customer: ${detectedCustomer} (${(highestCustomerScore * 100).toFixed(1)}%)`);
    } else {
      if (detectedCustomer) {
        Logger.warn(`Customer match too low: ${detectedCustomer} (${(highestCustomerScore * 100).toFixed(1)}%) - treating as unknown`);
      }
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

    // Step 4: Build customer list with examples
    const customerList = customerCache.slice(0, 30).map(c => c.name).join(', ');
    
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
          description: 'ชื่อลูกค้าที่ชัดเจนที่สุด หรือ "ไม่ระบุ" ถ้าไม่มีในระบบ'
        },
        customer_confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'ความมั่นใจในการจับคู่ลูกค้า'
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
      required: ['action', 'customer', 'customer_confidence', 'delivery_person', 'items', 'payment_status']
    };

    // Step 6: Ultra-precise prompt with better customer handling
    const prompt = `คุณคือ AI ผู้เชี่ยวชาญระบบคำสั่งซื้อร้านน้ำแข็ง ที่มีความแม่นยำสูงสุด

📋 รายการสินค้าทั้งหมด (index: 0-${relevantStock.length - 1}):
${stockCatalog}

👥 รายชื่อลูกค้าในระบบทั้งหมด:
${customerList}
${detectedCustomer ? `\n✅ ระบบตรวจพบว่าน่าจะเป็น: "${detectedCustomer}" (ความมั่นใจสูง ${(highestCustomerScore * 100).toFixed(0)}%)` : '\n⚠️ ระบบไม่พบลูกค้าที่ตรงกัน - ใช้ชื่อจากข้อความโดยตรง'}

🎯 คำสั่งจากลูกค้า: "${userInput}"

⚠️ กฎการวิเคราะห์ที่เข้มงวด:

1. **ชื่อลูกค้า (CRITICAL - อ่านให้ดี!):**
   
   วิธีหาชื่อลูกค้า:
   a) ถ้าระบบตรวจพบลูกค้าที่มั่นใจสูง (>60%) → ใช้ชื่อนั้น
   b) ถ้าไม่มีการตรวจพบ หรือความมั่นใจต่ำ:
      - หาชื่อที่มีคำนำหน้า: "พี่", "น้อง", "คุณ", "ลุง", "ป้า", "เจ้า"
      - ตัวอย่าง: "พี่กาแฟ" → customer: "พี่กาแฟ", confidence: "high"
      - ตัวอย่าง: "เจ้นุ้ย" → customer: "เจ้นุ้ย", confidence: "medium"
      - ตัวอย่าง: "น้องแดง" → customer: "น้องแดง", confidence: "high"
   c) ถ้าไม่มีชื่อเลย → customer: "ไม่ระบุ", confidence: "low"
   
   ⚠️ **ห้ามแก้ไขชื่อ หรือ เดาชื่อ!**
   - "เจ้นุ้ย" ≠ "ป้าผัดไทย" (ไม่คล้ายกันเลย!)
   - "พี่หมู" ≠ "พี่มด" (ต่างคนกัน!)
   - ใช้ชื่อตามที่ได้ยิน ไม่ใช่เดา

2. **ผู้ส่ง (delivery_person):**
   - หาคำว่า: "ส่งโดย X", "ให้ X ส่ง", "โดย X", "ฝาก X ส่ง"
   - ตัวอย่าง: 
     - "ส่งโดยพี่หมู" → "พี่หมู"
     - "ให้น้องแดงส่ง" → "น้องแดง"
   - ไม่มี → ""

3. **การจับคู่สินค้า (ULTRA PRECISE):**
   - ต้องตรงทุกคำ ไม่เดา
   - "น้ำแข็งหลอดใหญ่" ≠ "น้ำแข็งหลอดเล็ก" (ห้ามสลับ!)
   - "น้ำแข็งบดหยาบ" ≠ "น้ำแข็งบดละเอียด" (ห้ามสลับ!)
   - ถ้าไม่ชัดเจน → confidence: "low" + อธิบายเหตุผล

4. **จำนวน:**
   - ตัวเลข + หน่วยนับ = จำนวน
   - "2 ถุง" → 2
   - "สามกระป๋อง" → 3
   - ไม่ระบุ → 1

5. **Payment Status:**
   - มีคำว่า "เครดิต" → "credit"
   - ไม่มี → "cash"

ตัวอย่างที่ถูกต้อง:

Input: "เจ้นุ้ย บดหยาบ 3 ถุง"
(ระบบไม่พบลูกค้า "เจ้นุ้ย" ในฐานข้อมูล)
Output: {
  customer: "เจ้นุ้ย",
  customer_confidence: "medium",
  items: [{
    matched_stock_index: (index ของ "น้ำแข็งบดหยาบ"),
    quantity: 3,
    confidence: "high",
    reasoning: "จับคู่กับ น้ำแข็งบดหยาบ ชัดเจน"
  }]
}

Input: "พี่กาแฟ น้ำแข็ง 2"
(มี "พี่กาแฟ" ในระบบ)
Output: {
  customer: "พี่กาแฟ",
  customer_confidence: "high",
  items: [{
    matched_stock_index: (เลือกน้ำแข็งที่เป็นไปได้),
    quantity: 2,
    confidence: "low",
    reasoning: "ไม่ระบุประเภทน้ำแข็งชัดเจน"
  }]
}

⚠️ สำคัญ:
- matched_stock_index ต้องอยู่ในช่วง 0-${relevantStock.length - 1}
- ใช้ชื่อลูกค้าตามที่ได้ยิน ไม่ใช่เดาจากฐานข้อมูล
- customer_confidence = "high" ถ้ามีในระบบ หรือมีคำนำหน้าชัดเจน
- customer_confidence = "medium" ถ้าเป็นชื่อเฉยๆ ไม่มีในระบบ
- customer_confidence = "low" ถ้าไม่มีชื่อเลย

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

    // Step 9: Final customer decision with override logic
    let finalCustomer = result.customer || 'ไม่ระบุ';
    let customerWarning = null;
    
    // Override if detected customer is high confidence and Gemini returned different
    if (detectedCustomer && highestCustomerScore > 0.70) {
      if (finalCustomer !== detectedCustomer && finalCustomer !== 'ไม่ระบุ') {
        Logger.warn(`Gemini suggested "${finalCustomer}" but RAG detected "${detectedCustomer}" with ${(highestCustomerScore * 100).toFixed(1)}% - using RAG`);
        finalCustomer = detectedCustomer;
        customerWarning = `ℹ️ ระบบจับคู่ลูกค้าเป็น "${detectedCustomer}" โดยอัตโนมัติ`;
      }
    }
    
    // Add warning for low confidence customer matches
    if (result.customer_confidence === 'low' || result.customer_confidence === 'medium') {
      if (finalCustomer !== 'ไม่ระบุ') {
        customerWarning = `⚠️ ไม่แน่ใจชื่อลูกค้า: "${finalCustomer}" - ตรวจสอบด้วย`;
      }
    }

    const deliveryPerson = result.delivery_person || '';

    Logger.success(`✓ Customer="${finalCustomer}" (${result.customer_confidence}), Delivery="${deliveryPerson}", Items=${validatedItems.length}`);

    let warning = customerWarning;
    const lowConfItems = validatedItems.filter(i => i.confidence === 'low');
    if (lowConfItems.length > 0) {
      const itemWarning = `⚠️ ระบบไม่แน่ใจในสินค้า ${lowConfItems.length} รายการ:\n` +
                lowConfItems.map(i => `• ${i.stockItem.item}: ${i.reasoning}`).join('\n');
      warning = warning ? `${warning}\n\n${itemWarning}` : itemWarning;
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