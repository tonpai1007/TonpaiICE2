// voiceService.js - FIXED: Only use AI correction when needed

const speech = require('@google-cloud/speech');
const { configManager, loadGoogleCredentials } = require('./config');
const { Logger } = require('./logger');
const { generateWithGemini, isGeminiAvailable } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');
const { stockVectorStore } = require('./vectorStore');

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

  const finalPhrases = Array.from(phrases).slice(0, 500);
  Logger.success(`Speech context: ${finalPhrases.length} phrases`);
  
  return finalPhrases;
}

// ============================================================================
// DETECT AUDIO FORMAT
// ============================================================================

function detectAudioFormat(buffer) {
  if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
    return 'OGG_OPUS';
  }
  
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
    return 'WEBM_OPUS';
  }
  
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    return 'MP4';
  }
  
  return 'OGG_OPUS';
}

// ============================================================================
// TRANSCRIBE AUDIO WITH GOOGLE SPEECH
// ============================================================================

async function transcribeAudioWithGoogle(audioBuffer) {
  try {
    const client = initializeSpeechClient();
    const phrases = buildSpeechContext();
    
    const audioFormat = detectAudioFormat(audioBuffer);
    const audioSize = (audioBuffer.length / 1024).toFixed(1);
    
    Logger.info(`Transcribing with Google: ${audioSize}KB (${audioFormat})`);
    
    if (audioBuffer.length < 1000) {
      throw new Error('Audio file too small (likely empty or corrupted)');
    }
    
    if (audioBuffer.length > 10 * 1024 * 1024) {
      throw new Error('Audio file too large (max 10MB)');
    }
    
    const audio = {
      content: audioBuffer.toString('base64')
    };
    
    const configs = [
      {
        name: 'OGG_OPUS (LINE Default)',
        encoding: 'OGG_OPUS',
        sampleRateHertz: 16000,
      },
      {
        name: 'WEBM_OPUS',
        encoding: 'WEBM_OPUS',
        sampleRateHertz: 48000,
      },
      {
        name: 'LINEAR16',
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
      }
    ];
    
    let lastError = null;
    
    for (const configVariant of configs) {
      try {
        Logger.info(`Trying config: ${configVariant.name}`);
        
        const config = {
          encoding: configVariant.encoding,
          sampleRateHertz: configVariant.sampleRateHertz,
          languageCode: 'th-TH',
          alternativeLanguageCodes: ['en-US'],
          enableAutomaticPunctuation: true,
          model: 'default',
          useEnhanced: true,
          maxAlternatives: 3,
          speechContexts: [{
            phrases: phrases,
            boost: 20
          }],
          enableWordConfidence: true,
          enableWordTimeOffsets: true
        };
        
        const request = {
          audio: audio,
          config: config
        };
        
        const [response] = await client.recognize(request);
        
        if (!response.results || response.results.length === 0) {
          Logger.warn(`No results with ${configVariant.name}`);
          lastError = new Error(`No transcription results with ${configVariant.name}`);
          continue;
        }
        
        const result = response.results[0];
        const alternatives = result.alternatives || [];
        
        if (alternatives.length === 0) {
          Logger.warn(`No alternatives with ${configVariant.name}`);
          continue;
        }
        
        const bestAlternative = alternatives[0];
        const transcription = bestAlternative.transcript;
        const confidence = bestAlternative.confidence || 0;
        
        if (alternatives.length > 1) {
          Logger.info('Alternative transcriptions:');
          alternatives.forEach((alt, idx) => {
            Logger.info(`  ${idx + 1}. "${alt.transcript}" (${(alt.confidence * 100).toFixed(1)}%)`);
          });
        }
        
        if (!transcription || transcription.trim().length === 0) {
          Logger.warn('Empty transcription');
          continue;
        }
        
        Logger.success(`✅ Transcribed with ${configVariant.name}: "${transcription}" (${(confidence * 100).toFixed(1)}%)`);
        
        return {
          text: transcription,
          confidence: confidence,
          alternatives: alternatives.slice(1).map(alt => ({
            text: alt.transcript,
            confidence: alt.confidence || 0
          })),
          encoding: configVariant.encoding
        };
        
      } catch (configError) {
        Logger.warn(`Config ${configVariant.name} failed:`, configError.message);
        lastError = configError;
        continue;
      }
    }
    
    throw lastError || new Error('All transcription configs failed');
    
  } catch (error) {
    Logger.error('Google Speech transcription failed', error);
    
    if (error.message?.includes('Audio file too')) {
      throw error;
    }
    
    if (error.code === 11 || error.message?.includes('INVALID_ARGUMENT')) {
      throw new Error('Invalid audio format - LINE audio may be corrupted');
    }
    
    throw error;
  }
}

// ============================================================================
// SMART AI CORRECTION - ONLY WHEN NEEDED
// ============================================================================

async function smartAICorrection(rawText, confidence, stockCache, customerCache) {
  try {
    // ✅ CRITICAL FIX: Only use AI if confidence is LOW or text looks suspicious
    const needsCorrection = 
      confidence < 0.75 || // Low confidence
      !hasValidProductName(rawText, stockCache) || // No product found
      !hasValidCustomerName(rawText, customerCache); // No customer found
    
    if (!needsCorrection) {
      Logger.info(`✅ Transcription looks good (${(confidence * 100).toFixed(1)}%) - skipping AI correction`);
      return {
        corrected: rawText,
        confidence: 'high',
        changes: 'ไม่มีการแก้ไข - ผลการแปลงเสียงดีอยู่แล้ว'
      };
    }
    
    Logger.info(`🤖 AI correction needed (confidence: ${(confidence * 100).toFixed(1)}%)`);

    const allProducts = stockCache.slice(0, 50).map(p => p.item).join('\n');
    const allCustomers = customerCache.slice(0, 30).map(c => c.name).join('\n');

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

📦 สินค้าหลักในระบบ:
${allProducts}

👥 ลูกค้าในระบบ:
${allCustomers}

🎤 ข้อความที่ได้จากเสียง:
"${rawText}"

งาน:
1. ตรวจสอบว่าชื่อลูกค้าและสินค้าตรงกับฐานข้อมูลหรือไม่
2. แก้ไขเฉพาะคำที่ผิดเท่านั้น
3. **อย่าเปลี่ยนคำที่ถูกต้องอยู่แล้ว**
4. ถ้าไม่แน่ใจ อย่าแก้

กฎสำคัญ:
- ถ้าข้อความถูกต้องอยู่แล้ว ให้คืนค่าเหมือนเดิม
- แก้เฉพาะชื่อที่ผิดพลาด
- เก็บโครงสร้าง: [ลูกค้า] สั่ง [สินค้า] [จำนวน]
- เพิ่ม "สั่งโดย [คน]" ถ้ามี

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
// HELPER: CHECK IF TEXT HAS VALID PRODUCT
// ============================================================================

function hasValidProductName(text, stockCache) {
  const results = stockVectorStore.search(text, 1);
  return results.length > 0 && results[0].similarity > 0.5;
}

// ============================================================================
// HELPER: CHECK IF TEXT HAS VALID CUSTOMER
// ============================================================================

function hasValidCustomerName(text, customerCache) {
  const normalizedText = text.toLowerCase();
  return customerCache.some(customer => 
    normalizedText.includes(customer.name.toLowerCase())
  );
}

// ============================================================================
// PROCESS VOICE MESSAGE (FIXED)
// ============================================================================

async function processVoiceMessage(audioBuffer) {
  const MIN_CONFIDENCE = configManager.get('VOICE_MIN_CONFIDENCE', 0.5);
  const MIN_TEXT_LENGTH = configManager.get('VOICE_MIN_TEXT_LENGTH', 3);
  
  try {
    Logger.info('🎤 Processing voice with Google Speech...');
    
    if (!audioBuffer || audioBuffer.length === 0) {
      return {
        success: false,
        error: '❌ ไม่สามารถโหลดไฟล์เสียงได้\nกรุณาลองบันทึกใหม่'
      };
    }
    
    // Step 1: Transcribe with Google
    const transcriptionResult = await transcribeAudioWithGoogle(audioBuffer);
    
    Logger.info(`Raw: "${transcriptionResult.text}" (${(transcriptionResult.confidence * 100).toFixed(1)}%)`);
    Logger.info(`Encoding used: ${transcriptionResult.encoding}`);
    
    if (!transcriptionResult.text || transcriptionResult.text.trim().length < MIN_TEXT_LENGTH) {
      let errorMsg = '🎤 ฟังไม่ชัด กรุณาพูดใหม่\n\n💡 เคล็ดลับ:\n';
      errorMsg += '• พูดชัดๆ ชัดเจน\n';
      errorMsg += '• อยู่ในที่เงียบ\n';
      errorMsg += '• ถือไมค์ใกล้ปาก\n';
      errorMsg += '• ตัวอย่าง: "พี่กาแฟ สั่งน้ำแข็งหลอดใหญ่ 2 ถุง"';
      
      return {
        success: false,
        error: errorMsg
      };
    }
    
    // Step 2: Smart AI correction (only when needed)
    const stockCache = getStockCache();
    const customerCache = getCustomerCache();
    
    const aiCorrected = await smartAICorrection(
      transcriptionResult.text,
      transcriptionResult.confidence,
      stockCache,
      customerCache
    );
    
    Logger.success(`✅ Final: "${aiCorrected.corrected}"`);
    
    // Step 3: Build warning
    let warning = null;
    
    if (transcriptionResult.confidence < MIN_CONFIDENCE) {
      warning = '⚠️ การแปลงเสียงไม่แน่นอน กรุณาตรวจสอบความถูกต้อง';
    } else if (aiCorrected.confidence === 'low') {
      warning = `ℹ️ AI แก้ไขแล้วแต่ไม่แน่ใจ: ${aiCorrected.changes}`;
    } else if (aiCorrected.confidence === 'medium' && aiCorrected.changes !== 'ไม่มีการแก้ไข' && aiCorrected.changes !== 'ไม่มีการแก้ไข - ผลการแปลงเสียงดีอยู่แล้ว') {
      warning = `ℹ️ ${aiCorrected.changes}`;
    }
    
    if (transcriptionResult.alternatives && transcriptionResult.alternatives.length > 0 && 
        transcriptionResult.confidence < 0.7) {
      warning = (warning || '') + '\n\n🔄 ทางเลือกอื่น:\n';
      transcriptionResult.alternatives.slice(0, 2).forEach((alt, idx) => {
        warning += `${idx + 2}. "${alt.text}" (${(alt.confidence * 100).toFixed(1)}%)\n`;
      });
    }
    
    return {
      success: true,
      text: aiCorrected.corrected,
      original: transcriptionResult.text,
      confidence: transcriptionResult.confidence,
      aiConfidence: aiCorrected.confidence,
      changes: aiCorrected.changes,
      warning,
      encoding: transcriptionResult.encoding
    };
    
  } catch (error) {
    Logger.error('Voice processing failed', error);
    
    if (error.message?.includes('Audio file too small')) {
      return {
        success: false,
        error: '❌ ไฟล์เสียงเล็กเกินไป\nกรุณาบันทึกเสียงใหม่ให้ยาวกว่านี้'
      };
    }
    
    if (error.message?.includes('Audio file too large')) {
      return {
        success: false,
        error: '❌ ไฟล์เสียงใหญ่เกินไป\nกรุณาบันทึกข้อความสั้นลง'
      };
    }
    
    if (error.message?.includes('quota') || error.message?.includes('429')) {
      return {
        success: false,
        error: '⏳ ระบบยุ่ง กรุณารอ 1-2 นาที\nหรือลองพิมพ์แทน'
      };
    }
    
    if (error.message?.includes('Invalid audio') || error.message?.includes('corrupted')) {
      return {
        success: false,
        error: '❌ ไฟล์เสียงไม่ถูกต้อง\nลองบันทึกใหม่หรือพิมพ์แทนค่ะ'
      };
    }
    
    if (error.code === 11 || error.message?.includes('INVALID_ARGUMENT')) {
      return {
        success: false,
        error: '❌ รูปแบบเสียงไม่รองรับ\nลองบันทึกใหม่หรือพิมพ์แทนค่ะ'
      };
    }
    
    return {
      success: false,
      error: '❌ เกิดข้อผิดพลาด\nลองใหม่หรือพิมพ์แทนค่ะ\n\n' + 
              `รายละเอียด: ${error.message?.substring(0, 100)}`
    };
  }
}

// ============================================================================
// FETCH AUDIO FROM LINE
// ============================================================================

async function fetchAudioFromLine(messageId) {
  try {
    const LINE_TOKEN = configManager.get('LINE_TOKEN');
    
    Logger.info(`Fetching audio from LINE: ${messageId}`);
    
    const response = await fetch(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      {
        headers: { 
          'Authorization': `Bearer ${LINE_TOKEN}` 
        },
        signal: AbortSignal.timeout(30000)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      Logger.error(`LINE API error: ${response.status} - ${errorText}`);
      throw new Error(`LINE audio fetch failed: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const sizeKB = (buffer.length / 1024).toFixed(1);
    
    Logger.success(`✅ Audio fetched: ${sizeKB}KB`);
    
    if (buffer.length === 0) {
      throw new Error('LINE returned empty audio file');
    }
    
    if (buffer.length < 100) {
      throw new Error('LINE audio file too small (likely corrupt)');
    }
    
    return buffer;
  } catch (error) {
    Logger.error('Fetch audio from LINE failed', error);
    
    if (error.name === 'AbortError') {
      throw new Error('LINE audio download timeout - please try again');
    }
    
    throw new Error(`Failed to fetch LINE audio: ${error.message}`);
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