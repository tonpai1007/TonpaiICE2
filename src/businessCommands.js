// src/businessCommands.js - Advanced business commands handler
const { Logger } = require('./logger');
const { 
  creditManager, 
  inventoryManager, 
  salesAnalytics,
  pricingEngine 
} = require('./businessLogic');




async function handleBusinessCommand(text, userId) {
  const lower = text.toLowerCase().trim();
  
  // Credit management commands
  if (lower.includes('เครดิต') || lower.includes('credit')) {
    try {
      const { creditManager } = require('./businessLogic');
      
      if (lower.includes('รายงาน') || lower === 'เครดิต') {
        const report = await creditManager.generateCreditReport();
        return { success: true, message: report };
      }
      
      if (lower.includes('จ่ายเครดิต')) {
        const customerMatch = text.match(/จ่าย(?:เครดิต)?\s+(.+)/i);
        if (customerMatch) {
          const customerName = customerMatch[1].trim();
          const result = await creditManager.payCredit(customerName);
          
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
    } catch (error) {
      Logger.error('Credit command error', error);
      return null; // Fall through to normal processing
    }
  }

  // Inventory management
  if (lower.includes('รายงานสต็อก') || lower.includes('restock')) {
    try {
      const { inventoryManager } = require('./businessLogic');
      const report = await inventoryManager.generateRestockReport();
      return { success: true, message: report };
    } catch (error) {
      Logger.error('Inventory command error', error);
      return null;
    }
  }

  // Sales analytics
  if (lower.includes('รายงานยอดขาย')) {
    try {
      const { salesAnalytics } = require('./businessLogic');
      const period = lower.includes('สัปดาห์') ? 'week' : 
                     lower.includes('เดือน') ? 'month' : 'today';
      const report = await salesAnalytics.formatSalesReport(period);
      return { success: true, message: report };
    } catch (error) {
      Logger.error('Sales report error', error);
      return null;
    }
  }

  return null; // Not a business command
}

module.exports = {
  handleBusinessCommand
};
