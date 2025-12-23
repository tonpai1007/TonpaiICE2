// voiceService.js - PERFECT Voice-to-text with Advanced AI Correction

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { transcribeAudio } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');
const { ITEM_ALIASES } = require('./constants');
const { normalizeText } = require('./utils');

// ============================================================================
// COMPREHENSIVE VOICE CORRECTIONS
// ============================================================================

const VOICE_CORRECTIONS = {
  // น้ำแข็ง - All possible variations
  'น้ำเเข็ง': 'น้ำแข็ง', 'น้ำเเข่ง': 'น้ำแข็ง', 'น้ำแกง': 'น้ำแข็ง',
  'น้ำแข่ง': 'น้ำแข็ง', 'น้ำขัง': 'น้ำแข็ง', 'น้าแข็ง': 'น้ำแข็ง',
  'น้ำค้าง': 'น้ำแข็ง', 'น้ำเข่ง': 'น้ำแข็ง', 'น้ำเค็ง': 'น้ำแข็ง',
  'นำแข็ง': 'น้ำแข็ง', 'น้ำแข้ง': 'น้ำแข็ง', 'น้ำเขิ่ง': 'น้ำแข็ง',
  
  // Product types - บด
  'บอด': 'บด', 'บ่อด': 'บด', 'บ๊อด': 'บด', 'บ๋อด': 'บด',
  'บ็อด': 'บด', 'บอต': 'บด', 'บ่อต': 'บด',
  
  // หลอด
  'หล่อด': 'หลอด', 'หลอต': 'หลอด', 'ห่อด': 'หลอด', 'หล็อด': 'หลอด',
  'ลอด': 'หลอด', 'ลอต': 'หลอด', 'หล๊อด': 'หลอด',
  
  // แผ่น
  'แพน': 'แผ่น', 'แพ่น': 'แผ่น', 'เพ่น': 'แผ่น', 'แพ็น': 'แผ่น',
  'แปน': 'แผ่น', 'เพน': 'แผ่น',
  
  // เกร็ด
  'เกร็ต': 'เกร็ด', 'เกด': 'เกร็ด', 'เก็ด': 'เกร็ด', 'เกรด': 'เกร็ด',
  
  // Sizes - ใหญ่
  'ใหย': 'ใหญ่', 'ใหย่': 'ใหญ่', 'ใหญ': 'ใหญ่', 'ใหญ้': 'ใหญ่',
  
  // เล็ก
  'เลก': 'เล็ก', 'เล็ค': 'เล็ก', 'เหล็ก': 'เล็ก', 'เล้ก': 'เล็ก',
  'เล่ก': 'เล็ก',
  
  // กลาง
  'กาง': 'กลาง', 'กล่าง': 'กลาง', 'กละง': 'กลาง',
  
  // Actions - สั่ง
  'สั้ง': 'สั่ง', 'ซั่ง': 'สั่ง', 'ซั้ง': 'สั่ง', 'สัง': 'สั่ง',
  'ซัง': 'สั่ง', 'สั๊ง': 'สั่ง',
  
  // ซื้อ
  'ซ้ือ': 'ซื้อ', 'ซื่อ': 'ซื้อ', 'ซือ': 'ซื้อ', 'ซ่ือ': 'ซื้อ',
  
  // เอา
  'เ้า': 'เอา', 'เ่า': 'เอา', 'เอ่า': 'เอา',
  
  // Containers - ถุง
  'ทุง': 'ถุง', 'ถุ่ง': 'ถุง', 'ทุ่ง': 'ถุง', 'ถุ่ง': 'ถุง',
  'ถึง': 'ถุง', 'ทึง': 'ถุง',
  
  // แพ็ค
  'แพค': 'แพ็ค', 'แพ๊ค': 'แพ็ค', 'แป็ค': 'แพ็ค', 'แปค': 'แพ็ค',
  'แพก': 'แพ็ค',
  
  // กระป๋อง
  'กระป้อง': 'กระป๋อง', 'กระปอง': 'กระป๋อง', 'กระป่อง': 'กระป๋อง',
  
  // ขวด
  'ขวต': 'ขวด', 'ขอด': 'ขวด', 'ขว็ด': 'ขวด',
  
  // Numbers - Thai
  'ห่า': 'ห้า', 'ห้่า': 'ห้า', 'ฮ่า': 'ห้า', 'ฮ้า': 'ห้า',
  'เจ็ต': 'เจ็ด', 'เจ็ค': 'เจ็ด', 'แจ็ด': 'เจ็ด', 'เจ๊ด': 'เจ็ด',
  'แปต': 'แปด', 'แป๊ด': 'แปด', 'แป็ด': 'แปด', 'เปด': 'แปด',
  'สิป': 'สิบ', 'สิ๊บ': 'สิบ', 'สิ็บ': 'สิบ', 'ซิบ': 'สิบ',
  'เกา': 'เก้า', 'เก่า': 'เก้า', 'เก๋า': 'เก้า',
  
  // Credit keywords
  'เคริดิต': 'เครดิต', 'เครติด': 'เครดิต', 'เคดิต': 'เครดิต',
  'เคร่ดิต': 'เครดิต', 'เครดิท': 'เครดิต',
  
  // Payment
  'จ้าย': 'จ่าย', 'จ๊าย': 'จ่าย', 'จาย': 'จ่าย',
  'ค้าง': 'ค้าง', 'คาง': 'ค้าง', 'ค้้าง': 'ค้าง',
};

// ============================================================================
// PHONETIC RULES FOR THAI
// ============================================================================

const PHONETIC_RULES = [
  // น้ำแข็ง compound words
  { pattern: /น[้ำาำ]+[\s]*[แเ][ขคกข][็่้๋๊๋ิง]/gi, replacement: 'น้ำแข็ง' },
  { pattern: /น[ำา้]+\s*แข[็่้ิ]ง/gi, replacement: 'น้ำแข็ง' },
  
  // บด variations
  { pattern: /บ[อ่๊๋็]+[ดต]/gi, replacement: 'บด' },
  
  // หลอด variations
  { pattern: /[หฮ]ล[่อ๊๋็]+[ดต]/gi, replacement: 'หลอด' },
  { pattern: /ล[อ่๊็]+[ดต]/gi, replacement: 'หลอด' },
  
  // แผ่น variations
  { pattern: /[แเ][พป][่็๊๋]?[นณ]/gi, replacement: 'แผ่น' },
  
  // Size variations
  { pattern: /ให[ญยย่][่๊๋]?/gi, replacement: 'ใหญ่' },
  { pattern: /[เแ]ล[็่]?[กค]/gi, replacement: 'เล็ก' },
  
  // Container variations
  { pattern: /[ทถ][ุุ่][่๋๊]?ง/gi, replacement: 'ถุง' },
  { pattern: /[แเ][พป][็๊]?ค/gi, replacement: 'แพ็ค' },
  
  // Action verbs
  { pattern: /[สซ][ั่๊]?[ง่]/gi, replacement: 'สั่ง' },
  { pattern: /[สซ][ื่ิ]?[อ้]/gi, replacement: 'ซื้อ' },
];

// ============================================================================
// CONTEXT-AWARE CORRECTIONS
// ============================================================================

function applyContextAwareCorrections(text, stockCache) {
  let corrected = text;
  
  // 1. Apply basic corrections
  for (const [wrong, right] of Object.entries(VOICE_CORRECTIONS)) {
    const regex = new RegExp(wrong, 'gi');
    corrected = corrected.replace(regex, right);
  }
  
  // 2. Apply phonetic rules
  for (const rule of PHONETIC_RULES) {
    corrected = corrected.replace(rule.pattern, rule.replacement);
  }
  
  // 3. Fix compound words (no spaces)
  corrected = corrected
    .replace(/น้ำ\s*แข็ง/g, 'น้ำแข็ง')
    .replace(/น้ำ\s*เเข็ง/g, 'น้ำแข็ง')
    .replace(/บ\s*ด/g, 'บด')
    .replace(/หล\s*อด/g, 'หลอด')
    .replace(/แผ\s*่น/g, 'แผ่น')
    .replace(/เกร\s*็ด/g, 'เกร็ด');
  
  // 4. Apply product aliases
  for (const [key, aliases] of Object.entries(ITEM_ALIASES)) {
    for (const alias of aliases) {
      const regex = new RegExp(`\\b${alias}\\b`, 'gi');
      corrected = corrected.replace(regex, key);
    }
  }
  
  // 5. Smart product matching from stock
  corrected = smartProductMatch(corrected, stockCache);
  
  // 6. Fix common Thai numeral mistakes
  corrected = corrected
    .replace(/หนึ่ง/g, '1')
    .replace(/สอง/g, '2')
    .replace(/สาม/g, '3')
    .replace(/สี่/g, '4')
    .replace(/ห้า/g, '5')
    .replace(/หก/g, '6')
    .replace(/เจ็ด/g, '7')
    .replace(/แปด/g, '8')
    .replace(/เก้า/g, '9')
    .replace(/สิบ/g, '10');
  
  return corrected.trim();
}

// ============================================================================
// SMART PRODUCT MATCHING
// ============================================================================

function smartProductMatch(text, stockCache) {
  // Find potential product mentions
  const words = text.split(/\s+/);
  let corrected = text;
  
  for (const item of stockCache) {
    const itemWords = item.item.toLowerCase().split(/\s+/);
    const itemNormalized = normalizeText(item.item);
    
    // Try to find partial matches
    for (let i = 0; i < words.length - 1; i++) {
      const twoWords = words.slice(i, i + 2).join(' ').toLowerCase();
      const threeWords = words.slice(i, i + 3).join(' ').toLowerCase();
      
      // Check if any substring matches item
      if (itemNormalized.includes(normalizeText(twoWords)) && normalizeText(twoWords).length >= 4) {
        // Replace with correct product name
        const regex = new RegExp(twoWords, 'gi');
        corrected = corrected.replace(regex, item.item);
      }
      
      if (itemNormalized.includes(normalizeText(threeWords)) && normalizeText(threeWords).length >= 6) {
        const regex = new RegExp(threeWords, 'gi');
        corrected = corrected.replace(regex, item.item);
      }
    }
  }
  
  return corrected;
}

// ============================================================================
// BUILD ENHANCED VOCABULARY
// ============================================================================

function buildEnhancedVocabulary() {
  const stockCache = getStockCache();
  const customerCache = getCustomerCache();
  
  Logger.info(`Building vocabulary from ${stockCache.length} products, ${customerCache.length} customers`);

  // Stock items and variations
  const stockTerms = new Set();
  stockCache.forEach(item => {
    // Add full product name
    stockTerms.add(item.item);
    
    // Add each word in product name
    item.item.split(/\s+/).forEach(word => {
      if (word.length >= 2) stockTerms.add(word);
    });
    
    // Add category
    if (item.category) stockTerms.add(item.category);
    
    // Add unit
    if (item.unit) stockTerms.add(item.unit);
    
    // Add SKU
    if (item.sku) stockTerms.add(item.sku);
    
    // Add common variations
    const normalized = normalizeText(item.item);
    if (normalized.includes('น้ำแข็ง')) {
      ['น้ำแข็ง', 'น้ำเเข็ง', 'น้ำแกง', 'น้ำค้าง'].forEach(v => stockTerms.add(v));
    }
    if (normalized.includes('บด')) {
      ['บด', 'บอด', 'บ่อด'].forEach(v => stockTerms.add(v));
    }
    if (normalized.includes('หลอด')) {
      ['หลอด', 'หล่อด', 'ลอด'].forEach(v => stockTerms.add(v));
    }
  });
  
  // Customer names and variations
  const customerTerms = new Set();
  customerCache.forEach(customer => {
    customerTerms.add(customer.name);
    customer.name.split(/\s+/).forEach(word => {
      if (word.length >= 2) customerTerms.add(word);
    });
  });
  
  // Product type keywords
  const productKeywords = [
    'น้ำแข็ง', 'น้ำเเข็ง', 'น้ำแกง', 'น้ำขัง', 'น้ำค้าง', 'น้ำเข่ง',
    'หลอด', 'หล่อด', 'ลอด', 'บด', 'บอด', 'บ่อด',
    'แผ่น', 'แพน', 'เพ่น', 'เกร็ด', 'เกด', 'ก้อน', 'มือ',
    'ใหญ่', 'ใหย', 'เล็ก', 'เล็ค', 'เหล็ก', 'กลาง', 'กาง',
    'ละเอียด', 'ละเอยด', 'หยาบ', 'ยาบ'
  ];
  
  // Container keywords
  const containerKeywords = [
    'ถุง', 'ทุง', 'ถุ่ง', 'กระสอบ', 'แพ็ค', 'แพค', 'แพ๊ค',
    'ขวด', 'ขวต', 'กระป๋อง', 'กระป้อง', 'ซอง', 'ซ่อง',
    'กล่อง', 'กล้อง', 'ลัง', 'ล้ัง', 'กั๊ก', 'กั้ก'
  ];
  
  // Action verbs
  const actionWords = [
    'สั่ง', 'สั้ง', 'ซั่ง', 'สัง', 'ซื้อ', 'ซ้ือ', 'ซื่อ',
    'เอา', 'เ้า', 'ขอ', 'ข้อ', 'ส่ง', 'ส้ง', 'โดย', 'ให้', 'ถึง'
  ];
  
  // Customer titles
  const titleWords = [
    'พี่', 'พ่ี', 'น้อง', 'น้้อง', 'คุณ', 'คุ๊ณ', 'เจ้', 'เจ๊',
    'ลุง', 'ลุ๊ง', 'ป้า', 'ป๊า', 'อา', 'อ๊า', 'น้า', 'น๊า'
  ];
  
  // Thai numbers and variations
  const numberWords = [
    'หนึ่ง', 'หนึง', 'หนึ่ง', 'สอง', 'ส', 'สาม', 'สี่', 'สี',
    'ห้า', 'ห่า', 'ฮ่า', 'หก', 'หอก', 'เจ็ด', 'เจ็ต', 'เจ๊ด',
    'แปด', 'แปต', 'แป๊ด', 'เก้า', 'เกา', 'เก่า',
    'สิบ', 'สิป', 'สิ๊บ', 'ซิบ', 'ยี่สิบ', 'สามสิบ'
  ];
  
  // Payment keywords
  const paymentKeywords = [
    'จ่าย', 'จ่ายแล้ว', 'จ้าย', 'จ๊าย', 'ชำระ', 'ชำระแล้ว',
    'เครดิต', 'เคริดิต', 'เครติด', 'ค้าง', 'คาง', 'ค้างชำระ',
    'ไว้ก่อน', 'ยังไม่จ่าย', 'หนี้', 'โอน', 'โอนแล้ว'
  ];
  
  // Combine all vocabularies
  const allWords = new Set([
    ...stockTerms,
    ...customerTerms,
    ...productKeywords,
    ...containerKeywords,
    ...actionWords,
    ...titleWords,
    ...numberWords,
    ...paymentKeywords,
    ...Object.keys(VOICE_CORRECTIONS),
    ...Object.values(VOICE_CORRECTIONS),
    ...Object.entries(ITEM_ALIASES).flatMap(([k, v]) => [k, ...v])
  ]);
  
  // Filter valid words (length >= 2)
  const vocabulary = Array.from(allWords).filter(word => word && word.length >= 2);
  
  Logger.success(`Enhanced vocabulary built: ${vocabulary.length} words`);
  
  return vocabulary;
}

// ============================================================================
// PROCESS VOICE WITH PERFECT ACCURACY
// ============================================================================

async function processVoiceMessage(audioBuffer) {
  const MIN_CONFIDENCE = 0.55; // Lowered for better acceptance
  const MIN_TEXT_LENGTH = 3;
  
  try {
    Logger.info('Starting perfect voice processing...');
    
    // Build vocabulary with stock context
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
    
    // Check confidence and provide appropriate warning
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
    Logger.error('Perfect voice processing failed', error);
    
    // Provide user-friendly error messages
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
    Logger.info(`Fetching audio from LINE: ${messageId}`);
    
    const response = await fetch(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      {
        headers: { 
          'Authorization': `Bearer ${CONFIG.LINE_TOKEN}` 
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
  applyContextAwareCorrections, // Export for testing
  buildEnhancedVocabulary // Export for testing
};