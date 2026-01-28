// inboxService.js - SIMPLIFIED: Only timestamp + raw transcript (2 columns)

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { appendSheetData, getSheetData, updateSheetData } = require('./googleServices');
const { loadStockCache } = require('./cacheManager');

// ============================================================================
// INBOX STRUCTURE: Only 2 columns - วันที่/เวลา | ข้อความดิบ
// ============================================================================

async function saveToInbox(userId, userInput) {
  try {
    const timestamp = getThaiDateTimeString();
    
    const row = [
      timestamp,           // A - วันที่/เวลา
      userInput           // B - ข้อความดิบจากผู้ใช้
    ];

    await appendSheetData(CONFIG.SHEET_ID, 'Inbox!A:B', [row]);
    Logger.success(`📥 Saved to Inbox: "${userInput.substring(0, 50)}..."`);
    return true;
  } catch (error) {
    Logger.error('saveToInbox failed', error);
    return false;
  }
}

// ============================================================================
// CANCEL ORDER - With stock restoration
// ============================================================================

async function cancelOrder(orderNo) {
 const lockKeys = [];
  try {
    Logger.info(`🔄 Cancelling order #${orderNo}...`);

    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    const orderItems = [];
    let customer = '';

    for (let i = 1; i < orderRows.length; i++) {
      if (orderRows[i][0] == orderNo) {
        customer = orderRows[i][2];
        orderItems.push({
          rowIndex: i + 1,
          product: orderRows[i][3],
          quantity: parseInt(orderRows[i][4] || 0)
        });
      }
    }

    if (orderItems.length === 0) {
      return { success: false, error: `ไม่พบออเดอร์ #${orderNo}` };
    }

    // Restore stock
    const stockRestored = [];
    const stockRows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');

    for (const orderItem of orderItems) {
      const productName = orderItem.product.toLowerCase().trim();

      for (let i = 1; i < stockRows.length; i++) {
        const stockName = (stockRows[i][0] || '').toLowerCase().trim();
        
        if (stockName === productName) {
          const currentStock = parseInt(stockRows[i][4] || 0);
          const newStock = currentStock + orderItem.quantity;
          const unit = stockRows[i][3] || 'ชิ้น';
          
          await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${i + 1}`, [[newStock]]);
          
          stockRestored.push({ 
            item: orderItem.product, 
            restored: orderItem.quantity, 
            newStock,
            unit
          });
          
          Logger.success(`✅ Restored: ${orderItem.product} +${orderItem.quantity} → ${newStock}`);
          break;
        }
      }
      
    }

    // Mark as cancelled
    for (const orderItem of orderItems) {
      await updateSheetData(
        CONFIG.SHEET_ID, 
        `คำสั่งซื้อ!F${orderItem.rowIndex}`, 
        [['[ยกเลิกแล้ว]']]
      );
    }

    await loadStockCache(true);

    Logger.success(`✅ Cancelled order #${orderNo}`);

    return {
      success: true,
      orderNo,
      customer,
      stockRestored
    };

    } finally {
      // ✅ Always release locks
      lockKeys.forEach(key => stockLock.releaseLock(key));
      Logger.error('cancelOrder failed', error);
      return { success: false, error: error.message };
    }
  
}




// ============================================================================
// GENERATE INBOX SUMMARY - Simple transcript view
// ============================================================================

async function generateInboxSummary(limit = 30) {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'Inbox!A:B');
    
    if (rows.length <= 1) {
      return '📝 Inbox ว่างเปล่า\n\n' +
             '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
             '💡 ยังไม่มีกิจกรรมในระบบ\n' +
             'บันทึกการสนทนาจะแสดงที่นี่';
    }

    const messages = rows.slice(1)
      .slice(-limit)
      .reverse();

    let msg = `📝 บันทึกการสนทนา\n`;
    msg += `${'='.repeat(40)}\n`;
    msg += `แสดง ${messages.length} รายการล่าสุด\n\n`;

    messages.forEach((row, idx) => {
      const timestamp = row[0] || '';
      const userInput = row[1] || '';
      
      // Extract time only
      const time = timestamp.split(' ')[1]?.substring(0, 5) || timestamp.substring(11, 16);
      const date = timestamp.split(' ')[0] || '';
      
      msg += `[${time}] ${userInput}\n`;
      
      // Add separator every 5 messages for readability
      if ((idx + 1) % 5 === 0 && idx < messages.length - 1) {
        msg += `\n`;
      }
    });

    msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 ทั้งหมด ${rows.length - 1} รายการในระบบ`;

    return msg;

  } catch (error) {
    Logger.error('generateInboxSummary failed', error);
    return `❌ ไม่สามารถดู Inbox ได้: ${error.message}`;
  }
}

// ============================================================================
// INITIALIZE INBOX SHEET (2 columns only)
// ============================================================================

async function initializeInboxSheet() {
  try {
    const { getSheetsList, createSheet } = require('./googleServices');
    const sheets = await getSheetsList(CONFIG.SHEET_ID);
    
    if (!sheets.includes('Inbox')) {
      await createSheet(CONFIG.SHEET_ID, 'Inbox');
      await appendSheetData(CONFIG.SHEET_ID, 'Inbox!A1:B1', [[
        'วันที่/เวลา',
        'ข้อความ'
      ]]);
      Logger.success('✅ Created Inbox sheet (2 columns: timestamp + message)');
    }
  } catch (error) {
    Logger.warn('Inbox sheet init warning', error);
  }
}

module.exports = {
  saveToInbox,
  cancelOrder,
  generateInboxSummary,
  initializeInboxSheet
};
