// aiVoiceCorrector.js - Use AI to fix voice transcription errors
const { Logger } = require('./logger');
const { generateWithGroq } = require('./aiServices');
const { getStockCache } = require('./cacheManager');

// ============================================================================
// AI-POWERED VOICE CORRECTION
// ============================================================================

async function correctVoiceInput(transcribedText, stockCache) {
  try {
    Logger.info(`🎤 Correcting voice input: "${transcribedText}"`);
    
    // Build stock list for AI context
    const stockList = stockCache
      .map((item, idx) => `[${idx}] ${item.item} | ${item.unit} | ${item.price}฿`)
      .join('\n');

    const prompt = `You are a Thai language expert fixing voice transcription errors for inventory management.

AVAILABLE PRODUCTS:
${stockList}

VOICE TRANSCRIPTION (may have errors):
"${transcribedText}"

COMMON THAI VOICE ERRORS:
- "แข็ง" is often "น้ำแข็ง" (ice)
- "แข็งลอด" → "น้ำแข็งหลอด" (tube ice)
- "แข่งรอด" → "น้ำแข็งหลอด" (tube ice)
- "แข็งก้อน" → "น้ำแข็งก้อน" (ice cubes)
- "โคก" → "โค้ก" (Coke)
- "เบีย" → "เบียร์" (beer)
- Missing spaces between words
- Wrong tone marks
- "ล" vs "ร" confusion

YOUR TASK:
1. Identify what product the user is talking about
2. Match it to the EXACT product name from the list above
3. Extract quantity and operation (มี/เหลือ = set stock, เติม = add, ลด = subtract)

CRITICAL RULES:
- MUST use EXACT product names from the list (including size: ใหญ่/เล็ก/กลาง)
- If unsure between multiple products, choose the most common one
- Return ONLY JSON, no explanation

OUTPUT JSON:
{
  "matched": true or false,
  "productId": 0,
  "productName": "exact name from list",
  "quantity": 5,
  "operation": "set" or "add" or "subtract",
  "confidence": "high" or "medium" or "low",
  "reasoning": "why this match"
}

If no match found:
{
  "matched": false,
  "originalText": "${transcribedText}",
  "possibleProducts": ["suggestion1", "suggestion2"],
  "confidence": "none"
}`;

    const result = await generateWithGroq(prompt, true);
    
    if (result.matched && result.productId >= 0 && result.productId < stockCache.length) {
      const item = stockCache[result.productId];
      
      Logger.success(`✅ AI matched: "${transcribedText}" → "${item.item}" (${result.confidence})`);
      Logger.info(`💡 AI reasoning: ${result.reasoning}`);
      
      return {
        success: true,
        matched: true,
        item: item.item,
        stockItem: item,
        quantity: result.quantity,
        operation: result.operation,
        confidence: result.confidence,
        reasoning: result.reasoning,
        originalText: transcribedText
      };
    } else {
      Logger.warn(`⚠️ AI could not match: "${transcribedText}"`);
      
      return {
        success: false,
        matched: false,
        originalText: transcribedText,
        suggestions: result.possibleProducts || [],
        confidence: 'none'
      };
    }
    
  } catch (error) {
    Logger.error('AI voice correction failed', error);
    return {
      success: false,
      matched: false,
      error: error.message,
      originalText: transcribedText
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  correctVoiceInput
};
