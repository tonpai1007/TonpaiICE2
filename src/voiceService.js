// ============================================================================
// GOOGLE SPEECH-TO-TEXT VOICE SERVICE
// ============================================================================

const speech = require('@google-cloud/speech');
const { configManager, loadGoogleCredentials } = require('./config');
const { Logger } = require('./logger');
const { generateWithGemini } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');

let speechClient = null;

// ============================================================================
// INITIALIZE GOOGLE SPEECH
// ============================================================================

function initializeSpeechClient() {
  if (speechClient) return speechClient;
  
  try {
    const credentials = loadGoogleCredentials();
    
    speechClient = new speech.SpeechClient({
      credentials
    });
    
    Logger.success('Google Speech-to-Text initialized');
    return speechClient;
  } catch (error) {
    Logger.error('Failed to initialize Google Speech', error);
    throw error;
  }
}

// ============================================================================
// BUILD SPEECH CONTEXT (VOCABULARY HINTS)
// ============================================================================

function buildSpeechContext() {
  const stockCache = getStockCache();
  const customerCache = getCustomerCache();
  
  const phrases = new Set();

  // Add all customer names
  customerCache.forEach(customer => {
    phrases.add(customer.name);
  });

  // Add all product names
  stockCache.forEach(item => {
    phrases.add(item.item);
  });

  // Add common keywords
  const keywords = [
    'น้ำแข็ง', 'หลอด', 'บด', 'แผ่น', 'เกร็ด',
    'ใหญ่', 'เล็ก', 'ละเอียด', 'หยาบ',
    'ถุง', 'กระสอบ', 'ขวด', 'กระป๋อง',
    'สั่ง', 'ซื้อ', 'ส่งโดย', 'เครดิต',
    'พี่', 'น้อง', 'คุณ', 'ลุง', 'ป้า'
  ];
  
  keywords.forEach(word => phrases.add(word));

  const finalPhrases = Array.from(phrases).slice(0, 500); // Google limit
  Logger.success(`Speech context: ${finalPhrases.length} phrases`);
  
  return finalPhrases;
}

// ============================================================================
// TRANSCRIBE AUDIO WITH GOOGLE SPEECH
// ============================================================================

async function transcribeAudioWithGoogle(audioBuffer) {
  try {
    const client = initializeSpeechClient();
    const phrases = buildSpeechContext();
    
    Logger.info(`Transcribing with Google (${(audioBuffer.length / 1024).toFixed(1)}KB)`);
    
    const audio = {
      content: audioBuffer.toString('base64')
    };
    
    const config = {
      encoding: 'OGG_OPUS', // LINE uses OGG Opus
      sampleRateHertz: 16000,
      languageCode: 'th-TH', // Thai language
      alternativeLanguageCodes: ['en-US'], // Fallback to English
      enableAutomaticPunctuation: true,
      model: 'default',
      useEnhanced: true,
      speechContexts: [{
        phrases: phrases,
        boost: 20 // Max boost for context
      }]
    };
    
    const request = {
      audio: audio,
      config: config
    };
    
    const [response] = await client.recognize(request);
    
    if (!response.results || response.results.length === 0) {
      throw new Error('No transcription results');
    }
    
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join(' ');
    
    const confidence = response.results[0].alternatives[0].confidence || 0;
    
    Logger.success(`✅ Google transcribed: "${transcription}" (${(confidence * 100).toFixed(1)}%)`);
    
    return {
      text: transcription,
      confidence: confidence
    };
    
  } catch (error) {
    Logger.error('Google Speech transcription failed', error);
    throw error;
  }
}

// ============================================================================
// AI CORRECTION WITH FULL DATABASE
// ============================================================================

async function aiCorrectTranscription(rawText, stockCache, customerCache) {
  try {
    Logger.info('🤖 AI correcting transcription...');

    const allProducts = stockCache.map(p => p.item).join('\n');
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
1. ตรวจสอบว่าชื่อลูกค้าและสินค้าตรงกับฐานข้อมูลหรือไม่
2. แก้ไขคำที่อาจจะผิด
3. จัดรูปแบบให้ชัดเจน

กฎ:
- ใช้ชื่อที่ตรงกับฐานข้อมูล
- เก็บโครงสร้าง: [ลูกค้า] สั่ง [สินค้า] [จำนวน]
- เพิ่ม "ส่งโดย [คน]" ถ้ามี

ตัวอย่าง:
Input: "พี่กาแฟ สั่งน้ำแข็งบด 2 ถุง"
Output: {
  corrected_text: "พี่กาแฟ สั่งน้ำแข็งบด 2 ถุง",
  confidence: "high",
  changes: "ไม่มีการแก้ไข"
}

แก้ไขให้ตรงกับฐานข้อมูล ตอบเป็น JSON`;

    const result = await generateWithGemini(prompt, schema, 0.1);

    Logger.success(`✅ AI: "${rawText}" → "${result.corrected_text}"`);
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
  const MIN_CONFIDENCE = configManager.get('VOICE_MIN_CONFIDENCE', 0.7);
  const MIN_TEXT_LENGTH = configManager.get('VOICE_MIN_TEXT_LENGTH', 3);
  
  try {
    Logger.info('🎤 Processing voice with Google Speech...');
    
    // Step 1: Transcribe with Google
    const transcriptionResult = await transcribeAudioWithGoogle(audioBuffer);
    
    Logger.info(`Raw: "${transcriptionResult.text}" (${(transcriptionResult.confidence * 100).toFixed(1)}%)`);
    
    if (!transcriptionResult.text || transcriptionResult.text.trim().length < MIN_TEXT_LENGTH) {
      return {
        success: false,
        error: '🎤 ฟังไม่ชัด กรุณาพูดใหม่\n\n💡 พูดช้าๆ ชัดเจน เช่น:\n"พี่กาแฟ สั่งน้ำแข็งหลอดใหญ่ 2 ถุง"'
      };
    }
    
    // Step 2: AI correction
    const stockCache = getStockCache();
    const customerCache = getCustomerCache();
    
    const aiCorrected = await aiCorrectTranscription(
      transcriptionResult.text,
      stockCache,
      customerCache
    );
    
    Logger.success(`✅ Final: "${aiCorrected.corrected}"`);
    
    // Step 3: Build warning
    let warning = null;
    
    if (transcriptionResult.confidence < MIN_CONFIDENCE) {
      warning = '⚠️ การแปลงเสียงไม่แน่นอน กรุณาตรวจสอบ';
    } else if (aiCorrected.confidence === 'low') {
      warning = `ℹ️ AI แก้ไขแล้วแต่ไม่แน่ใจ: ${aiCorrected.changes}`;
    } else if (aiCorrected.confidence === 'medium' && aiCorrected.changes !== 'ไม่มีการแก้ไข') {
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
    
    if (error.message?.includes('Invalid audio')) {
      return {
        success: false,
        error: '❌ รูปแบบเสียงไม่ถูกต้อง ลองบันทึกใหม่'
      };
    }
    
    return {
      success: false,
      error: '❌ เกิดข้อผิดพลาด ลองใหม่หรือพิมพ์แทน'
    };
  }
}

// ============================================================================
// FETCH AUDIO FROM LINE
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

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  processVoiceMessage,
  fetchAudioFromLine,
  initializeSpeechClient
};