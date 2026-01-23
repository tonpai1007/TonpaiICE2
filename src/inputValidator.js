// src/inputValidator.js - Input validation and sanitization

const { Logger } = require('./logger');

class InputValidator {
  static validateOrderInput(text) {
    const issues = [];
    
    // Check minimum length
    if (!text || text.trim().length < 3) {
      issues.push('ข้อความสั้นเกินไป');
    }
    
    // Check maximum length
    if (text.length > 500) {
      issues.push('ข้อความยาวเกินไป (สูงสุด 500 ตัวอักษร)');
    }
    
    // Check for spam patterns
    if (/(.)\1{10,}/.test(text)) {
      issues.push('ข้อความมีรูปแบบผิดปกติ');
    }
    
    // Check if contains any numbers or Thai/English text
    if (!/[\u0E00-\u0E7F0-9a-zA-Z]/.test(text)) {
      issues.push('ไม่พบข้อความที่เข้าใจได้');
    }
    
    return {
      valid: issues.length === 0,
      issues: issues,
      sanitized: this.sanitizeInput(text)
    };
  }
  
  static sanitizeInput(text) {
    if (!text) return '';
    
    return text
      .trim()
      .replace(/\s+/g, ' ')  // Normalize whitespace
      .replace(/[<>]/g, '')   // Remove potential HTML
      .substring(0, 500);     // Enforce max length
  }
  
  static validateStockAdjustment(value, operation) {
    const issues = [];
    
    if (!Number.isInteger(value) || value < 0) {
      issues.push('จำนวนต้องเป็นตัวเลขบวก');
    }
    
    if (value > 100000) {
      issues.push('จำนวนมากเกินไป (สูงสุด 100,000)');
    }
    
    const validOperations = ['add', 'subtract', 'set'];
    if (!validOperations.includes(operation)) {
      issues.push('คำสั่งไม่ถูกต้อง');
    }
    
    return {
      valid: issues.length === 0,
      issues: issues
    };
  }
  
  static validateCustomerName(name) {
    if (!name || name.trim().length === 0) {
      return { valid: false, error: 'กรุณาระบุชื่อลูกค้า' };
    }
    
    const sanitized = name
      .trim()
      .replace(/[^\u0E00-\u0E7Fa-zA-Z\s]/g, '')
      .substring(0, 100);
    
    if (sanitized.length < 2) {
      return { valid: false, error: 'ชื่อลูกค้าสั้นเกินไป' };
    }
    
    return { valid: true, sanitized: sanitized };
  }
  
  static detectSpam(userId, text) {
    // Simple spam detection
    const spamPatterns = [
      /http[s]?:\/\//i,           // URLs
      /bit\.ly|tinyurl/i,         // Short links
      /คลิก|click here/i,         // Click bait
      /ฟรี.*(100%|เงิน|รางวัล)/i  // Free money scams
    ];
    
    for (const pattern of spamPatterns) {
      if (pattern.test(text)) {
        Logger.warn(`⚠️ Potential spam from ${userId.substring(0, 8)}`);
        return { isSpam: true, reason: 'Suspicious content detected' };
      }
    }
    
    return { isSpam: false };
  }
}

// Rate limiting per user
class UserRateLimiter {
  constructor() {
    this.userRequests = new Map();
    this.windowMs = 60000; // 1 minute
    this.maxRequests = 20;
  }
  
  checkLimit(userId) {
    const now = Date.now();
    
    if (!this.userRequests.has(userId)) {
      this.userRequests.set(userId, []);
    }
    
    const requests = this.userRequests.get(userId);
    
    // Clean old requests
    const validRequests = requests.filter(time => now - time < this.windowMs);
    this.userRequests.set(userId, validRequests);
    
    if (validRequests.length >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetIn: Math.ceil((validRequests[0] + this.windowMs - now) / 1000)
      };
    }
    
    validRequests.push(now);
    
    return {
      allowed: true,
      remaining: this.maxRequests - validRequests.length
    };
  }
  
  cleanup() {
    const now = Date.now();
    for (const [userId, requests] of this.userRequests.entries()) {
      const validRequests = requests.filter(time => now - time < this.windowMs);
      if (validRequests.length === 0) {
        this.userRequests.delete(userId);
      } else {
        this.userRequests.set(userId, validRequests);
      }
    }
  }
}

const userRateLimiter = new UserRateLimiter();

// Cleanup every minute
setInterval(() => userRateLimiter.cleanup(), 60000);

module.exports = {
  InputValidator,
  userRateLimiter
};