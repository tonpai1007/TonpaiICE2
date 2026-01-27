// enhancedValidator.js - NEW: Comprehensive validation with user-friendly errors
const { STOCK, ORDER, TEXT, CUSTOMER_PREFIXES } = require('./constants');
const { Logger } = require('./logger');

class EnhancedValidator {
  // ============================================================================
  // ORDER VALIDATION
  // ============================================================================
  
  static validateOrder(orderData) {
    const errors = [];
    const warnings = [];
    
    // Validate customer
    const customerValidation = this.validateCustomerName(orderData.customer);
    if (!customerValidation.valid) {
      errors.push(customerValidation.error);
    }
    
    // Validate items
    if (!orderData.items || !Array.isArray(orderData.items)) {
      errors.push('ต้องมีรายการสินค้าอย่างน้อย 1 รายการ');
    } else {
      if (orderData.items.length === 0) {
        errors.push('ต้องมีรายการสินค้าอย่างน้อย 1 รายการ');
      }
      
      if (orderData.items.length > ORDER.MAX_ITEMS_PER_ORDER) {
        errors.push(`สั่งได้สูงสุด ${ORDER.MAX_ITEMS_PER_ORDER} รายการต่อออเดอร์`);
      }
      
      // Validate each item
      orderData.items.forEach((item, idx) => {
        const itemValidation = this.validateOrderItem(item, idx);
        errors.push(...itemValidation.errors);
        warnings.push(...itemValidation.warnings);
      });
    }
    
    // Validate total value
    if (orderData.items && orderData.items.length > 0) {
      const totalValue = orderData.items.reduce((sum, item) => {
        return sum + (item.quantity * (item.stockItem?.price || 0));
      }, 0);
      
      if (totalValue > ORDER.MAX_ORDER_VALUE) {
        errors.push(`ยอดรวมเกินกำหนด (${totalValue.toLocaleString()}฿ > ${ORDER.MAX_ORDER_VALUE.toLocaleString()}฿)`);
      }
      
      if (totalValue === 0) {
        errors.push('ยอดรวมต้องมากกว่า 0฿');
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
  
  static validateOrderItem(item, index) {
    const errors = [];
    const warnings = [];
    
    if (!item.stockItem) {
      errors.push(`รายการที่ ${index + 1}: ไม่พบข้อมูลสินค้า`);
      return { errors, warnings };
    }
    
    // Validate product name
    if (!item.stockItem.item || item.stockItem.item.trim() === '') {
      errors.push(`รายการที่ ${index + 1}: ชื่อสินค้าไม่ถูกต้อง`);
    }
    
    // Validate quantity
    const qtyValidation = this.validateQuantity(item.quantity, item.stockItem.item);
    if (!qtyValidation.valid) {
      errors.push(`รายการที่ ${index + 1}: ${qtyValidation.error}`);
    }
    if (qtyValidation.warning) {
      warnings.push(`รายการที่ ${index + 1}: ${qtyValidation.warning}`);
    }
    
    // Validate price
    if (typeof item.stockItem.price !== 'number' || item.stockItem.price < 0) {
      errors.push(`รายการที่ ${index + 1}: ราคาไม่ถูกต้อง`);
    }
    
    // Validate stock availability
    if (item.stockItem.stock !== undefined) {
      if (item.quantity > item.stockItem.stock) {
        errors.push(
          `${item.stockItem.item}: สต็อกไม่พอ ` +
          `(มี ${item.stockItem.stock} ต้องการ ${item.quantity})`
        );
      }
    }
    
    return { errors, warnings };
  }
  
  // ============================================================================
  // QUANTITY VALIDATION
  // ============================================================================
  
  static validateQuantity(quantity, itemName = '') {
    if (!Number.isInteger(quantity)) {
      return {
        valid: false,
        error: 'จำนวนต้องเป็นตัวเลขเต็ม'
      };
    }
    
    if (quantity < ORDER.MIN_QUANTITY_PER_ITEM) {
      return {
        valid: false,
        error: `จำนวนต้องมากกว่า ${ORDER.MIN_QUANTITY_PER_ITEM}`
      };
    }
    
    if (quantity > ORDER.MAX_QUANTITY_PER_ITEM) {
      return {
        valid: false,
        error: `จำนวนเกินกำหนด (สูงสุด ${ORDER.MAX_QUANTITY_PER_ITEM} ${itemName ? 'ต่อรายการ' : ''})`
      };
    }
    
    // Warn for unusual quantities
    if (quantity > ORDER.UNUSUAL_QUANTITY_THRESHOLD) {
      return {
        valid: true,
        warning: `จำนวนมาก (${quantity}) กรุณาตรวจสอบอีกครั้ง`
      };
    }
    
    return { valid: true };
  }
  
  // ============================================================================
  // CUSTOMER NAME VALIDATION
  // ============================================================================
  
  static validateCustomerName(name) {
    if (!name || typeof name !== 'string') {
      return {
        valid: false,
        error: 'กรุณาระบุชื่อลูกค้า'
      };
    }
    
    const trimmed = name.trim();
    
    if (trimmed.length < TEXT.MIN_CUSTOMER_NAME_LENGTH) {
      return {
        valid: false,
        error: `ชื่อลูกค้าสั้นเกินไป (ต้องมีอย่างน้อย ${TEXT.MIN_CUSTOMER_NAME_LENGTH} ตัวอักษร)`
      };
    }
    
    if (trimmed.length > TEXT.MAX_CUSTOMER_NAME_LENGTH) {
      return {
        valid: false,
        error: `ชื่อลูกค้ายาวเกินไป (สูงสุด ${TEXT.MAX_CUSTOMER_NAME_LENGTH} ตัวอักษร)`
      };
    }
    
    // Check for invalid characters
    const invalidChars = /[<>{}[\]\\\/]/;
    if (invalidChars.test(trimmed)) {
      return {
        valid: false,
        error: 'ชื่อลูกค้ามีอักขระที่ไม่อนุญาต'
      };
    }
    
    // Warn if doesn't have common prefix
    const hasPrefix = CUSTOMER_PREFIXES.some(prefix => 
      trimmed.startsWith(prefix)
    );
    
    if (!hasPrefix && trimmed !== 'ไม่ระบุ') {
      Logger.debug(`Customer name "${trimmed}" doesn't have common prefix`);
    }
    
    return {
      valid: true,
      sanitized: this.sanitizeCustomerName(trimmed)
    };
  }
  
  static sanitizeCustomerName(name) {
    return name
      .trim()
      .replace(/[<>{}[\]\\\/]/g, '')
      .substring(0, TEXT.MAX_CUSTOMER_NAME_LENGTH);
  }
  
  // ============================================================================
  // STOCK ADJUSTMENT VALIDATION
  // ============================================================================
  
  static validateStockAdjustment(itemName, value, operation) {
    const errors = [];
    
    if (!itemName || itemName.trim() === '') {
      errors.push('ไม่พบชื่อสินค้า');
    }
    
    if (!Number.isInteger(value) || value < 0) {
      errors.push('จำนวนต้องเป็นตัวเลขบวก');
    }
    
    if (value > STOCK.MAX_QUANTITY) {
      errors.push(`จำนวนเกินกำหนด (สูงสุด ${STOCK.MAX_QUANTITY.toLocaleString()})`);
    }
    
    const validOperations = ['add', 'subtract', 'set'];
    if (!validOperations.includes(operation)) {
      errors.push(`operation ไม่ถูกต้อง (ต้องเป็น ${validOperations.join(', ')})`);
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  // ============================================================================
  // INPUT SANITIZATION
  // ============================================================================
  
  static sanitizeInput(text, maxLength = TEXT.MAX_INPUT_LENGTH) {
    if (!text) return '';
    
    return String(text)
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[<>]/g, '')
      .substring(0, maxLength);
  }
  
  static sanitizeNumber(num, defaultValue = 0, min = 0, max = Infinity) {
    const parsed = parseFloat(num);
    if (isNaN(parsed)) return defaultValue;
    return Math.max(min, Math.min(max, parsed));
  }
  
  // ============================================================================
  // SPAM DETECTION
  // ============================================================================
  
  static detectSpam(text) {
    if (!text || typeof text !== 'string') {
      return { isSpam: false };
    }
    
    // Check for excessive repetition
    if (/(.)\1{20,}/.test(text)) {
      return {
        isSpam: true,
        reason: 'Excessive character repetition'
      };
    }
    
    // Check for suspicious patterns
    const spamPatterns = [
      /http[s]?:\/\//i,
      /bit\.ly|tinyurl/i,
      /คลิก|click here/i,
      /ฟรี.*(100%|เงิน|รางวัล)/i,
      /www\./i
    ];
    
    for (const pattern of spamPatterns) {
      if (pattern.test(text)) {
        return {
          isSpam: true,
          reason: 'Suspicious content detected'
        };
      }
    }
    
    return { isSpam: false };
  }
  
  // ============================================================================
  // FORMAT ERROR MESSAGE
  // ============================================================================
  
  static formatValidationError(validation) {
    if (validation.valid) return null;
    
    let msg = '❌ ข้อมูลไม่ถูกต้อง:\n\n';
    
    validation.errors.forEach((error, idx) => {
      msg += `${idx + 1}. ${error}\n`;
    });
    
    if (validation.warnings && validation.warnings.length > 0) {
      msg += `\n⚠️ คำเตือน:\n`;
      validation.warnings.forEach((warning, idx) => {
        msg += `${idx + 1}. ${warning}\n`;
      });
    }
    
    msg += `\n💡 กรุณาตรวจสอบและลองใหม่อีกครั้ง`;
    
    return msg;
  }
}

module.exports = {
  EnhancedValidator
};