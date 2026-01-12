// src/businessCommands.js - Advanced business commands handler
const { Logger } = require('./logger');
const { 
  creditManager, 
  inventoryManager, 
  salesAnalytics,
  pricingEngine 
} = require('./businessLogic');

/**
 * Handle business-specific commands (credit, inventory, pricing, analytics)
 * Returns null if not a business command (to continue processing)
 * Returns result object if command was handled
 */
async function handleBusinessCommand(text, userId) {
  const lower = text.toLowerCase().trim();

  // ========================================
  // CREDIT MANAGEMENT
  // ========================================
  
  // View credit report
  if (lower.includes('เครดิต') || lower.includes('ค้างชำระ')) {
    const customerMatch = text.match(/เครดิต\s+(.+)/i);
    const customerName = customerMatch ? customerMatch[1].trim() : null;
    
    const report = await require('./businessLogic').creditManager.generateCreditReport(customerName);
    return { success: true, message: report };
  }

  // Pay credit
  const payMatch = text.match(/ชำระเครดิต\s+(.+?)(?:\s+(\d+))?$/i);
  if (paymentMatch) {
    const customerName = paymentMatch[1];
    const amount = paymentMatch[2] ? parseFloat(paymentMatch[2]) : null;
    
    const result = await creditManager.payCredit(customerName, amount);
    
    if (result.success) {
      let msg = `✅ ชำระเครดิตสำเร็จ\n\n`;
      msg += `👤 ${result.customer}\n`;
      msg += `💰 ชำระ: ${result.totalPaid.toLocaleString()}฿\n\n`;
      msg += `📋 ออเดอร์ที่ชำระ:\n`;
      result.paidItems.forEach(item => {
        msg += `  • #${item.orderNo}: ${item.amount.toLocaleString()}฿`;
        if (item.partial) msg += ` (บางส่วน)`;
        msg += '\n';
      });
      
      await saveToInbox(userId, text, msg, 'credit_payment');
      return { success: true, message: msg };
    } else {
      return { success: false, message: result.error };
    }
  }

  // ========================================
  // ORDER PROCESSING (Last resort)
  // ========================================
  
  // ... rest of existing code
}
```

**Create `src/businessCommands.js`:**

```javascript
// src/businessCommands.js - Advanced business logic commands
const { Logger } = require('./logger');
const { 
  inventoryManager, 
  creditManager, 
  salesAnalytics 
} = require('./businessLogic');

/**
 * Handle advanced business commands
 * Returns null if not a business command (so normal flow continues)
 */
async function handleBusinessCommand(text, userId) {
  const lower = text.toLowerCase().trim();
  
  // Credit management commands
  if (lower.includes('เครดิต') || lower.includes('credit')) {
    if (lower.includes('รายงาน') || lower === 'เครดิต') {
      const report = await require('./businessLogic').creditManager.generateCreditReport();
      return { success: true, message: report };
    }
    
    if (lower.includes('จ่ายเครดิต')) {
      const customerMatch = text.match(/จ่าย(?:เครดิต)?\s+(.+)/i);
      if (customerMatch) {
        const customerName = customerMatch[1].trim();
        const result = await require('./businessLogic').creditManager.payCredit(customerName);
        
        if (result.success) {
          return {
            success: true,
            message: `✅ ชำระเครดิตสำเร็จ\n\n👤 ${result.customer}\n💰 ${result.totalPaid.toLocaleString()}฿\n\n${result.paidItems.length} รายการ`
          };
        } else {
          return { success: false, message: result.error };
        }
      }
    }

    // Business commands...
    if (lower.includes('เครดิต')) {
      const { creditManager } = require('./businessLogic');
      const report = await creditManager.generateCreditReport();
      return { success: true, message: report };
    }

    if (lower.includes('รายงานสต็อก') || lower.includes('restock')) {
      const { inventoryManager } = require('./businessLogic');
      const report = await inventoryManager.generateRestockReport();
      return { success: true, message: report };
    }

    return null; // Not a business command
  }
}

module.exports = {
  handleBusinessCommand
};
