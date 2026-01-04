const { Logger } = require('./logger');
const { generateWithGroq, getGroq } = require('./aiServices');
const { stockVectorStore } = require('./vectorStore');
const { getStockCache } = require('./cacheManager');

async function parseOrder(userInput) {
  const stockCache = getStockCache();
  if (stockCache.length === 0) return { success: false, error: 'No stock' };

  try {
    if (!getGroq()) return { success: false, confidence: 'low', items: [] };

    // 1. RAG
    const ragResults = stockVectorStore.search(userInput, 20);
    const relevantStock = ragResults.length > 0 
      ? [...new Set(ragResults.map(r => stockCache[r.metadata.index]))] 
      : stockCache;
    
    const stockCatalog = relevantStock.map((item, idx) => `[ID:${idx}] ${item.item}`).join('\n');

    // 2. Prompt for Multi-Item
    const prompt = `
      Task: Extract Thai Order.
      Stock: ${stockCatalog}
      Input: "${userInput}"
      Rules: Extract items, map ID. JSON Only.
      Output: { "items": [{ "stockId": 0, "quantity": 1 }], "customer": "name", "action": "order", "confidence": "high"|"low" }
    `;

    const result = await generateWithGroq(prompt, true);

    // 3. Map
    const mappedItems = [];
    if (result.items) {
      for (const item of result.items) {
        if (item.stockId >= 0 && item.stockId < relevantStock.length) {
          mappedItems.push({
            stockItem: relevantStock[item.stockId],
            quantity: item.quantity || 1
          });
        }
      }
    }

    return {
      success: true,
      items: mappedItems,
      customer: result.customer || 'ไม่ระบุ',
      action: result.action || 'order',
      confidence: mappedItems.length > 0 ? result.confidence : 'low'
    };
  } catch (error) {
    Logger.error('Parse Error', error);
    return { success: false, confidence: 'low', items: [] };
  }
}

module.exports = { parseOrder };
