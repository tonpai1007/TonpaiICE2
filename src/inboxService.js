// inboxService.js - UPDATED: Match new 9-column structure

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { appendSheetData, getSheetData, updateSheetData } = require('./googleServices');
const { loadStockCache } = require('./cacheManager');

// Column mapping
const COL = {
  ORDER_NO: 0,      // A
  DATE: 1,          // B
  CUSTOMER: 2,      // C
  PRODUCT: 3,       // D
  QUANTITY: 4,      // E
  NOTES: 5,         // F
  DELIVERY: 6,      // G
  PAYMENT: 7,       // H
  AMOUNT: 8         // I
};

// ============================================================================
// INBOX: Simple 2-column format (วันที่/เวลา, ข้อความ)
// ============================================================================

async function saveToInbox(userId, text, type = 'text', metadata = {}) {
  try {
    let displayText = text;
    
    if (type === 'voice_raw') {
      displayText = `🎤 [Voice Input]`;
    } else if (type === 'voice_transcribed') {
      displayText = `🎤 "${text}"`;
    } else if (type === 'order_auto_success') {
      displayText = `✅ Order #${metadata.orderNo}: ${text}`;
    } else if (type === 'insufficient_stock') {
      displayText = `⚠️ Insufficient stock: ${text}`;
    } else if (type === 'parse_failed') {
      displayText = `❌ Parse failed: ${text}`;
    }

    const row = [
      getThaiDateTimeString(),
      displayText
    ];

    await appendSheetData(CONFIG.SHEET_ID, 'Inbox!A:B', [row]);
    Logger.success(`📥 Saved to Inbox`);
    return true;
  } catch (error) {
    Logger.error('saveToInbox failed', error);
    return false;
  }
}

// ============================================================================
// CANCEL ORDER: UPDATED for 9-column structure
// ============================================================================

async function cancelOrder(orderNo) {
  try {
    Logger.info(`🔄 Cancelling order #${orderNo}...`);

    // Get order data
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    const orderItems = [];
    let customer = '';

    // Collect all items from this order
    for (let i = 1; i < orderRows.length; i++) {
      if (orderRows[i][COL.ORDER_NO] == orderNo) {
        customer = orderRows[i][COL.CUSTOMER];
        orderItems.push({
          rowIndex: i + 1,
          product: orderRows[i][COL.PRODUCT],
          quantity: parseInt(orderRows[i][COL.QUANTITY] || 0)
        });
      }
    }

    if (orderItems.length === 0) {
      return { success: false, error: `ไม่พบออเดอร์ #${orderNo}` };
    }

    // Restore stock for each item
    const stockRestored = [];
    const stockRows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');

    for (const orderItem of orderItems) {
      const productName = orderItem.product.toLowerCase().trim();

      for (let i = 1; i < stockRows.length; i++) {
        const stockName = (stockRows[i][0] || '').toLowerCase().trim();
        
        if (stockName === productName) {
          const currentStock = parseInt(stockRows[i][4] || 0);
          const newStock = currentStock + orderItem.quantity;
          
          // Update stock
          await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${i + 1}`, [[newStock]]);
          
          stockRestored.push({ 
            item: orderItem.product, 
            restored: orderItem.quantity, 
            newStock 
          });
          
          Logger.success(`✅ Restored: ${orderItem.product} +${orderItem.quantity} → ${newStock}`);
          break;
        }
      }
    }

    // Mark order as cancelled by updating notes (Column F)
    for (const orderItem of orderItems) {
      await updateSheetData(
        CONFIG.SHEET_ID, 
        `คำสั่งซื้อ!F${orderItem.rowIndex}`, 
        [['[ยกเลิก]']]
      );
    }

    // Reload cache
    await loadStockCache(true);

    Logger.success(`✅ Cancelled order #${orderNo}, restored ${stockRestored.length} items`);

    return {
      success: true,
      orderNo,
      customer,
      stockRestored
    };

  } catch (error) {
    Logger.error('cancelOrder failed', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// GENERATE INBOX SUMMARY
// ============================================================================

async function generateInboxSummary(limit = 15) {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'Inbox!A:B');
    
    if (rows.length <= 1) {
      return '📝 Inbox ว่างเปล่า\n\nยังไม่มีข้อความในระบบ';
    }

    const messages = rows.slice(1)
      .slice(-limit)
      .reverse();

    let msg = `📝 Inbox (${messages.length} ข้อความล่าสุด)\n${'='.repeat(40)}\n\n`;
    
    messages.forEach((row, idx) => {
      const timestamp = row[0] || '';
      const text = row[1] || '';
      
      const time = timestamp.split(' ')[1] || timestamp;
      
      msg += `${idx + 1}. [${time}] ${text.substring(0, 60)}\n`;
      if (text.length > 60) msg += `   ...\n`;
      msg += `\n`;
    });

    return msg;

  } catch (error) {
    Logger.error('generateInboxSummary failed', error);
    return `❌ ไม่สามารถดู Inbox ได้: ${error.message}`;
  }
}

module.exports = {
  saveToInbox,
  cancelOrder,
  generateInboxSummary
};
