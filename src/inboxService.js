// inboxService.js - FIXED: Cancel reads JSON line items
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { appendSheetData, getSheetData, updateSheetData } = require('./googleServices');
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
// CANCEL: ยกเลิกออเดอร์ + คืนสต็อก (FIXED: Read JSON)
// ============================================================================

async function cancelOrder(orderNo) {
  try {
    Logger.info(`🔄 Cancelling order #${orderNo}...`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // PHASE 1: Get order with embedded line items
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    let orderIndex = -1;
    let orderData = null;

    for (let i = 1; i < orderRows.length; i++) {
      if (orderRows[i][0] == orderNo) {
        orderIndex = i + 1;
        orderData = {
          orderNo: orderRows[i][0],
          customer: orderRows[i][2],
          paymentStatus: orderRows[i][5],
          lineItemsJson: orderRows[i][7] || '[]'  // Column H
        };
        break;
      }
    }

    if (!orderData) {
      return { success: false, error: `ไม่พบออเดอร์ #${orderNo}` };
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // PHASE 2: Parse line items from JSON
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    let lineItems = [];
    try {
      lineItems = JSON.parse(orderData.lineItemsJson);
    } catch (parseError) {
      Logger.error('Failed to parse line items JSON', parseError);
      return { success: false, error: 'Invalid order data format' };
    }

    if (lineItems.length === 0) {
      return { success: false, error: 'ไม่พบรายการสินค้า' };
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // PHASE 3: Restore stock
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const stockRestored = [];
    
    for (const line of lineItems) {
      const productName = line.item;
      const quantity = parseInt(line.quantity || 0);
      const unit = line.unit;

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

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // PHASE 4: Mark order as cancelled
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!E${orderIndex}`, [['ยกเลิก']]);
    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!I${orderIndex}`, [['[ยกเลิกโดยระบบ]']]);

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