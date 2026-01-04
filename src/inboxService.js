// inboxService.js - Inbox & Cancel Logic
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { appendSheetData, getSheetData, updateSheetData, batchUpdateSheet } = require('./googleServices');
const { updateStock } = require('./orderService');

// ============================================================================
// INBOX: บันทึกทุก Input ที่เข้ามา
// ============================================================================

async function saveToInbox(userId, text, type = 'voice', metadata = {}) {
  try {
    const row = [
      getThaiDateTimeString(),
      userId.substring(0, 15),
      type,
      text,
      JSON.stringify(metadata),
      'pending',
      ''
    ];

    await appendSheetData(CONFIG.SHEET_ID, 'Inbox!A:G', [row]);
    Logger.success(`📥 Saved to Inbox: ${text.substring(0, 30)}...`);
    return true;
  } catch (error) {
    Logger.error('saveToInbox failed', error);
    return false;
  }
}

// ============================================================================
// CANCEL: ยกเลิกออเดอร์ + คืนสต็อก
// ============================================================================

async function cancelOrder(orderNo) {
  try {
    Logger.info(`🔄 Cancelling order #${orderNo}...`);

    // 1. Get order details
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:H');
    let orderIndex = -1;
    let orderData = null;

    for (let i = 1; i < orderRows.length; i++) {
      if (orderRows[i][0] == orderNo) {
        orderIndex = i + 1;
        orderData = {
          orderNo: orderRows[i][0],
          customer: orderRows[i][2],
          paymentStatus: orderRows[i][5]
        };
        break;
      }
    }

    if (!orderData) {
      return { success: false, error: `ไม่พบออเดอร์ #${orderNo}` };
    }

    // 2. Get line items
    const lineRows = await getSheetData(CONFIG.SHEET_ID, 'รายละเอียดคำสั่งซื้อ!A:G');
    const lineItems = lineRows.slice(1).filter(row => row[0] == orderNo);

    if (lineItems.length === 0) {
      return { success: false, error: 'ไม่พบรายการสินค้า' };
    }

    // 3. Restore stock
    const stockRestored = [];
    for (const line of lineItems) {
      const productName = line[1];
      const quantity = parseInt(line[2] || 0);
      const unit = line[3];

      // Get current stock
      const stockRows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
      for (let i = 1; i < stockRows.length; i++) {
        const stockName = (stockRows[i][0] || '').trim().toLowerCase();
        const stockUnit = (stockRows[i][3] || '').trim().toLowerCase();
        
        if (stockName === productName.toLowerCase() && stockUnit === unit.toLowerCase()) {
          const currentStock = parseInt(stockRows[i][4] || 0);
          const newStock = currentStock + quantity;
          
          await updateStock(productName, unit, newStock);
          stockRestored.push({ item: productName, restored: quantity, newStock });
          Logger.success(`✅ Restored: ${productName} +${quantity} → ${newStock}`);
          break;
        }
      }
    }

    // 4. Update order status
    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!E${orderIndex}`, [['ยกเลิก']]);
    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!H${orderIndex}`, [['[ยกเลิกโดยระบบ]']]);

    Logger.success(`✅ Cancelled order #${orderNo}`);

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
// INBOX STATUS UPDATE
// ============================================================================

async function updateInboxStatus(timestamp, userId, newStatus) {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'Inbox!A:G');
    
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === timestamp && rows[i][1].includes(userId.substring(0, 10))) {
        await updateSheetData(CONFIG.SHEET_ID, `Inbox!F${i + 1}`, [[newStatus]]);
        Logger.success(`✅ Inbox status updated: ${newStatus}`);
        return true;
      }
    }
    
    return false;
  } catch (error) {
    Logger.error('updateInboxStatus failed', error);
    return false;
  }
}

module.exports = {
  saveToInbox,
  cancelOrder,
  updateInboxStatus
};