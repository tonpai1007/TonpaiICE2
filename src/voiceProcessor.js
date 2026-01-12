// src/voiceProcessor.js - UNIFIED: All voice processing in ONE file
const { Logger } = require('./logger');
const { transcribeAudio } = require('./aiServices');
const { handleMessage } = require('./messageHandlerService');
const { saveToInbox } = require('./inboxService');
const { getStockCache, getCustomerCache } = require('./cacheManager');

// ============================================================================
// TRANSCRIPTION CLEANER
// ============================================================================

class TranscriptionCleaner {
  constructor() {
    this.corrections = {
      'แข็ง': 'น้ำแข็ง', 'แข่ง': 'น้ำแข็ง', 'เข็ง': 'น้ำแข็ง',
      'ลอด': 'หลอด', 'รอด': 'หลอด',
      'โคก': 'โค้ก', 'โคค': 'โค้ก',
      'เบีย': 'เบียร์', 'เบียะ': 'เบียร์',
      'เติ่ม': 'เติม', 'ชาย': 'จ่าย', 'สง': 'ส่ง',
      'หนึ่ง': '1', 'สอง': '2', 'สาม': '3', 'สี่': '4', 'ห้า': '5',
      'หก': '6', 'เจ็ด': '7', 'แปด': '8', 'เก้า': '9', 'สิบ': '10'
    };
    this.fillers = ['ครับ', 'ค่ะ', 'นะ', 'จ้า'];
  }

  clean(text) {
    if (!text) return '';
    let cleaned = text.trim();
    
    // Fix words
    const words = cleaned.split(/\s+/);
    const corrected = words.map(w => this.corrections[w.toLowerCase()] || w);
    cleaned = corrected.join(' ');
    
    // Remove fillers
    this.fillers.forEach(f => {
      cleaned = cleaned.replace(new RegExp(`\\b${f}\\b`, 'gi'), '');
    });
    
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    
    if (cleaned !== text.trim()) {
      Logger.info(`🧹 Cleaned: "${text}" → "${cleaned}"`);
    }
    
    return cleaned;
  }
}

// ============================================================================
// COMMAND ENHANCER
// ============================================================================

class CommandEnhancer {
  constructor() {
    this.cleaner = new TranscriptionCleaner();
  }

  async enhance(text) {
    const cleaned = this.cleaner.clean(text);
    const lower = cleaned.toLowerCase();
    
    // Simple commands
    if (['จ่าย', 'ยกเลิก', 'สรุป', 'inbox'].some(cmd => lower.includes(cmd))) {
      return { success: true, enhanced: cleaned, type: 'simple' };
    }
    
    // Has number = likely order or stock adjustment
    if (/\d+/.test(cleaned)) {
      // Stock keywords present?
      if (['มี', 'เหลือ', 'เติม', 'ลด'].some(kw => lower.includes(kw))) {
        return await this.handleStockCommand(cleaned);
      }
      // Otherwise treat as order
      return await this.handleOrderCommand(cleaned);
    }
    
    return {
      success: false,
      enhanced: cleaned,
      error: 'ไม่เข้าใจคำสั่ง',
      suggestions: ['พูด: "น้ำแข็ง 5 ร้านเจ๊แดง"', 'หรือ: "น้ำแข็ง มี 50"']
    };
  }

  async handleStockCommand(text) {
    const numberMatch = text.match(/\d+/);
    if (!numberMatch) {
      return { success: false, error: 'ไม่พบจำนวน' };
    }
    
    const number = parseInt(numberMatch[0]);
    const lower = text.toLowerCase();
    
    let operation = 'set';
    if (lower.includes('เติม')) operation = 'add';
    else if (lower.includes('ลด')) operation = 'subtract';
    
    const productName = text
      .replace(/เติม|ลด|มี|เหลือ/gi, '')
      .replace(/\d+/g, '')
      .replace(/ถุง|ขวด|กล่อง/gi, '')
      .trim();
    
    const stockCache = getStockCache();
    const match = this.findProduct(productName, stockCache);
    
    if (!match) {
      return {
        success: false,
        error: `ไม่พบสินค้า: ${productName}`,
        suggestions: this.getSimilarProducts(productName, stockCache)
      };
    }
    
    const opWord = operation === 'add' ? 'เติม' : operation === 'subtract' ? 'ลด' : 'มี';
    return {
      success: true,
      enhanced: `${match.item} ${opWord} ${number}`,
      type: 'stock',
      confidence: 'high'
    };
  }

  async handleOrderCommand(text) {
    const numberMatch = text.match(/\d+/);
    if (!numberMatch) {
      return { success: false, error: 'ไม่พบจำนวน' };
    }
    
    const quantity = parseInt(numberMatch[0]);
    const productName = text
      .replace(/\d+/g, '')
      .replace(/ถุง|ขวด|กล่อง/gi, '')
      .trim();
    
    const stockCache = getStockCache();
    const match = this.findProduct(productName, stockCache);
    
    if (!match) {
      return {
        success: false,
        error: `ไม่พบสินค้า: ${productName}`,
        suggestions: this.getSimilarProducts(productName, stockCache)
      };
    }
    
    // Try to find customer
    const customerCache = getCustomerCache();
    let customer = 'ไม่ระบุ';
    for (const c of customerCache) {
      if (text.toLowerCase().includes(c.name.toLowerCase())) {
        customer = c.name;
        break;
      }
    }
    
    return {
      success: true,
      enhanced: `${match.item} ${quantity} ${customer}`,
      type: 'order',
      confidence: customer !== 'ไม่ระบุ' ? 'high' : 'medium'
    };
  }

  findProduct(searchTerm, stockCache) {
    const lower = searchTerm.toLowerCase();
    
    // Exact match
    let match = stockCache.find(i => i.item.toLowerCase() === lower);
    if (match) return match;
    
    // Contains match
    const matches = stockCache.filter(i => 
      i.item.toLowerCase().includes(lower) || 
      lower.includes(i.item.toLowerCase())
    );
    
    return matches.length === 1 ? matches[0] : null;
  }

  getSimilarProducts(searchTerm, stockCache) {
    const lower = searchTerm.toLowerCase();
    const similar = stockCache
      .map(item => ({
        item,
        score: this.similarity(lower, item.item.toLowerCase())
      }))
      .filter(x => x.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(x => `• ${x.item.item}`);
    
    return similar.length > 0 ? similar : ['พิมพ์ "สต็อก" เพื่อดูรายการ'];
  }

  similarity(s1, s2) {
    let count = 0;
    for (let char of s1) {
      if (s2.includes(char)) count++;
    }
    return count / Math.max(s1.length, s2.length);
  }
}

// ============================================================================
// MAIN VOICE PROCESSOR
// ============================================================================

async function processVoiceMessage(audioBuffer, userId) {
  const startTime = Date.now();
  
  try {
    Logger.info(`🎤 Processing voice (${(audioBuffer.length / 1024).toFixed(1)}KB)`);
    
    // Step 1: Transcribe
    const { success, text } = await transcribeAudio(audioBuffer);
    
    if (!success || !text) {
      await saveToInbox(userId, '🎤 [ฟังไม่ออก]', 'ไม่สามารถแปลงเสียง', 'voice_error');
      return {
        success: false,
        message: '❌ ฟังไม่ออก\n\n💡 ลองพูดใหม่ช้าๆ ชัดๆ\nหรือพิมพ์ข้อความมาแทน'
      };
    }
    
    Logger.success(`📝 Transcribed: "${text}"`);
    
    // Step 2: Enhance
    const enhancer = new CommandEnhancer();
    const enhanced = await enhancer.enhance(text);
    
    if (!enhanced.success) {
      await saveToInbox(userId, `🎤 "${text}"`, enhanced.error, 'voice_parse_error');
      
      let msg = `❌ ${enhanced.error}\n\n`;
      msg += `🎤 คุณพูดว่า: "${text}"\n\n`;
      if (enhanced.suggestions) {
        msg += `💡 ตัวอย่าง:\n${enhanced.suggestions.join('\n')}`;
      }
      return { success: false, message: msg };
    }
    
    Logger.info(`✨ Enhanced: "${enhanced.enhanced}" (${enhanced.confidence || 'medium'})`);
    
    // Step 3: Show what we understood (if changed)
    let feedback = '';
    if (text !== enhanced.enhanced) {
      feedback = `💡 เข้าใจว่า: "${enhanced.enhanced}"\n\n${'━'.repeat(30)}\n\n`;
    }
    
    // Step 4: Execute
    const result = await handleMessage(enhanced.enhanced, userId);
    
    // Step 5: Save
    await saveToInbox(userId, `🎤 "${text}"`, enhanced.enhanced, 'voice');
    
    const duration = Date.now() - startTime;
    Logger.success(`✅ Voice processed in ${duration}ms`);
    
    return {
      success: true,
      message: feedback + result.message,
      processingTime: duration
    };
    
  } catch (error) {
    Logger.error('Voice processing failed', error);
    return {
      success: false,
      message: '❌ เกิดข้อผิดพลาด\n\nลองใหม่อีกครั้ง'
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  processVoiceMessage,
  TranscriptionCleaner,
  CommandEnhancer
};
