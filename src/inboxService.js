// inboxService.js - FIXED: Proper inbox structure and cancel order
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { appendSheetData, getSheetData, updateSheetData } = require('./googleServices');
const { loadStockCache } = require('./cacheManager');

// ============================================================================
// INBOX: Simple 2-column format (วันที่/เวลา, ข้อความ)
// ============================================================================

async function saveToInbox(userId, text, type = 'text', metadata = {}) {
  try {
    // Simple format: [timestamp] [type] text
    let displayText = text;
    
    // Add type prefix if needed
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
// CANCEL ORDER: Fixed to read JSON line items correctly
// ============================================================================

async function cancelOrder(orderNo) {
  try {
    Logger.info(`🔄 Cancelling order #${orderNo}...`);

    // Get order data
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    let orderIndex = -1;
    let orderData = null;

    for (let i = 1; i < orderRows.length; i++) {
      if (orderRows[i][0] == orderNo) {
        orderIndex = i + 1;
        orderData = {
          orderNo: orderRows[i][0],
          customer: orderRows[i][2] || 'ลูกค้า',
          lineItemsJson: orderRows[i][7] || '[]'  // Column H contains JSON
        };
        break;
      }
    }

    if (!orderData) {
      return { success: false, error: `ไม่พบออเดอร์ #${orderNo}` };
    }

    // Parse line items
    let lineItems = [];
    try {
      lineItems = JSON.parse(orderData.lineItemsJson);
    } catch (parseError) {
      Logger.error('Failed to parse line items', parseError);
      return { success: false, error: 'ข้อมูลออเดอร์ไม่ถูกต้อง' };
    }

    if (lineItems.length === 0) {
      return { success: false, error: 'ไม่พบรายการสินค้าในออเดอร์' };
    }

    // Restore stock for each item
    const stockRestored = [];
    const stockRows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');

    for (const line of lineItems) {
      const productName = (line.item || '').toLowerCase().trim();
      const quantity = parseInt(line.quantity || 0);
      const unit = (line.unit || '').toLowerCase().trim();

      for (let i = 1; i < stockRows.length; i++) {
        const stockName = (stockRows[i][0] || '').toLowerCase().trim();
        const stockUnit = (stockRows[i][3] || '').toLowerCase().trim();
        
        if (stockName === productName && stockUnit === unit) {
          const currentStock = parseInt(stockRows[i][4] || 0);
          const newStock = currentStock + quantity;
          
          // Update stock
          await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${i + 1}`, [[newStock]]);
          
          stockRestored.push({ 
            item: line.item, 
            restored: quantity, 
            newStock 
          });
          
          Logger.success(`✅ Restored: ${line.item} +${quantity} → ${newStock}`);
          break;
        }
      }
    }

    // Mark order as cancelled
    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!E${orderIndex}`, [['ยกเลิก']]);
    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!I${orderIndex}`, [['[ยกเลิกโดยระบบ]']]);

    // Reload cache
    await loadStockCache(true);

    Logger.success(`✅ Cancelled order #${orderNo}, restored ${stockRestored.length} items`);

    return {
      success: true,
      orderNo,
      customer: orderData.customer,
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
