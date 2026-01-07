// orderService.js - FIXED: Simplified and working
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { getSheetData, appendSheetData, updateSheetData } = require('./googleServices');
const { loadStockCache } = require('./cacheManager');

const PAYMENT_STATUS_MAP = {
  'paid': 'จ่ายแล้ว',
  'credit': 'เครดิต',
  'unpaid': 'ยังไม่จ่าย'
};

async function updateStock(itemName, unit, newStock) {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
    const key = itemName.toLowerCase().trim();
    const unitKey = unit.toLowerCase().trim();

    for (let i = 1; i < rows.length; i++) {
      const rowName = (rows[i][0] || '').trim().toLowerCase();
      const rowUnit = (rows[i][3] || '').trim().toLowerCase();

      if (rowName === key && rowUnit === unitKey) {
        await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${i + 1}`, [[newStock]]);
        Logger.success(`📦 Stock updated: ${itemName} → ${newStock}`);
        return { success: true, newStock };
      }
    }

    throw new Error(`Item not found: ${itemName} (${unit})`);
  } catch (error) {
    Logger.error('updateStock failed', error);
    throw error;
  }
}

async function createOrderTransaction(orderData) {
  const { customer, items, deliveryPerson = '', paymentStatus = 'unpaid' } = orderData;
  
  try {
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:J');
    const orderNo = orderRows.length || 1;
    
    // For EACH item, create a SEPARATE row
    const rowsToAdd = [];
    
    for (const item of items) {
      const row = [
        orderNo,                           // A - รหัส
        getThaiDateTimeString(),           // B - วันที่
        customer,                          // C - ลูกค้า
        item.stockItem.item,               // D - สินค้า (name only)
        item.quantity,                     // E - จำนวน (number only)
        '',                                // F - หมายเหตุ
        deliveryPerson,                    // G - ผู้ส่ง
        'รอดำเนินการ',                     // H - สถานะ
        paymentStatus === 'paid' ? 'จ่ายแล้ว' : 'ยังไม่จ่าย', // I
        item.quantity * item.stockItem.price  // J - ยอดเงิน (per item)
      ];
      rowsToAdd.push(row);
      
      // Update stock
      await updateStockForItem(item);
    }
    
    // Add all rows at once
    await appendSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:J', rowsToAdd);
    await loadStockCache(true);
    
    const totalAmount = rowsToAdd.reduce((sum, row) => sum + row[9], 0);
    
    return {
      success: true,
      orderNo,
      customer,
      totalAmount,
      items: items.map(i => ({
        productName: i.stockItem.item,
        quantity: i.quantity,
        unitPrice: i.stockItem.price
      }))
    };
  } catch (error) {
    Logger.error('createOrderTransaction failed', error);
    return { success: false, error: error.message };
  }
}

async function updateOrderPaymentStatus(orderNo, newStatus = 'จ่ายแล้ว') {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    let rowIndex = -1;
    let orderData = null;
    
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] == orderNo) {
        rowIndex = i + 1;
        orderData = {
          customer: rows[i][2] || 'ลูกค้า',
          totalAmount: parseFloat(rows[i][6] || 0),
          currentStatus: rows[i][5] || ''
        };
        break;
      }
    }

    if (!orderData) {
      return { success: false, error: `ไม่พบออเดอร์ #${orderNo}` };
    }

    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!F${rowIndex}`, [[newStatus]]);
    Logger.success(`💰 Payment updated: #${orderNo} → ${newStatus}`);

    return {
      success: true,
      orderNo,
      customer: orderData.customer,
      totalAmount: orderData.totalAmount,
      oldStatus: orderData.currentStatus,
      newStatus
    };
  } catch (error) {
    Logger.error('updateOrderPaymentStatus failed', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  createOrderTransaction,
  createOrder: createOrderTransaction,
  updateOrderPaymentStatus,
  updateStock
};
