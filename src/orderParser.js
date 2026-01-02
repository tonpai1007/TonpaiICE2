// orderParser.js - Simple order parsing with RAG fallback
const { Logger } = require('./logger');
const { getStockCache, getCustomerCache } = require('./cacheManager');
const { stockVectorStore, customerVectorStore } = require('./vectorStore');
const { normalizeText, extractDigits } = require('./utils');

async function parseOrder(text) {
  try {
    Logger.info(`📝 Parsing: "${text}"`);
    
    // 1. Find customer using RAG
    const customerResults = customerVectorStore.search(text, 3, 0.3);
    let customer = 'ลูกค้า';
    
    if (customerResults.length > 0) {
      customer = customerResults[0].metadata.name;
      Logger.info(`👤 Found customer: ${customer}`);
    } else {
      // Extract first word as customer name
      const words = text.trim().split(/\s+/);
      if (words.length > 0) {
        customer = words[0];
      }
    }
    
    // 2. Find product using RAG from 'สต็อก' sheet
    const stockResults = stockVectorStore.search(text, 5, 0.3);
    
    if (stockResults.length === 0) {
      return {
        success: false,
        error: '❌ ไม่พบสินค้าที่ต้องการ\nกรุณาตรวจสอบชื่อสินค้าอีกครั้ง'
      };
    }
    
    const stockItem = stockResults[0].metadata;
    Logger.info(`📦 Found item: ${stockItem.item}`);
    
    // 3. Extract quantity
    const digits = extractDigits(text);
    
    if (!digits) {
      return {
        success: false,
        error: '❌ กรุณาระบุจำนวนสินค้า\nเช่น: "สมชาย สั่งน้ำแข็ง 2 ถุง"'
      };
    }
    
    const quantity = parseInt(digits);
    
    if (quantity <= 0 || quantity > 10000) {
      return {
        success: false,
        error: '❌ จำนวนไม่ถูกต้อง (1-10000)'
      };
    }
    
    // 4. Check for delivery person
    let deliveryPerson = '';
    const deliveryMatch = text.match(/ส่ง(?:โดย)?[\s:]*([^\s,]+)/i);
    if (deliveryMatch) {
      deliveryPerson = deliveryMatch[1];
    }
    
    // 5. Check for credit/payment status
    const isCredit = text.toLowerCase().includes('เครดิต');
    
    Logger.success(`✅ Parsed: ${customer} orders ${quantity} ${stockItem.unit} of ${stockItem.item}`);
    
    return {
      success: true,
      customer,
      items: [{ stockItem, quantity }],
      deliveryPerson,
      paymentStatus: isCredit ? 'credit' : 'unpaid'
    };
    
  } catch (error) {
    Logger.error('parseOrder failed', error);
    return {
      success: false,
      error: '❌ ไม่สามารถประมวลผลคำสั่งได้\nกรุณาลองใหม่อีกครั้ง'
    };
  }
}

module.exports = { parseOrder };
