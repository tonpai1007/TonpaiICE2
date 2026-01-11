// voiceHandler.js - COMPLETE: Professional voice message handler
const { Logger } = require('./logger');
const { transcribeAudio } = require('./aiServices');
const { handleMessage } = require('./messageHandlerService');
const { saveToInbox } = require('./inboxService');
const { getStockCache, getCustomerCache } = require('./cacheManager');

// ============================================================================
// VOICE TRANSCRIPTION CLEANER
// ============================================================================

class VoiceTranscriptionCleaner {
  constructor() {
    // Common Thai speech recognition errors
    this.corrections = {
      // Ice-related (most common)
      'แข็ง': 'น้ำแข็ง',
      'แข่ง': 'น้ำแข็ง',
      'เข็ง': 'น้ำแข็ง',
      'แกง': 'น้ำแข็ง',
      'เเข็ง': 'น้ำแข็ง',
      
      // Tube/Pipe (for ice)
      'ลอด': 'หลอด',
      'รอด': 'หลอด',
      'ลด': 'หลอด',
      
      // Common drinks
      'โคก': 'โค้ก',
      'โคค': 'โค้ก',
      'โกก': 'โค้ก',
      'เบีย': 'เบียร์',
      'เบียะ': 'เบียร์',
      'เบียร': 'เบียร์',
      
      // Actions
      'เติ่ม': 'เติม',
      'เตื่ม': 'เติม',
      'ลด': 'ลด',
      'จ่าย': 'จ่าย',
      'ชาย': 'จ่าย',
      'ส่ง': 'ส่ง',
      'สง': 'ส่ง',
      'ยกเลิก': 'ยกเลิก',
      'ยก': 'ยกเลิก',
      
      // Numbers (Thai words to digits)
      'หนึ่ง': '1',
      'สอง': '2',
      'สาม': '3',
      'สี่': '4',
      'ห้า': '5',
      'หก': '6',
      'เจ็ด': '7',
      'แปด': '8',
      'เก้า': '9',
      'สิบ': '10',
      'ยี่สิบ': '20',
      'สามสิบ': '30',
      'สี่สิบ': '40',
      'ห้าสิบ': '50',
      'หกสิบ': '60',
      'เจ็ดสิบ': '70',
      'แปดสิบ': '80',
      'เก้าสิบ': '90'
    };
    
    // Words to remove (filler words)
    this.fillerWords = [
      'ครับ', 'ค่ะ', 'นะ', 'จ้า', 'เนอะ',
      'อ่ะ', 'เอ่อ', 'อืม', 'เออ'
    ];
  }

  clean(text) {
    if (!text) return '';
    
    let cleaned = text.trim();
    
    // Step 1: Fix common misrecognitions (word by word)
    const words = cleaned.split(/\s+/);
    const correctedWords = words.map(word => {
      const lower = word.toLowerCase();
      return this.corrections[lower] || word;
    });
    
    cleaned = correctedWords.join(' ');
    
    // Step 2: Remove filler words
    this.fillerWords.forEach(filler => {
      const regex = new RegExp(`\\b${filler}\\b`, 'gi');
      cleaned = cleaned.replace(regex, '');
    });
    
    // Step 3: Fix spacing around numbers
    cleaned = cleaned.replace(/(\d+)\s*([ก-๙]+)/g, '$1 $2'); // "5น้ำ" → "5 น้ำ"
    cleaned = cleaned.replace(/([ก-๙]+)\s*(\d+)/g, '$1 $2'); // "น้ำ5" → "น้ำ 5"
    
    // Step 4: Normalize whitespace
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    Logger.info(`🧹 Cleaned: "${text}" → "${cleaned}"`);
    return cleaned;
  }

  hasChanges(original, cleaned) {
    return original.trim() !== cleaned.trim();
  }
}

// ============================================================================
// COMMAND TYPE DETECTOR
// ============================================================================

class CommandTypeDetector {
  detect(text) {
    const lower = text.toLowerCase();
    const hasNumber = /\d+/.test(text);
    
    // Priority 1: Simple commands (no AI needed)
    if (this.isSimpleCommand(lower)) {
      return {
        type: 'simple',
        confidence: 'high',
        command: this.extractSimpleCommand(lower, text)
      };
    }
    
    // Priority 2: Stock adjustment (has number + stock keywords)
    if (hasNumber && this.hasStockKeywords(lower)) {
      return {
        type: 'stock',
        confidence: 'high',
        details: this.extractStockDetails(text)
      };
    }
    
    // Priority 3: Order (has number but no stock keywords)
    if (hasNumber) {
      return {
        type: 'order',
        confidence: 'medium',
        details: this.extractOrderDetails(text)
      };
    }
    
    // Priority 4: Query/Info
    if (this.isQueryCommand(lower)) {
      return {
        type: 'query',
        confidence: 'high',
        command: text
      };
    }
    
    // Unknown
    return {
      type: 'unknown',
      confidence: 'low',
      text: text
    };
  }

  isSimpleCommand(lower) {
    const commands = ['จ่าย', 'ชำระ', 'ยกเลิก', 'ส่ง'];
    return commands.some(cmd => lower.includes(cmd));
  }

  hasStockKeywords(lower) {
    const keywords = ['มี', 'เหลือ', 'เติม', 'ลด', 'ปรับ', 'สต็อก'];
    return keywords.some(kw => lower.includes(kw));
  }

  isQueryCommand(lower) {
    const queries = ['สรุป', 'รายงาน', 'inbox', 'help', 'สถานะ', 'ดู'];
    return queries.some(q => lower.includes(q));
  }

  extractSimpleCommand(lower, original) {
    if (lower.includes('จ่าย') || lower.includes('ชำระ')) {
      return 'จ่าย';
    }
    if (lower.includes('ยกเลิก')) {
      return 'ยกเลิก';
    }
    if (lower.includes('ส่ง')) {
      const name = original.replace(/ส่ง/gi, '').trim();
      return name ? `ส่ง ${name}` : 'สถานะ';
    }
    return original;
  }

  extractStockDetails(text) {
    const numberMatch = text.match(/\d+/);
    const number = numberMatch ? parseInt(numberMatch[0]) : null;
    
    const lower = text.toLowerCase();
    let operation = 'set';
    
    if (lower.includes('เติม') || lower.includes('เพิ่ม')) {
      operation = 'add';
    } else if (lower.includes('ลด')) {
      operation = 'subtract';
    }
    
    const productName = text
      .replace(/เติม|ลด|มี|เหลือ|ปรับ|เพิ่ม/gi, '')
      .replace(/\d+/g, '')
      .replace(/ถุง|ขวด|กล่อง|ชิ้น|ลัง|แพ็ค/gi, '')
      .trim();
    
    return { productName, number, operation };
  }

  extractOrderDetails(text) {
    const numberMatch = text.match(/\d+/);
    const quantity = numberMatch ? parseInt(numberMatch[0]) : null;
    
    const productName = text
      .replace(/\d+/g, '')
      .replace(/ถุง|ขวด|กล่อง|ชิ้น|ลัง|แพ็ค/gi, '')
      .trim();
    
    return { productName, quantity };
  }
}

// ============================================================================
// COMMAND ENHANCER
// ============================================================================

class CommandEnhancer {
  constructor() {
    this.cleaner = new VoiceTranscriptionCleaner();
    this.detector = new CommandTypeDetector();
  }

  async enhance(text) {
    // Step 1: Clean transcription
    const cleaned = this.cleaner.clean(text);
    
    // Step 2: Detect command type
    const detection = this.detector.detect(cleaned);
    
    Logger.info(`🎯 Detected: ${detection.type} (${detection.confidence})`);
    
    // Step 3: Enhance based on type
    switch (detection.type) {
      case 'simple':
        return this.enhanceSimpleCommand(detection, cleaned);
      
      case 'stock':
        return await this.enhanceStockCommand(detection, cleaned);
      
      case 'order':
        return await this.enhanceOrderCommand(detection, cleaned);
      
      case 'query':
        return {
          success: true,
          enhanced: cleaned,
          confidence: 'high',
          explanation: 'คำสั่งสอบถามข้อมูล',
          original: text
        };
      
      default:
        return {
          success: false,
          enhanced: cleaned,
          confidence: 'low',
          explanation: 'ไม่เข้าใจคำสั่ง',
          original: text,
          suggestions: this.getSuggestions()
        };
    }
  }

  enhanceSimpleCommand(detection, cleaned) {
    return {
      success: true,
      enhanced: detection.command,
      confidence: 'high',
      explanation: `คำสั่ง: ${detection.command}`,
      original: cleaned,
      type: 'simple'
    };
  }

  async enhanceStockCommand(detection, cleaned) {
    const { productName, number, operation } = detection.details;
    
    if (!number) {
      return {
        success: false,
        enhanced: cleaned,
        confidence: 'low',
        explanation: 'ไม่พบจำนวน',
        original: cleaned,
        suggestions: ['ต้องระบุจำนวน เช่น "น้ำแข็ง มี 50"']
      };
    }
    
    if (!productName) {
      return {
        success: false,
        enhanced: cleaned,
        confidence: 'low',
        explanation: 'ไม่พบชื่อสินค้า',
        original: cleaned,
        suggestions: ['ต้องระบุชื่อสินค้า เช่น "น้ำแข็งหลอดใหญ่ มี 50"']
      };
    }
    
    // Find matching product in stock
    const stockCache = getStockCache();
    const matches = this.findProductMatches(productName, stockCache);
    
    if (matches.length === 0) {
      return {
        success: false,
        enhanced: cleaned,
        confidence: 'low',
        explanation: `ไม่พบสินค้า: ${productName}`,
        original: cleaned,
        suggestions: this.getSimilarProducts(productName, stockCache)
      };
    }
    
    if (matches.length > 1) {
      return {
        success: false,
        enhanced: cleaned,
        confidence: 'low',
        explanation: 'พบสินค้าหลายรายการ',
        original: cleaned,
        suggestions: matches.map(m => `• ${m.item} (${m.stock} ${m.unit})`)
      };
    }
    
    const product = matches[0];
    const operationWord = operation === 'add' ? 'เติม' :
                         operation === 'subtract' ? 'ลด' : 'มี';
    
    const enhanced = `${product.item} ${operationWord} ${number}`;
    
    return {
      success: true,
      enhanced: enhanced,
      confidence: 'high',
      explanation: `${operationWord}สต็อก ${product.item} ${number} ${product.unit}`,
      original: cleaned,
      type: 'stock',
      productMatch: product
    };
  }

  async enhanceOrderCommand(detection, cleaned) {
    const { productName, quantity } = detection.details;
    
    if (!quantity) {
      return {
        success: false,
        enhanced: cleaned,
        confidence: 'low',
        explanation: 'ไม่พบจำนวน',
        original: cleaned
      };
    }
    
    if (!productName) {
      return {
        success: false,
        enhanced: cleaned,
        confidence: 'low',
        explanation: 'ไม่พบชื่อสินค้า',
        original: cleaned
      };
    }
    
    // Find matching product
    const stockCache = getStockCache();
    const matches = this.findProductMatches(productName, stockCache);
    
    if (matches.length === 0) {
      return {
        success: false,
        enhanced: cleaned,
        confidence: 'low',
        explanation: `ไม่พบสินค้า: ${productName}`,
        original: cleaned,
        suggestions: this.getSimilarProducts(productName, stockCache)
      };
    }
    
    const product = matches[0];
    
    // Try to find customer name
    const customerCache = getCustomerCache();
    let customerName = 'ไม่ระบุ';
    
    for (const customer of customerCache) {
      if (cleaned.toLowerCase().includes(customer.name.toLowerCase())) {
        customerName = customer.name;
        break;
      }
    }
    
    const enhanced = `${product.item} ${quantity} ${product.unit} ${customerName}`;
    
    return {
      success: true,
      enhanced: enhanced,
      confidence: matches.length === 1 && customerName !== 'ไม่ระบุ' ? 'high' : 'medium',
      explanation: `สั่ง ${product.item} ${quantity} ${product.unit}${customerName !== 'ไม่ระบุ' ? ' ให้ ' + customerName : ''}`,
      original: cleaned,
      type: 'order',
      productMatch: product
    };
  }

  findProductMatches(searchTerm, stockCache) {
    const lower = searchTerm.toLowerCase();
    
    // Exact match
    let matches = stockCache.filter(item => 
      item.item.toLowerCase() === lower
    );
    
    if (matches.length > 0) return matches;
    
    // Contains match
    matches = stockCache.filter(item => 
      item.item.toLowerCase().includes(lower) ||
      lower.includes(item.item.toLowerCase())
    );
    
    return matches;
  }

  getSimilarProducts(searchTerm, stockCache, limit = 5) {
    const lower = searchTerm.toLowerCase();
    
    // Find products with similar characters
    const similar = stockCache
      .map(item => ({
        item: item,
        score: this.calculateSimilarity(lower, item.item.toLowerCase())
      }))
      .filter(x => x.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => `• ${x.item.item} (${x.item.stock} ${x.item.unit})`);
    
    return similar.length > 0 ? similar : ['พิมพ์ "สต็อก" เพื่อดูรายการทั้งหมด'];
  }

  calculateSimilarity(str1, str2) {
    let matchCount = 0;
    for (let char of str1) {
      if (str2.includes(char)) matchCount++;
    }
    return matchCount / Math.max(str1.length, str2.length);
  }

  getSuggestions() {
    return [
      '📦 สั่งสินค้า: "น้ำแข็ง 5 ร้านเจ๊แดง"',
      '🔧 ปรับสต็อก: "น้ำแข็ง มี 50"',
      '💰 ชำระเงิน: "จ่าย"',
      '❌ ยกเลิก: "ยกเลิก"',
      '📊 ดูสรุป: "สรุป"'
    ];
  }
}

// ============================================================================
// MAIN VOICE HANDLER
// ============================================================================

class VoiceMessageHandler {
  constructor() {
    this.enhancer = new CommandEnhancer();
  }

  async handle(audioBuffer, userId) {
    const startTime = Date.now();
    
    try {
      // Step 1: Transcribe audio
      Logger.info(`🎤 Processing voice (${(audioBuffer.length / 1024).toFixed(1)}KB)`);
      
      const { success, text } = await transcribeAudio(audioBuffer);
      
      if (!success || !text) {
        return this.createResponse({
          success: false,
          message: this.getTranscriptionErrorMessage(),
          inboxData: {
            userInput: '🎤 [ฟังไม่ออก]',
            result: 'ไม่สามารถแปลงเสียงเป็นข้อความได้',
            type: 'voice_error'
          }
        });
      }
      
      Logger.success(`📝 Transcribed: "${text}"`);
      
      // Step 2: Enhance command
      const enhanced = await this.enhancer.enhance(text);
      
      Logger.info(`✨ Enhancement result: ${enhanced.success ? 'SUCCESS' : 'FAILED'} (${enhanced.confidence})`);
      
      if (!enhanced.success) {
        return this.createResponse({
          success: false,
          message: this.getEnhancementErrorMessage(enhanced),
          inboxData: {
            userInput: `🎤 "${text}"`,
            result: `ไม่เข้าใจ: ${enhanced.explanation}`,
            type: 'voice_parse_error'
          }
        });
      }
      
      // Step 3: Show what we understood (if different)
      const feedback = this.generateFeedback(text, enhanced);
      
      // Step 4: Execute command
      const result = await handleMessage(enhanced.enhanced, userId);
      
      // Step 5: Save to inbox
      await saveToInbox(
        userId,
        `🎤 "${text}"`,
        enhanced.explanation || enhanced.enhanced,
        'voice'
      );
      
      // Step 6: Prepare response
      const processingTime = Date.now() - startTime;
      Logger.success(`✅ Voice processed in ${processingTime}ms`);
      
      return this.createResponse({
        success: true,
        message: feedback + result.message,
        enhanced: enhanced,
        original: text,
        processingTime: processingTime
      });
      
    } catch (error) {
      Logger.error('Voice handler error', error);
      
      return this.createResponse({
        success: false,
        message: this.getCriticalErrorMessage(error),
        error: error.message
      });
    }
  }

  createResponse(data) {
    return {
      success: data.success || false,
      message: data.message || 'Unknown error',
      enhanced: data.enhanced || null,
      original: data.original || null,
      processingTime: data.processingTime || 0,
      error: data.error || null,
      inboxData: data.inboxData || null
    };
  }

  generateFeedback(original, enhanced) {
    if (!enhanced.success) return '';
    
    // Only show feedback if we made significant changes
    if (original === enhanced.enhanced) return '';
    
    let feedback = `💡 ระบบเข้าใจว่า:\n"${enhanced.enhanced}"\n`;
    
    if (enhanced.confidence !== 'high') {
      feedback += `⚠️ ความมั่นใจ: ${enhanced.confidence}\n`;
    }
    
    if (enhanced.explanation) {
      feedback += `📝 ${enhanced.explanation}\n`;
    }
    
    feedback += `\n${'━'.repeat(30)}\n\n`;
    
    return feedback;
  }

  getTranscriptionErrorMessage() {
    return `❌ ฟังไม่ออก\n\n` +
           `💡 วิธีแก้:\n` +
           `• พูดช้าๆ ชัดๆ\n` +
           `• อยู่ในที่เงียบ\n` +
           `• ถือไมค์ใกล้ปาก\n` +
           `• หรือพิมพ์ข้อความมาแทน`;
  }

  getEnhancementErrorMessage(enhanced) {
    let msg = `❌ ${enhanced.explanation}\n\n`;
    msg += `🎤 คุณพูดว่า: "${enhanced.original}"\n\n`;
    
    if (enhanced.suggestions && enhanced.suggestions.length > 0) {
      msg += `💡 คำแนะนำ:\n`;
      enhanced.suggestions.forEach(suggestion => {
        msg += `${suggestion}\n`;
      });
    } else {
      msg += `💡 พิมพ์ "help" เพื่อดูตัวอย่างคำสั่ง`;
    }
    
    return msg;
  }

  getCriticalErrorMessage(error) {
    return `❌ เกิดข้อผิดพลาดในการประมวลผลเสียง\n\n` +
           `💡 วิธีแก้:\n` +
           `• ลองพูดใหม่อีกครั้ง\n` +
           `• หรือพิมพ์ข้อความมาแทน\n\n` +
           `🔧 Error: ${error.message}`;
  }
}

// ============================================================================
// SINGLETON INSTANCE & EXPORTS
// ============================================================================

const voiceHandler = new VoiceMessageHandler();

async function handleVoiceMessage(audioBuffer, userId) {
  return await voiceHandler.handle(audioBuffer, userId);
}

module.exports = {
  handleVoiceMessage,
  VoiceMessageHandler,
  VoiceTranscriptionCleaner,
  CommandTypeDetector,
  CommandEnhancer
};
