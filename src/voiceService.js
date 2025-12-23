// ============================================================================
// OPTIMIZED VOICE SERVICE - PRODUCTION READY
// ============================================================================

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { transcribeAudio } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');
const { normalizeText, similarity: calculateSimilarity } = require('./utils');

// ============================================================================
// SMART VOCABULARY BUILDER
// ============================================================================

function buildSmartVocabulary() {
  const stockCache = getStockCache();
  const customerCache = getCustomerCache();

  // Priority 1: Customer names (MOST IMPORTANT)
  const customerNames = customerCache.map(c => c.name);
  
  // Priority 2: Full stock item names
  const stockItems = stockCache.map(item => item.item);
  
  // Priority 3: Break down stock into keywords
  const stockKeywords = new Set();
  stockCache.forEach(item => {
    const words = item.item.split(/\s+/);
    words.forEach(word => {
      if (word.length >= 2) stockKeywords.add(word);
    });
    if (item.category) stockKeywords.add(item.category);
  });

  // Priority 4: Essential words
  const essentialWords = [
    // Numbers
    'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า', 'สิบ',
    // Actions
    'สั่ง', 'ซื้อ', 'เอา', 'ขอ', 'ส่ง',
    // Units
    'ถุง', 'กระสอบ', 'แพ็ค', 'ขวด', 'กระป๋อง', 'ซอง', 'อัน', 'กล่อง',
    // Titles
    'พี่', 'น้อง', 'คุณ', 'ลุง', 'ป้า', 'อา', 'น้า', 'เจ้'
  ];

  const vocabulary = [
    ...customerNames,
    ...stockItems,
    ...Array.from(stockKeywords),
    ...essentialWords
  ].filter(word => word && word.length >= 2);

  Logger.info(`Vocabulary built: ${vocabulary.length} words (${customerNames.length} customers, ${stockItems.length} products)`);
  
  return vocabulary;
}

// ============================================================================
// MAIN VOICE PROCESSING
// ============================================================================

async function processVoiceMessage(audioBuffer) {
  const MIN_CONFIDENCE = 0.65;
  const MIN_TEXT_LENGTH = 5;
  
  try {
    // Step 1: Build vocabulary with customer priority
    const vocabulary = buildSmartVocabulary();
    
    // Step 2: Transcribe audio
    const result = await transcribeAudio(audioBuffer, vocabulary);
    
    // Step 3: Basic validation
    if (!result.text || result.text.trim().length < MIN_TEXT_LENGTH) {
      return {
        success: false,
        error: '🎤 ไม่สามารถแปลงเสียงได้ชัด\n\n💡 กรุณาลองใหม่:\n• พูดช้าๆ ชัดๆ\n• ระบุ: ชื่อลูกค้า + สินค้า + จำนวน\n• ตัวอย่าง: "พี่สมชาย สั่งน้ำแข็งหลอดใหญ่ 2 ถุง"'
      };
    }
    
    const transcribedText = result.text.trim();
    Logger.info(`Transcribed: "${transcribedText}" (confidence: ${(result.confidence * 100).toFixed(1)}%)`);
    
    // Step 4: Parse with intelligent context
    const parsed = await parseVoiceWithContext(transcribedText, result.confidence);
    
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error,
        original: transcribedText,
        suggestions: parsed.suggestions
      };
    }
    
    // Step 5: Build clean command for order processing
    const cleanCommand = `${parsed.customer} สั่ง ${parsed.product} ${parsed.quantity} ${parsed.unit}`;
    
    Logger.success(`Voice → Order: "${cleanCommand}"`);
    Logger.info(`Match scores: Customer=${parsed.customerScore.toFixed(2)}, Product=${parsed.productScore.toFixed(2)}, Overall=${parsed.overallConfidence.toFixed(2)}`);
    
    return {
      success: true,
      text: cleanCommand,
      original: transcribedText,
      confidence: result.confidence,
      parsed: parsed,
      warning: parsed.overallConfidence < 0.7 ? '⚠️ ความมั่นใจต่ำ กรุณาตรวจสอบ' : null
    };
    
  } catch (error) {
    Logger.error('Voice processing failed', error);
    throw error;
  }
}

// ============================================================================
// INTELLIGENT CONTEXT PARSING
// ============================================================================

async function parseVoiceWithContext(text, transcriptionConfidence) {
  const customerCache = getCustomerCache();
  const stockCache = getStockCache();
  
  // Step 1: Find customer (PRIORITY)
  const customerMatch = findBestCustomer(text, customerCache);
  
  if (!customerMatch || customerMatch.score < 0.4) {
    const suggestions = getSuggestedCustomers(text, customerCache, 3);
    return {
      success: false,
      error: '❌ ไม่พบชื่อลูกค้าในระบบ\n\nกรุณาพูดชื่อลูกค้าให้ชัดเจน',
      suggestions: suggestions
    };
  }
  
  Logger.info(`✓ Customer: "${customerMatch.name}" (score: ${customerMatch.score.toFixed(2)})`);
  
  // Step 2: Extract quantity
  const quantity = extractQuantity(text);
  
  if (!quantity || quantity < 1 || quantity > 100) {
    return {
      success: false,
      error: `❌ จำนวนไม่ถูกต้อง\n\nลูกค้า: ${customerMatch.name}\n\nกรุณาระบุจำนวน เช่น "2 ถุง", "สามขวด"`,
      suggestions: null
    };
  }
  
  Logger.info(`✓ Quantity: ${quantity}`);
  
  // Step 3: Find product (remove customer name from search)
  const productQuery = text
    .toLowerCase()
    .replace(new RegExp(customerMatch.name, 'gi'), '')
    .replace(/พี่|น้อง|คุณ|ลุง|ป้า|อา|น้า|เจ้/g, '')
    .replace(/สั่ง|ซื้อ|เอา|ขอ|ส่ง/g, '')
    .replace(/\d+\s*(ถุง|กระสอบ|แพ็ค|ขวด|อัน|กล่อง|กระป๋อง)/g, '')
    .trim();
  
  const productMatch = findBestProduct(productQuery, stockCache);
  
  if (!productMatch || productMatch.score < 0.3) {
    const suggestions = getSuggestedProducts(productQuery, stockCache, 5);
    return {
      success: false,
      error: `❌ ไม่พบสินค้าที่ตรงกัน\n\nลูกค้า: ${customerMatch.name}\nจำนวน: ${quantity}\n\nกรุณาระบุชื่อสินค้าให้ชัด`,
      suggestions: suggestions
    };
  }
  
  Logger.info(`✓ Product: "${productMatch.item}" (score: ${productMatch.score.toFixed(2)})`);
  
  // Step 4: Calculate overall confidence
  const overallConfidence = (
    customerMatch.score * 0.35 +
    productMatch.score * 0.35 +
    transcriptionConfidence * 0.30
  );
  
  return {
    success: true,
    customer: customerMatch.name,
    customerScore: customerMatch.score,
    product: productMatch.item,
    productScore: productMatch.score,
    quantity: quantity,
    unit: productMatch.unit,
    overallConfidence: overallConfidence,
    transcriptionConfidence: transcriptionConfidence
  };
}

// ============================================================================
// CUSTOMER MATCHING
// ============================================================================

function findBestCustomer(text, customerCache) {
  const textLower = text.toLowerCase();
  const textNorm = normalizeText(text);
  
  let bestMatch = null;
  let bestScore = 0;
  
  for (const customer of customerCache) {
    const customerLower = customer.name.toLowerCase();
    const customerNorm = normalizeText(customer.name);
    
    let score = 0;
    
    // Exact match (highest priority)
    if (textNorm.includes(customerNorm) || customerNorm.includes(textNorm)) {
      score = 1.0;
    }
    // Contains full name
    else if (textLower.includes(customerLower)) {
      score = 0.9;
    }
    // Word-by-word match
    else {
      const textWords = textLower.split(/\s+/);
      const customerWords = customerLower.split(/\s+/);
      
      let matchedWords = 0;
      for (const cWord of customerWords) {
        if (cWord.length >= 2 && textWords.some(tWord => tWord.includes(cWord) || cWord.includes(tWord))) {
          matchedWords++;
        }
      }
      
      if (matchedWords > 0) {
        score = matchedWords / customerWords.length * 0.8;
      }
    }
    
    // Fuzzy match as fallback
    if (score < 0.5) {
      const similarity = calculateSimilarity(textNorm, customerNorm);
      if (similarity > score) {
        score = similarity * 0.7;
      }
    }
    
    if (score > bestScore) {
      bestScore = score;
      bestMatch = customer;
    }
  }
  
  if (!bestMatch) return null;
  
  return {
    name: bestMatch.name,
    score: bestScore,
    phone: bestMatch.phone,
    address: bestMatch.address
  };
}

// ============================================================================
// PRODUCT MATCHING
// ============================================================================

function findBestProduct(query, stockCache) {
  const queryLower = query.toLowerCase();
  const queryNorm = normalizeText(query);
  const queryWords = queryLower.split(/\s+/).filter(w => w.length >= 2);
  
  let bestMatch = null;
  let bestScore = 0;
  
  for (const item of stockCache) {
    const itemLower = item.item.toLowerCase();
    const itemNorm = normalizeText(item.item);
    const itemWords = itemLower.split(/\s+/);
    
    let score = 0;
    
    // Exact normalized match
    if (queryNorm === itemNorm) {
      score = 1.0;
    }
    // Contains query
    else if (itemNorm.includes(queryNorm) || queryNorm.includes(itemNorm)) {
      score = 0.9;
    }
    // Word matching
    else {
      let matchedWords = 0;
      for (const qWord of queryWords) {
        for (const iWord of itemWords) {
          if (qWord.includes(iWord) || iWord.includes(qWord)) {
            matchedWords++;
            break;
          }
        }
      }
      
      if (matchedWords > 0) {
        const wordScore = matchedWords / Math.max(queryWords.length, itemWords.length);
        score = wordScore * 0.8;
      }
    }
    
    // Category boost
    if (item.category && queryLower.includes(item.category.toLowerCase())) {
      score += 0.1;
    }
    
    // Fuzzy fallback
    if (score < 0.4) {
      const similarity = calculateSimilarity(queryNorm, itemNorm);
      if (similarity > score) {
        score = similarity * 0.6;
      }
    }
    
    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }
  
  if (!bestMatch) return null;
  
  return {
    item: bestMatch.item,
    unit: bestMatch.unit,
    price: bestMatch.price,
    stock: bestMatch.stock,
    score: bestScore
  };
}

// ============================================================================
// QUANTITY EXTRACTION
// ============================================================================

function extractQuantity(text) {
  const thaiNumbers = {
    'หนึ่ง': 1, 'นึ่ง': 1, 'นึง': 1,
    'สอง': 2, 'ส': 2,
    'สาม': 3,
    'สี่': 4, 'สี': 4,
    'ห้า': 5,
    'หก': 6,
    'เจ็ด': 7,
    'แปด': 8,
    'เก้า': 9,
    'สิบ': 10,
    'สิบเอ็ด': 11,
    'สิบสอง': 12,
    'ยี่สิบ': 20,
    'สามสิบ': 30
  };
  
  // Try digit with unit
  const digitMatch = text.match(/(\d+)\s*(?:ถุง|กระสอบ|แพ็ค|ขวด|อัน|กล่อง|กระป๋อง|ซอง)/i);
  if (digitMatch) {
    return parseInt(digitMatch[1]);
  }
  
  // Try Thai numbers with unit
  for (const [thai, num] of Object.entries(thaiNumbers)) {
    const pattern = new RegExp(`${thai}\\s*(?:ถุง|กระสอบ|แพ็ค|ขวด|อัน|กล่อง|กระป๋อง|ซอง)`, 'i');
    if (pattern.test(text)) {
      return num;
    }
  }
  
  // Try standalone digit
  const standaloneDigit = text.match(/\b(\d+)\b/);
  if (standaloneDigit) {
    const num = parseInt(standaloneDigit[1]);
    // Ignore if it looks like a price (> 15)
    if (num <= 15) {
      return num;
    }
  }
  
  return 1;
}

// ============================================================================
// SUGGESTION HELPERS
// ============================================================================

function getSuggestedCustomers(text, customerCache, limit) {
  const textNorm = normalizeText(text);
  
  const matches = customerCache
    .map(c => ({
      name: c.name,
      score: calculateSimilarity(textNorm, normalizeText(c.name))
    }))
    .filter(m => m.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  
  if (matches.length === 0) return '\n\n💡 ไม่มีชื่อลูกค้าที่คล้ายกัน\nกรุณาเพิ่มลูกค้าใหม่ในระบบ';
  
  return `\n\n💡 ลูกค้าที่คล้ายกัน:\n${matches.map(m => `• ${m.name}`).join('\n')}`;
}

function getSuggestedProducts(query, stockCache, limit) {
  const queryNorm = normalizeText(query);
  
  const matches = stockCache
    .map(item => ({
      item: item.item,
      score: calculateSimilarity(queryNorm, normalizeText(item.item))
    }))
    .filter(m => m.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  
  if (matches.length === 0) return '\n\n💡 ไม่มีสินค้าที่คล้ายกัน';
  
  return `\n\n💡 สินค้าที่คล้ายกัน:\n${matches.map(m => `• ${m.item}`).join('\n')}`;
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

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  processVoiceMessage,
  fetchAudioFromLine
};