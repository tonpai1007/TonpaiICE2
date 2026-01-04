// src/orderParser.js (Final JSON Prompt Version)
const { Logger } = require('./logger');
const { generateWithGroq, getGroq } = require('./aiServices');
const { stockVectorStore, customerVectorStore } = require('./vectorStore');
const { getStockCache } = require('./cacheManager');

async function parseOrder(userInput) {
  const stockCache = getStockCache();
  
  // Safety Check
  if (!stockCache.length) return { success: false, error: 'No stock loaded' };
  if (!getGroq()) return { success: false, confidence: 'low', items: [] };

  try {
    // 1. RAG Search (หาของที่เกี่ยวข้องมาทำ Catalog)
    const ragResults = stockVectorStore.search(userInput, 20);
    const relevantStock = ragResults.length > 0 
      ? [...new Set(ragResults.map(r => stockCache[r.metadata.index]))] 
      : stockCache; // ถ้าหาไม่เจอ ให้เอามาหมด (หรือเอามาบางส่วน)

    // สร้างรายการสินค้าอ้างอิง: [ID:0] น้ำแข็งหลอด (50฿)
    const stockCatalog = relevantStock.map((item, idx) => `[ID:${idx}] ${item.item}`).join('\n');

    // 2. Prompt Construction (JSON Instruction)
    const prompt = `
    You are an Order Parser for a Thai Ice Shop.
    
    STOCK CATALOG (Reference Only):
    ${stockCatalog}

    RULES:
    1. Extract items mapping to [ID]. If item not in catalog, stockId = -1.
    2. Default quantity = 1. Handle Thai numbers (สอง=2, โหล=12).
    3. Action: "order" or "cancel" (if "ยกเลิก #123").
    4. Confidence: "high" ONLY if stockId is valid for all items.
    
    USER INPUT: "${userInput}"

    RESPOND WITH THIS JSON FORMAT ONLY:
    {
      "action": "order",
      "items": [{ "stockId": 0, "quantity": 1 }],
      "customer": "string",
      "paymentStatus": "cash",
      "orderRef": "string (if cancel)",
      "confidence": "high"
    }
    `;

    // 3. Call AI
    const result = await generateWithGroq(prompt, true); // true = Force JSON

    // 4. Map IDs back to Real Objects
    const mappedItems = [];
    if (result.items && Array.isArray(result.items)) {
      for (const item of result.items) {
        // ต้องมี ID และ ID ต้องอยู่ใน Range ที่ส่งไป
        if (item.stockId !== undefined && item.stockId >= 0 && item.stockId < relevantStock.length) {
          mappedItems.push({
            stockItem: relevantStock[item.stockId],
            quantity: item.quantity || 1
          });
        }
      }
    }

    // 5. Final Decision Logic
    // ถ้า AI บอก High แต่หา ID ไม่เจอเลย -> ปรับเป็น Low
    let finalConfidence = result.confidence || 'low';
    if (result.action === 'order' && mappedItems.length === 0) {
      finalConfidence = 'low';
    }

    return {
      success: true,
      action: result.action || 'order',
      items: mappedItems,
      customer: result.customer || 'ไม่ระบุ',
      paymentStatus: result.paymentStatus || 'cash',
      orderRef: result.orderRef || null,
      confidence: finalConfidence
    };

  } catch (error) {
    Logger.error('Parser Error', error);
    // Fallback: ถ้า AI พัง ให้ส่งกลับแบบ Low Confidence เพื่อลง Inbox
    return { success: false, confidence: 'low', items: [], error: error.message };
  }
}

module.exports = { parseOrder };