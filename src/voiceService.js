
const { configManager } = require('./config');
const { Logger } = require('./logger');
const { transcribeAudio } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');
const { ITEM_ALIASES } = require('./constants');
const { normalizeText } = require('./utils');

// ============================================================================
// BUILD DYNAMIC VOCABULARY FROM ALL SOURCES
// ============================================================================

function buildEnhancedVocabulary() {
  const stockCache = getStockCache();
  const customerCache = getCustomerCache();
  
  Logger.info(`Building vocabulary: ${stockCache.length} products, ${customerCache.length} customers`);

  const vocabulary = new Set();

  // 1. ALL CUSTOMER NAMES (full names and each word)
  customerCache.forEach(customer => {
    vocabulary.add(customer.name);
    customer.name.split(/\s+/).forEach(word => {
      if (word.length >= 2) vocabulary.add(word);
    });
    
    // Add common titles
    if (customer.name.includes('พี่')) vocabulary.add('พี่');
    if (customer.name.includes('น้อง')) vocabulary.add('น้อง');
    if (customer.name.includes('คุณ')) vocabulary.add('คุณ');
  });

  // 2. ALL STOCK ITEMS (products, categories, units)
  stockCache.forEach(item => {
    vocabulary.add(item.item);
    vocabulary.add(item.category);
    vocabulary.add(item.unit);
    vocabulary.add(item.sku);
    
    // Add each word in product name
    item.item.split(/\s+/).forEach(word => {
      if (word.length >= 2) vocabulary.add(word);
    });
  });

  // 3. DELIVERY STAFF NAMES (extract from common patterns)
  // Add all customer names as potential delivery staff too
  customerCache.forEach(customer => {
    vocabulary.add(customer.name);
  });

  // 4. PRODUCT TYPE KEYWORDS (ice shop specific)
  const productKeywords = [
    'น้ำแข็ง', 'น้ำเเข็ง', 'น้ำแกง', 'น้ำขัง', 'น้ำค้าง', 'น้ำเข่ง',
    'หลอด', 'หล่อด', 'ลอด', 'บด', 'บอด', 'บ่อด',
    'แผ่น', 'แพน', 'เพ่น', 'เกร็ด', 'เกด', 'ก้อน', 'มือ',
    'ใหญ่', 'ใหย', 'เล็ก', 'เล็ค', 'เหล็ก', 'กลาง', 'กาง',
    'ละเอียด', 'ละเอยด', 'หยาบ', 'ยาบ',
    'เบียร์', 'เบีย', 'ช้าง', 'ลีโอ', 'ลิโอ', 'โซดา', 'น้ำอัดลม'
  ];

  // 5. CONTAINER KEYWORDS
  const containerKeywords = [
    'ถุง', 'ทุง', 'ถุ่ง', 'กระสอบ', 'แพ็ค', 'แพค', 'แพ๊ค',
    'ขวด', 'ขวต', 'กระป๋อง', 'กระป้อง', 'ซอง', 'ซ่อง',
    'กล่อง', 'กล้อง', 'ลัง', 'ล้ัง', 'กั๊ก', 'กั้ก', 'กัก'
  ];

  // 6. ACTION VERBS
  const actionWords = [
    'สั่ง', 'สั้ง', 'ซั่ง', 'สัง', 'ซื้อ', 'ซ้ือ', 'ซื่อ',
    'เอา', 'เ้า', 'ขอ', 'ข้อ', 'ส่ง', 'ส้ง', 'โดย', 'ให้', 'ถึง',
    'กับ', 'และ', 'แล้วก็', 'อีก', 'ด้วย', 'ฝาก', 'นำไป'
  ];

  // 7. CUSTOMER/DELIVERY TITLES
  const titleWords = [
    'พี่', 'พ่ี', 'น้อง', 'น้้อง', 'คุณ', 'คุ๊ณ', 'เจ้', 'เจ๊',
    'ลุง', 'ลุ๊ง', 'ป้า', 'ป๊า', 'อา', 'อ๊า', 'น้า', 'น๊า'
  ];

  // 8. THAI NUMBERS
  const numberWords = [
    'หนึ่ง', 'หนึง', 'หนึ่ง', 'สอง', 'ส', 'สาม', 'สี่', 'สี',
    'ห้า', 'ห่า', 'ฮ่า', 'หก', 'หอก', 'เจ็ด', 'เจ็ต', 'เจ๊ด',
    'แปด', 'แปต', 'แป๊ด', 'เก้า', 'เกา', 'เก่า',
    'สิบ', 'สิป', 'สิ๊บ', 'ซิบ', 'ยี่สิบ', 'สามสิบ', 'สี่สิบ', 'ห้าสิบ'
  ];

  // 9. PAYMENT KEYWORDS
  const paymentKeywords = [
    'จ่าย', 'จ่ายแล้ว', 'จ้าย', 'จ๊าย', 'ชำระ', 'ชำระแล้ว',
    'เครดิต', 'เคริดิต', 'เครติด', 'ค้าง', 'คาง', 'ค้างชำระ',
    'ไว้ก่อน', 'ยังไม่จ่าย', 'หนี้', 'โอน', 'โอนแล้ว', 'เงินสด'
  ];

  // 10. COMMON VOICE CORRECTIONS
  const VOICE_CORRECTIONS = {
    'น้ำเเข็ง': 'น้ำแข็ง', 'น้ำเเข่ง': 'น้ำแข็ง', 'น้ำแกง': 'น้ำแข็ง',
    'น้ำแข่ง': 'น้ำแข็ง', 'น้ำขัง': 'น้ำแข็ง', 'น้าแข็ง': 'น้ำแข็ง',
    'บอด': 'บด', 'บ่อด': 'บด', 'บ๊อด': 'บด',
    'หล่อด': 'หลอด', 'หลอต': 'หลอด', 'ห่อด': 'หลอด', 'ลอด': 'หลอด',
    'แพน': 'แผ่น', 'แพ่น': 'แผ่น', 'เพ่น': 'แผ่น',
    'เกร็ต': 'เกร็ด', 'เกด': 'เกร็ด', 'เก็ด': 'เกร็ด',
    'ใหย': 'ใหญ่', 'ใหย่': 'ใหญ่', 'ใหญ': 'ใหญ่',
    'เลก': 'เล็ก', 'เล็ค': 'เล็ก', 'เหล็ก': 'เล็ก'
  };

  // Combine all vocabularies
  [
    ...productKeywords,
    ...containerKeywords,
    ...actionWords,
    ...titleWords,
    ...numberWords,
    ...paymentKeywords,
    ...Object.keys(VOICE_CORRECTIONS),
    ...Object.values(VOICE_CORRECTIONS),
    ...Object.entries(ITEM_ALIASES).flatMap(([k, v]) => [k, ...v])
  ].forEach(word => vocabulary.add(word));

  // Filter valid words (length >= 2)
  const finalVocab = Array.from(vocabulary).filter(word => word && word.length >= 2);
  
  Logger.success(`Enhanced vocabulary: ${finalVocab.length} words (${customerCache.length} customers, ${stockCache.length} products)`);
  
  return finalVocab;
}

// ============================================================================
// CONTEXT-AWARE CORRECTIONS
// ============================================================================

function applyContextAwareCorrections(text, stockCache) {
  let corrected = text;
  
  const VOICE_CORRECTIONS = {
    'น้ำเเข็ง': 'น้ำแข็ง', 'น้ำเเข่ง': 'น้ำแข็ง', 'น้ำแกง': 'น้ำแข็ง',
    'น้ำแข่ง': 'น้ำแข็ง', 'น้ำขัง': 'น้ำแข็ง', 'น้าแข็ง': 'น้ำแข็ง',
    'น้ำค้าง': 'น้ำแข็ง', 'น้ำเข่ง': 'น้ำแข็ง', 'น้ำเค็ง': 'น้ำแข็ง',
    'บอด': 'บด', 'บ่อด': 'บด', 'บ๊อด': 'บด',
    'หล่อด': 'หลอด', 'หลอต': 'หลอด', 'ห่อด': 'หลอด', 'ลอด': 'หลอด',
    'แพน': 'แผ่น', 'แพ่น': 'แผ่น', 'เพ่น': 'แผ่น',
    'เกร็ต': 'เกร็ด', 'เกด': 'เกร็ด', 'เก็ด': 'เกร็ด',
    'ใหย': 'ใหญ่', 'ใหย่': 'ใหญ่', 'เลก': 'เล็ก', 'เล็ค': 'เล็ก'
  };
  
  // Apply basic corrections
  for (const [wrong, right] of Object.entries(VOICE_CORRECTIONS)) {
    const regex = new RegExp(wrong, 'gi');
    corrected = corrected.replace(regex, right);
  }
  
  // Fix compound words
  corrected = corrected
    .replace(/น้ำ\s*แข็ง/g, 'น้ำแข็ง')
    .replace(/บ\s*ด/g, 'บด')
    .replace(/หล\s*อด/g, 'หลอด')
    .replace(/แผ\s*่น/g, 'แผ่น')
    .replace(/เกร\s*็ด/g, 'เกร็ด');
  
  // Apply product aliases
  for (const [key, aliases] of Object.entries(ITEM_ALIASES)) {
    for (const alias of aliases) {
      const regex = new RegExp(`\\b${alias}\\b`, 'gi');
      corrected = corrected.replace(regex, key);
    }
  }
  
  return corrected.trim();
}

// ============================================================================
// PROCESS VOICE MESSAGE
// ============================================================================

async function processVoiceMessage(audioBuffer) {
  const MIN_CONFIDENCE = configManager.get('VOICE_MIN_CONFIDENCE', 0.55);
  const MIN_TEXT_LENGTH = configManager.get('VOICE_MIN_TEXT_LENGTH', 3);
  
  try {
    Logger.info('Starting voice processing with dynamic vocabulary...');
    
    // Build vocabulary with ALL customers and products
    const vocabulary = buildEnhancedVocabulary();
    
    // Transcribe with enhanced vocabulary
    const result = await transcribeAudio(audioBuffer, vocabulary);
    
    Logger.info(`Raw transcription: "${result.text}" (${(result.confidence * 100).toFixed(1)}%)`);
    
    // Validate transcription quality
    if (!result.text || result.text.trim().length < MIN_TEXT_LENGTH) {
      return {
        success: false,
        error: '🎤 ฟังไม่ชัดค่ะ กรุณาพูดใหม่อีกครั้ง\n\n' +
               '💡 เคล็ดลับ:\n' +
               '• พูดช้าๆ ชัดเจน\n' +
               '• ระบุ: ชื่อลูกค้า + สินค้า + จำนวน\n' +
               '• ตัวอย่าง: "คุณสมชาย สั่งน้ำแข็งหลอดใหญ่ 2 ถุง"'
      };
    }
    
    // Apply intelligent corrections
    const stockCache = getStockCache();
    const corrected = applyContextAwareCorrections(result.text, stockCache);
    
    Logger.success(`✅ Corrected: "${result.text}" → "${corrected}"`);
    Logger.info(`Confidence: ${(result.confidence * 100).toFixed(1)}%`);
    
    // Warning based on confidence
    let warning = null;
    if (result.confidence < MIN_CONFIDENCE) {
      warning = '⚠️ ระบบไม่แน่ใจ กรุณาตรวจสอบความถูกต้อง';
    } else if (result.confidence < 0.7) {
      warning = 'ℹ️ กรุณาตรวจสอบข้อมูล';
    }
    
    return {
      success: true,
      text: corrected,
      original: result.text,
      confidence: result.confidence,
      warning
    };
    
  } catch (error) {
    Logger.error('Voice processing failed', error);
    
    if (error.message?.includes('quota') || error.message?.includes('429')) {
      return {
        success: false,
        error: '⏳ ระบบยุ่งมาก กรุณารอ 1-2 นาทีแล้วลองใหม่ค่ะ'
      };
    }
    
    if (error.message?.includes('audio')) {
      return {
        success: false,
        error: '❌ ไม่สามารถอ่านไฟล์เสียงได้\nลองบันทึกใหม่หรือพิมพ์แทนนะคะ'
      };
    }
    
    return {
      success: false,
      error: '❌ เกิดข้อผิดพลาดในการแปลงเสียง\nลองใหม่หรือพิมพ์แทนได้เลยค่ะ'
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
        }
      }
    );

    if (!response.ok) {
      throw new Error(`LINE audio fetch failed: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    Logger.success(`Audio fetched: ${(buffer.length / 1024).toFixed(1)}KB`);
    
    return buffer;
  } catch (error) {
    Logger.error('fetchAudioFromLine failed', error);
    throw new Error(`Failed to fetch LINE audio: ${error.message}`);
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  processVoiceMessage,
  fetchAudioFromLine,
  buildEnhancedVocabulary
};