// ============================================================================
// AI VOICE SERVICE - USES FULL DATABASE CONTEXT
// ============================================================================

const { configManager } = require('./config');
const { Logger } = require('./logger');
const { transcribeAudio, generateWithGemini } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');

// ============================================================================
// BUILD VOCABULARY FOR ASSEMBLYAI
// ============================================================================

function buildEnhancedVocabulary() {
  const stockCache = getStockCache();
  const customerCache = getCustomerCache();
  
  const vocabulary = new Set();

  customerCache.forEach(customer => {
    vocabulary.add(customer.name);
    customer.name.split(/\s+/).forEach(word => {
      if (word.length >= 2) vocabulary.add(word);
    });
  });

  stockCache.forEach(item => {
    vocabulary.add(item.item);
    vocabulary.add(item.category);
    item.item.split(/\s+/).forEach(word => {
      if (word.length >= 2) vocabulary.add(word);
    });
  });

  const finalVocab = Array.from(vocabulary).filter(word => word && word.length >= 2);
  Logger.success(`Vocabulary: ${finalVocab.length} words`);
  
  return finalVocab;
}

// ============================================================================
// AI CORRECTION WITH FULL DATABASE
// ============================================================================

async function aiCorrectTranscription(rawText, stockCache, customerCache) {
  try {
    Logger.info('🤖 AI correcting with full database context...');

    // Send ENTIRE product list
    const allProducts = stockCache.map(p => p.item).join('\n');
    
    // Send ENTIRE customer list
    const allCustomers = customerCache.map(c => c.name).join('\n');

    const schema = {
      type: 'object',
      properties: {
        corrected_text: {
          type: 'string',
          description: 'ข้อความที่แก้ไขแล้ว'
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low']
        },
        changes: {
          type: 'string',
          description: 'สิ่งที่แก้ไข'
        }
      },
      required: ['corrected_text', 'confidence', 'changes']
    };

    const prompt = `คุณคือ AI แก้ไขข้อความจากระบบแปลงเสียง

📦 สินค้าทั้งหมดในระบบ (${stockCache.length} รายการ):
${allProducts}

👥 ลูกค้าทั้งหมดในระบบ (${customerCache.length} คน):
${allCustomers}

🎤 ข้อความที่ได้จากเสียง:
"${rawText}"

งาน:
1. แก้ไขข้อผิดพลาดจากการแปลงเสียง
2. จับคู่ชื่อลูกค้าและสินค้ากับฐานข้อมูล
3. แก้ไขคำที่ออกเสียงคล้ายกัน

กฎ:
- "ติด", "ทิด" → "พี่"
- "น้องแห่ง", "น้ำแห่ง" → "น้ำแข็ง"
- "บท" → "บด"
- "หล่อด" → "หลอด"
- ใช้ชื่อที่ตรงกับฐานข้อมูล

ตัวอย่าง:
Input: "ติดกาแฟน้องแห่งบท 2 ถุง"
Output: {
  corrected_text: "พี่กาแฟ น้ำแข็งบด 2 ถุง",
  confidence: "high",
  changes: "ติด→พี่, น้องแห่ง→น้ำแข็ง, บท→บด"
}

แก้ไขให้ตรงกับฐานข้อมูล ตอบเป็น JSON`;

    const result = await generateWithGemini(prompt, schema, 0.1);

    Logger.success(`✅ "${rawText}" → "${result.corrected_text}"`);
    Logger.info(`Changes: ${result.changes}`);

    return {
      corrected: result.corrected_text,
      confidence: result.confidence,
      changes: result.changes
    };

  } catch (error) {
    Logger.error('AI correction failed', error);
    return {
      corrected: rawText,
      confidence: 'low',
      changes: 'ไม่สามารถแก้ไข'
    };
  }
}

// ============================================================================
// PROCESS VOICE MESSAGE
// ============================================================================

async function processVoiceMessage(audioBuffer) {
  const MIN_CONFIDENCE = configManager.get('VOICE_MIN_CONFIDENCE', 0.55);
  const MIN_TEXT_LENGTH = configManager.get('VOICE_MIN_TEXT_LENGTH', 3);
  
  try {
    Logger.info('🎤 Processing voice...');
    
    const vocabulary = buildEnhancedVocabulary();
    const transcriptionResult = await transcribeAudio(audioBuffer, vocabulary);
    
    Logger.info(`Raw: "${transcriptionResult.text}" (${(transcriptionResult.confidence * 100).toFixed(1)}%)`);
    
    if (!transcriptionResult.text || transcriptionResult.text.trim().length < MIN_TEXT_LENGTH) {
      return {
        success: false,
        error: '🎤 ฟังไม่ชัด กรุณาพูดใหม่\n\n💡 พูดช้าๆ ชัดเจน เช่น: "พี่กาแฟ สั่งน้ำแข็งหลอดใหญ่ 2 ถุง"'
      };
    }
    
    const stockCache = getStockCache();
    const customerCache = getCustomerCache();
    
    const aiCorrected = await aiCorrectTranscription(
      transcriptionResult.text,
      stockCache,
      customerCache
    );
    
    Logger.success(`✅ Final: "${aiCorrected.corrected}"`);
    
    let warning = null;
    
    if (transcriptionResult.confidence < MIN_CONFIDENCE) {
      warning = '⚠️ การแปลงเสียงไม่แน่นอน กรุณาตรวจสอบ';
    } else if (aiCorrected.confidence === 'low') {
      warning = `ℹ️ AI แก้ไขแล้วแต่ไม่แน่ใจ: ${aiCorrected.changes}`;
    } else if (aiCorrected.confidence === 'medium') {
      warning = `ℹ️ ${aiCorrected.changes}`;
    }
    
    return {
      success: true,
      text: aiCorrected.corrected,
      original: transcriptionResult.text,
      confidence: transcriptionResult.confidence,
      aiConfidence: aiCorrected.confidence,
      changes: aiCorrected.changes,
      warning
    };
    
  } catch (error) {
    Logger.error('Voice processing failed', error);
    
    if (error.message?.includes('quota') || error.message?.includes('429')) {
      return {
        success: false,
        error: '⏳ ระบบยุ่ง รอ 1-2 นาที'
      };
    }
    
    return {
      success: false,
      error: '❌ เกิดข้อผิดพลาด ลองใหม่หรือพิมพ์แทน'
    };
  }
}

// ============================================================================
// FETCH AUDIO
// ============================================================================

async function fetchAudioFromLine(messageId) {
  try {
    const LINE_TOKEN = configManager.get('LINE_TOKEN');
    
    const response = await fetch(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      {
        headers: { 
          'Authorization': `Bearer ${LINE_TOKEN}` 
        }
      }
    );

    if (!response.ok) {
      throw new Error(`LINE fetch failed: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    Logger.success(`Audio: ${(buffer.length / 1024).toFixed(1)}KB`);
    
    return buffer;
  } catch (error) {
    Logger.error('Fetch failed', error);
    throw error;
  }
}

module.exports = {
  processVoiceMessage,
  fetchAudioFromLine,
  buildEnhancedVocabulary
};