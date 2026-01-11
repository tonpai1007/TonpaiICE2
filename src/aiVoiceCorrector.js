// aiVoiceCorrector.js - IMPROVED: Better prompt for Thai voice recognition
const { Logger } = require('./logger');
const { generateWithGroq } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');

// ============================================================================
// ENHANCED VOICE CORRECTION - Better AI prompt
// ============================================================================

async function correctVoiceInput(transcribedText, stockCache) {
  try {
    Logger.info(`🎤 Correcting voice: "${transcribedText}"`);
    
    const customerCache = getCustomerCache();
    
    // Build comprehensive context
    const stockList = stockCache
      .slice(0, 100) // More products for better matching
      .map((item, idx) => `[${idx}] ${item.item} | ${item.unit} | ${item.price}฿ | ${item.stock} คงเหลือ`)
      .join('\n');
    
    const customerList = customerCache
      .slice(0, 50)
      .map(c => c.name)
      .join(', ');

    const prompt = `คุณเป็นผู้เชี่ยวชาญระบบรับคำสั่งซื้อภาษาไทยผ่านเสียง ช่วยแก้ไขข้อความจากการฟังเสียงให้ถูกต้อง

สินค้าที่มีในระบบ:
${stockList}

ลูกค้าที่รู้จัก:
${customerList}

ข้อความจากการฟังเสียง (อาจมีข้อผิดพลาด):
"${transcribedText}"

ข้อผิดพลาดทั่วไปจากเสียงพูดภาษาไทย:
1. คำว่า "แข็ง", "แข่ง", "เข็ง" มักหมายถึง "น้ำแข็ง"
2. คำว่า "ลอด", "รอด" มักหมายถึง "หลอด" (ในบริบทน้ำแข็งหลอด)
3. คำว่า "โคก", "โคค" มักหมายถึง "โค้ก" (Coca-Cola)
4. คำว่า "เบีย", "เบียะ" มักหมายถึง "เบียร์"
5. ขาดเว้นวรรคระหว่างคำ (เช่น "น้ำแข็งห้า" = "น้ำแข็ง ห้า")
6. ตัวเลข: "ห้า"=5, "สิบ"=10, "ยี่สิบ"=20
7. "ล" กับ "ร" มักสับสน

รูปแบบคำสั่งที่ถูกต้อง:
- สั่งซื้อ: "สินค้า จำนวน ลูกค้า" → "น้ำแข็งหลอดใหญ่ 5 ถุง ร้านเจ๊แดง"
- ปรับสต็อก: "สินค้า มี/เหลือ/เติม/ลด จำนวน" → "น้ำแข็ง มี 20", "เติมน้ำแข็ง 10"
- ชำระเงิน: "จ่าย เลขออเดอร์" → "จ่าย #123" หรือ "จ่าย"
- จัดส่ง: "ส่ง เลขออเดอร์ คนส่ง" → "ส่ง พี่แดง" หรือ "ส่ง #123 พี่แดง"

วิธีทำงาน:
1. อ่านข้อความที่ได้จากการฟัง
2. จับคู่กับสินค้าในระบบ (ใช้ชื่อเต็มที่ถูกต้อง)
3. แก้ไขคำผิดตามข้อผิดพลาดทั่วไป
4. เติมคำที่ขาดหายไป (เช่น "ถุง", "ขวด")
5. แยกคำให้ถูกต้อง

สำคัญ:
- ใช้ชื่อสินค้าที่ตรงกับรายการข้างบน (ตัวอักษรเท่ากันทุกตัว)
- ถ้าพูดถึงขนาด (ใหญ่/เล็ก/กลาง) ต้องรวมกับชื่อสินค้า
- เติมหน่วย (ถุง, ขวด, กล่อง) ให้ครบถ้วน
- ถ้าไม่แน่ใจ เลือกสินค้าที่ใกล้เคียงที่สุด

ตอบเป็น JSON เท่านั้น:
{
  "matched": true,
  "productId": เลข index จากรายการ (ถ้ามีสินค้า),
  "productName": "ชื่อเต็มของสินค้าตามรายการ",
  "quantity": จำนวน,
  "operation": "set" หรือ "add" หรือ "subtract",
  "confidence": "high" หรือ "medium" หรือ "low",
  "correctedText": "ข้อความที่แก้ไขแล้ว",
  "reasoning": "อธิบายว่าแก้อะไรบ้าง"
}

ถ้าไม่ใช่คำสั่งเกี่ยวกับสต็อก:
{
  "matched": false,
  "isStockCommand": false,
  "correctedText": "ข้อความที่แก้ไขแล้ว",
  "type": "order" หรือ "payment" หรือ "delivery" หรือ "other"
}`;

    const result = await generateWithGroq(prompt, true);
    
    if (result.matched && result.productId >= 0 && result.productId < stockCache.length) {
      const item = stockCache[result.productId];
      
      Logger.success(`✅ AI matched: "${transcribedText}" → "${item.item}" (${result.confidence})`);
      Logger.info(`💡 Corrected: "${result.correctedText}"`);
      Logger.info(`🔍 Reasoning: ${result.reasoning}`);
      
      return {
        success: true,
        matched: true,
        item: item.item,
        stockItem: item,
        quantity: result.quantity,
        operation: result.operation,
        confidence: result.confidence,
        correctedText: result.correctedText,
        reasoning: result.reasoning,
        originalText: transcribedText
      };
    } else if (!result.isStockCommand) {
      // Not a stock command, but we corrected the text
      Logger.info(`ℹ️ Not stock command: "${result.correctedText}" (${result.type})`);
      
      return {
        success: true,
        matched: false,
        isStockCommand: false,
        correctedText: result.correctedText,
        type: result.type,
        originalText: transcribedText
      };
    } else {
      Logger.warn(`⚠️ AI could not match: "${transcribedText}"`);
      
      return {
        success: false,
        matched: false,
        originalText: transcribedText,
        correctedText: result.correctedText || transcribedText,
        confidence: 'none'
      };
    }
    
  } catch (error) {
    Logger.error('AI voice correction failed', error);
    return {
      success: false,
      matched: false,
      error: error.message,
      originalText: transcribedText,
      correctedText: transcribedText
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  correctVoiceInput
};
