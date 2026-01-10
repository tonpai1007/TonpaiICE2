// inboxService.js - BETTER: Track user speech and show clear results

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { appendSheetData, getSheetData, updateSheetData } = require('./googleServices');
const { loadStockCache } = require('./cacheManager');

// ============================================================================
// INBOX STRUCTURE: Track what user said and what happened
// Columns: วันที่/เวลา | คำพูด/ข้อความ | ผลลัพธ์ | ประเภท
// ============================================================================

async function saveToInbox(userId, userInput, result, type = 'text') {
  try {
    const timestamp = getThaiDateTimeString();
    let userMessage = userInput;
    let systemResult = result;
    let category = type;
    
    // Clean and format
    if (typeof result === 'object' && result.message) {
      systemResult = result.message.substring(0, 200); // Limit length
    }
    
    const row = [
      timestamp,           // A - วันที่/เวลา
      userMessage,         // B - คำพูด/ข้อความ
      systemResult,        // C - ผลลัพธ์
      category            // D - ประเภท
    ];

    await appendSheetData(CONFIG.SHEET_ID, 'Inbox!A:D', [row]);
    Logger.success(`📥 Saved to Inbox: ${category}`);
    return true;
  } catch (error) {
    Logger.error('saveToInbox failed', error);
    return false;
  }
}

// ============================================================================
// CANCEL ORDER - With better tracking
// ============================================================================

async function cancelOrder(orderNo) {
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

    // Save to inbox
    await saveToInbox(
      'system', 
      `ยกเลิก #${orderNo}`,
      `ยกเลิกออเดอร์ #${orderNo} (${customer}) สำเร็จ - คืนสต็อก ${stockRestored.length} รายการ`,
      'cancel'
    );

    Logger.success(`✅ Cancelled order #${orderNo}`);

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
// GENERATE INBOX SUMMARY - Human readable
// ============================================================================

async function generateInboxSummary(limit = 30) {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'Inbox!A:D');
    
    if (rows.length <= 1) {
      return '📝 Inbox ว่างเปล่า\n\n' +
             '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
             '💡 ยังไม่มีกิจกรรมในระบบ\n' +
             'ประวัติคำสั่งจะแสดงที่นี่';
    }

    const messages = rows.slice(1)
      .slice(-limit)
      .reverse();

    let msg = `📝 ประวัติการใช้งาน\n`;
    msg += `${'='.repeat(40)}\n`;
    msg += `แสดง ${messages.length} รายการล่าสุด\n\n`;

    messages.forEach((row, idx) => {
      const timestamp = row[0] || '';
      const userInput = row[1] || '';
      const result = row[2] || '';
      const type = row[3] || '';
      
      // Extract time only
      const time = timestamp.split(' ')[1]?.substring(0, 5) || timestamp;
      
      // Get icon based on type and result
      let icon = '📝';
      if (type === 'order' || result.includes('บันทึกออเดอร์สำเร็จ')) {
        icon = '✅';
      } else if (type === 'cancel' || result.includes('ยกเลิก')) {
        icon = '❌';
      } else if (type === 'stock' || userInput.includes('เติม') || userInput.includes('มี')) {
        icon = '📦';
      } else if (type === 'payment' || userInput.includes('จ่าย')) {
        icon = '💰';
      } else if (type === 'delivery' || userInput.includes('ส่ง')) {
        icon = '🚚';
      } else if (result.includes('ไม่') || result.includes('❌')) {
        icon = '⚠️';
      }
      
      msg += `${icon} [${time}]\n`;
      msg += `   พูด: "${userInput}"\n`;
      
      // Show result (truncated)
      const resultShort = result.length > 60 
        ? result.substring(0, 60) + '...' 
        : result;
      msg += `   → ${resultShort}\n\n`;
    });

    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 ทั้งหมด ${rows.length - 1} รายการในระบบ`;

    return msg;

  } catch (error) {
    Logger.error('generateInboxSummary failed', error);
    return `❌ ไม่สามารถดู Inbox ได้: ${error.message}`;
  }
}

// ============================================================================
// INITIALIZE INBOX SHEET (if needed)
// ============================================================================

async function initializeInboxSheet() {
  try {
    const { getSheetsList, createSheet } = require('./googleServices');
    const sheets = await getSheetsList(CONFIG.SHEET_ID);
    
    if (!sheets.includes('Inbox')) {
      await createSheet(CONFIG.SHEET_ID, 'Inbox');
      await appendSheetData(CONFIG.SHEET_ID, 'Inbox!A1:D1', [[
        'วันที่/เวลา',
        'คำพูด/ข้อความ',
        'ผลลัพธ์',
        'ประเภท'
      ]]);
      Logger.success('✅ Created Inbox sheet with new structure');
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
