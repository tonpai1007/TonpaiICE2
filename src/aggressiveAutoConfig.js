// aggressiveAutoConfig.js - Configuration for maximum automation

const AUTOMATION_MODES = {
  // 🔴 CONSERVATIVE (ปลอดภัยสุด, Auto น้อย)
  CONSERVATIVE: {
    name: 'Conservative',
    autoOnConfidence: ['high'],           // Auto เฉพาะ high
    requireCustomerInDB: true,            // ต้องมีลูกค้าในระบบ
    requireExactMatch: true,              // ต้องตรงทุกอย่าง
    maxAutoAmount: 5000,                  // Auto ได้สูงสุด 5,000฿
    description: 'ปลอดภัยที่สุด แต่ต้องเช็คเยอะ'
  },

  // 🟡 BALANCED (สมดุล - แนะนำ)
  BALANCED: {
    name: 'Balanced',
    autoOnConfidence: ['high', 'medium'], // Auto ทั้ง high และ medium
    requireCustomerInDB: false,           // ไม่ต้องมีลูกค้าในระบบ
    requireExactMatch: false,             // Fuzzy match OK
    maxAutoAmount: 10000,                 // Auto ได้สูงสุด 10,000฿
    allowNewCustomer: true,               // รับลูกค้าใหม่อัตโนมัติ
    description: 'สมดุลระหว่างความเร็วและความแม่นยำ'
  },

  // 🟢 AGGRESSIVE (Auto สูงสุด - สำหรับร้านที่ไว้ใจระบบ)
  AGGRESSIVE: {
    name: 'Aggressive',
    autoOnConfidence: ['high', 'medium', 'low'], // Auto ทุก level!
    requireCustomerInDB: false,
    requireExactMatch: false,
    maxAutoAmount: 50000,                 // Auto ได้สูงสุด 50,000฿
    allowNewCustomer: true,
    autoCreateCustomer: true,             // สร้างลูกค้าใหม่อัตโนมัติ
    smartCorrection: true,                // ใช้ AI แก้ไขข้อผิดพลาดเล็กน้อย
    description: 'Auto สูงสุด - ใช้เมื่อมั่นใจระบบ'
  }
};

// ✅ Default: BALANCED MODE
const CURRENT_MODE = AUTOMATION_MODES.BALANCED;

// ============================================================================
// DECISION ENGINE
// ============================================================================

function shouldAutoProcess(parsed, orderValue) {
  const mode = CURRENT_MODE;

  // Rule 1: Check confidence level
  if (!mode.autoOnConfidence.includes(parsed.confidence)) {
    return {
      shouldAuto: false,
      reason: `Confidence ${parsed.confidence} not in auto list`
    };
  }

  // Rule 2: Check order amount
  if (orderValue > mode.maxAutoAmount) {
    return {
      shouldAuto: false,
      reason: `Amount ${orderValue}฿ exceeds max ${mode.maxAutoAmount}฿`
    };
  }

  // Rule 3: Check customer requirement
  if (mode.requireCustomerInDB && parsed.customer === 'ไม่ระบุ') {
    return {
      shouldAuto: false,
      reason: 'Customer not in database'
    };
  }

  // Rule 4: Check match type
  if (mode.requireExactMatch) {
    const hasNonExactMatch = parsed.items.some(
      item => item.matchConfidence !== 'exact'
    );
    if (hasNonExactMatch) {
      return {
        shouldAuto: false,
        reason: 'Non-exact match found'
      };
    }
  }

  // Rule 5: Check stock availability
  const insufficientStock = parsed.items.some(
    item => item.quantity > item.stockItem.stock
  );
  if (insufficientStock) {
    return {
      shouldAuto: false,
      reason: 'Insufficient stock'
    };
  }

  // ✅ All checks passed
  return {
    shouldAuto: true,
    reason: `Auto-approved: ${mode.name} mode`
  };
}

// ============================================================================
// SMART CORRECTION (สำหรับ AGGRESSIVE MODE)
// ============================================================================

function applySmartCorrection(parsed) {
  /*
  แก้ไขข้อผิดพลาดเล็กน้อยอัตโนมัติ เช่น:
  - "สมชาย" → "คุณสมชาย" (เติม prefix)
  - Quantity 0 → 1 (default)
  - เครดิต/เก็บเงิน → แปลงเป็น status
  */

  if (!CURRENT_MODE.smartCorrection) return parsed;

  // Fix 1: Add prefix to customer name if missing
  if (parsed.customer && !parsed.customer.startsWith('คุณ') && 
      !parsed.customer.startsWith('พี่') && parsed.customer !== 'ไม่ระบุ') {
    parsed.customer = 'คุณ' + parsed.customer;
  }

  // Fix 2: Default quantity to 1 if 0
  parsed.items = parsed.items.map(item => {
    if (item.quantity === 0) {
      item.quantity = 1;
      item.corrected = true;
    }
    return item;
  });

  // Fix 3: Payment status keywords
  const lowerInput = parsed.rawInput?.toLowerCase() || '';
  if (lowerInput.includes('เครดิต') || lowerInput.includes('ค้าง')) {
    parsed.paymentStatus = 'credit';
  }

  return parsed;
}

// ============================================================================
// MONITORING & ANALYTICS
// ============================================================================

class AutomationMonitor {
  constructor() {
    this.stats = {
      total: 0,
      autoProcessed: 0,
      manualReview: 0,
      errors: 0,
      autoAccuracy: 100 // % ความแม่นยำของ auto (คำนวณจากการยกเลิก)
    };
  }

  recordDecision(decision, orderNo) {
    this.stats.total++;
    
    if (decision.shouldAuto) {
      this.stats.autoProcessed++;
      console.log(`✅ Auto #${orderNo}: ${decision.reason}`);
    } else {
      this.stats.manualReview++;
      console.log(`📋 Manual #${orderNo}: ${decision.reason}`);
    }
  }

  recordCancellation(orderNo, wasAuto) {
    if (wasAuto) {
      this.stats.errors++;
      this.stats.autoAccuracy = 
        ((this.stats.autoProcessed - this.stats.errors) / this.stats.autoProcessed) * 100;
      console.log(`⚠️ Auto error on #${orderNo}. New accuracy: ${this.stats.autoAccuracy.toFixed(1)}%`);
    }
  }

  getReport() {
    const autoRate = (this.stats.autoProcessed / this.stats.total * 100).toFixed(1);
    
    return `📊 Automation Report
${'='.repeat(40)}

Mode: ${CURRENT_MODE.name}

Total Orders: ${this.stats.total}
Auto-processed: ${this.stats.autoProcessed} (${autoRate}%)
Manual Review: ${this.stats.manualReview}
Errors: ${this.stats.errors}
Accuracy: ${this.stats.autoAccuracy.toFixed(1)}%

💡 ${this.getRecommendation()}
`;
  }

  getRecommendation() {
    if (this.stats.autoAccuracy >= 95) {
      return 'ระบบทำงานดีมาก! พิจารณาเปลี่ยนเป็น AGGRESSIVE mode';
    } else if (this.stats.autoAccuracy >= 85) {
      return 'ระบบทำงานดี BALANCED mode เหมาะสม';
    } else {
      return '⚠️ Auto ผิดพลาดบ่อย พิจารณาเปลี่ยนเป็น CONSERVATIVE mode';
    }
  }
}

// Singleton instance
const monitor = new AutomationMonitor();

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  AUTOMATION_MODES,
  CURRENT_MODE,
  shouldAutoProcess,
  applySmartCorrection,
  monitor
};