// voiceService.js - Voice-to-text processing with context

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { transcribeAudio } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');
const { ITEM_ALIASES } = require('./constants');

// ============================================================================
// VOICE CORRECTIONS
// ============================================================================

const VOICE_CORRECTIONS = {
  // น้ำแข็ง variations
  'น้ำเเข็ง': 'น้ำแข็ง',
  'น้ำเเข่ง': 'น้ำแข็ง',
  'น้ำแกง': 'น้ำแข็ง',
  'น้ำแข่ง': 'น้ำแข็ง',
  'น้ำขัง': 'น้ำแข็ง',
  'น้าแข็ง': 'น้ำแข็ง',
  'น้ำค้าง': 'น้ำแข็ง',
  'น้ำเข่ง': 'น้ำแข็ง',
  
  // Product types
  'บอด': 'บด',
  'บ่อด': 'บด',
  'บ๊อด': 'บด',
  'หล่อด': 'หลอด',
  'หลอต': 'หลอด',
  'ห่อด': 'หลอด',
  'แพน': 'แผ่น',
  'แพ่น': 'แผ่น',
  'เพ่น': 'แผ่น',
  
  // Sizes
  'ใหย': 'ใหญ่',
  'ใหย่': 'ใหญ่',
  'เลก': 'เล็ก',
  'เล็ค': 'เล็ก',
  'เหล็ก': 'เล็ก',
  
  // Actions
  'สั้ง': 'สั่ง',
  'ซั่ง': 'สั่ง',
  'ซั้ง': 'สั่ง',
  'ซื้อ': 'ซื้อ',
  'ซ้ือ': 'ซื้อ',
  
  // Containers
  'ทุง': 'ถุง',
  'ถุ่ง': 'ถุง',
  'ทุ่ง': 'ถุง',
  'แพ็ค': 'แพ็ค',
  'แพค': 'แพ็ค',
  'แพ๊ค': 'แพ็ค',
  
  // Numbers
  'ห่า': 'ห้า',
  'ห้่า': 'ห้า',
  'ฮ่า': 'ห้า',
  'เจ็ต': 'เจ็ด',
  'เจ็ค': 'เจ็ด',
  'แจ็ด': 'เจ็ด',
  'แปต': 'แปด',
  'แป๊ด': 'แปด',
  'สิป': 'สิบ',
  'สิ๊บ': 'สิบ'
};

function applyIntelligentCorrections(text) {
  let corrected = text;

  // Apply corrections
  for (const [wrong, right] of Object.entries(VOICE_CORRECTIONS)) {
    const regex = new RegExp(wrong, 'gi');
    corrected = corrected.replace(regex, right);
  }

  // Fix spacing
  corrected = corrected
    .replace(/น้ำ\s*แข็ง/g, 'น้ำแข็ง')
    .replace(/น้ำ\s*เเข็ง/g, 'น้ำแข็ง')
    .replace(/บ\s*ด/g, 'บด')
    .replace(/หล\s*อด/g, 'หลอด')
    .replace(/แผ\s*่น/g, 'แผ่น');

  // Apply aliases
  for (const [key, aliases] of Object.entries(ITEM_ALIASES)) {
    for (const alias of aliases) {
      const regex = new RegExp(`\\b${alias}\\b`, 'gi');
      corrected = corrected.replace(regex, key);
    }
  }

  return corrected.trim();
}

// ============================================================================
// BUILD VOCABULARY
// ============================================================================

function buildVocabulary() {
  const stockCache = getStockCache();
  const customerCache = getCustomerCache();

  const stockTerms = stockCache.map(item => item.item);
  const stockWords = stockCache.flatMap(item => item.item.split(/\s+/));
  const customerNames = customerCache.map(c => c.name);
  const customerWords = customerCache.flatMap(c => c.name.split(/\s+/));
  
  const productVariations = [
    'น้ำแข็ง', 'น้ำเเข็ง', 'น้ำแกง', 'น้ำขัง', 'น้ำค้าง',
    'หลอด', 'หล่อด', 'บด', 'บอด', 'บ่อด', 
    'แผ่น', 'แพน', 'เกร็ด', 'ก้อน', 'มือ', 'ลูกเต่า',
    'ใหญ่', 'ใหย', 'เล็ก', 'เล็ค', 'กลาง',
    'ถุง', 'ทุง', 'กระสอบ', 'แพ็ค', 'แพค', 'ขวด', 'ซอง'
  ];

  const paymentKeywords = [
    'จ่าย', 'จ่ายแล้ว', 'ชำระ', 'ชำระแล้ว', 'โอน', 'โอนแล้ว',
    'ได้เงิน', 'รับเงิน', 'เงินเข้า', 'จ่ายหนี้', 'ชำระหนี้'
  ];

  const creditKeywords = [
    'เครดิต', 'ค้าง', 'ค้างชำระ', 'ค้างเงิน', 'ไว้ก่อน',
    'จ่ายทีหลัง', 'ยังไม่จ่าย', 'หนี้', 'ตรวจเครดิต'
  ];

  const customerTitles = ['พี่', 'น้อง', 'คุณ', 'เจ้', 'ลุง', 'ป้า', 'อา', 'น้า'];
  const thaiNumbers = [
    'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า', 'สิบ',
    'สิบเอ็ด', 'สิบสอง', 'ยี่สิบ', 'สามสิบ', 'ห่า', 'เจ็ต', 'สิป'
  ];
  const actionWords = [
    'สั่ง', 'สั้ง', 'ซั่ง', 'ซื้อ', 'เอา', 'ขอ', 'ส่ง', 'ส้ง', 
    'โดย', 'ให้', 'ถึง', 'ทำบิล', 'บิล', 'สรุป'
  ];

  const allAliases = Object.entries(ITEM_ALIASES).flatMap(([k, a]) => [k, ...a]);

  const boostWords = [...new Set([
    ...customerNames,
    ...customerWords,
    ...stockTerms,
    ...stockWords,
    ...productVariations,
    ...paymentKeywords,
    ...creditKeywords,
    ...customerTitles,
    ...thaiNumbers,
    ...actionWords,
    ...allAliases
  ])].filter(word => word && word.length >= 2);

  Logger.info(`Built vocabulary: ${boostWords.length} words`);

  return boostWords;
}

// ============================================================================
// PROCESS VOICE
// ============================================================================

async function processVoiceMessage(audioBuffer) {
  const MIN_CONFIDENCE = 0.6;
  const MIN_TEXT_LENGTH = 3;
  
  try {
    const vocabulary = buildVocabulary();
    const result = await transcribeAudio(audioBuffer, vocabulary);
    
    // Validate transcription quality
    if (!result.text || result.text.trim().length < MIN_TEXT_LENGTH) {
      return {
        success: false,
        error: '🎤 ฟังไม่ชัดค่ะ กรุณาพูดใหม่อีกครั้ง\n\n💡 เคล็ดลับ:\n• พูดช้าๆ ชัดๆ\n• ระบุชื่อลูกค้า สินค้า และจำนวน\n• เช่น "คุณสมชาย สั่งน้ำแข็งหลอดใหญ่ 2 ถุง"'
      };
    }
    
    // Check confidence threshold
    if (result.confidence < MIN_CONFIDENCE) {
      const corrected = applyIntelligentCorrections(result.text);
      return {
        success: true,
        text: corrected,
        original: result.text,
        confidence: result.confidence,
        warning: '⚠️ ระบบไม่แน่ใจ กรุณาตรวจสอบความถูกต้อง'
      };
    }
    
    const corrected = applyIntelligentCorrections(result.text);
    
    // Log for debugging
    Logger.info(`Voice: "${result.text}" → "${corrected}" (${(result.confidence * 100).toFixed(1)}%)`);
    
    return {
      success: true,
      text: corrected,
      original: result.text,
      confidence: result.confidence
    };
    
  } catch (error) {
    Logger.error('Voice processing failed', error);
    throw error;
  }
}

// ============================================================================
// FETCH AUDIO FROM LINE
// ============================================================================

async function fetchAudioFromLine(messageId) {
  try {
    const response = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { Authorization: `Bearer ${CONFIG.LINE_TOKEN}` }
    });

    if (!response.ok) {
      throw new Error(`LINE audio fetch failed: ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    Logger.error('fetchAudioFromLine failed', error);
    throw error;
  }
}

module.exports = {
  processVoiceMessage,
  fetchAudioFromLine
};
