// orderService.js - UPDATED: Match new column structure (9 columns, no status column)

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { getSheetData, appendSheetData, updateSheetData } = require('./googleServices');
const { loadStockCache } = require('./cacheManager');

// ============================================================================
// COLUMN MAPPING (9 columns total)
// ============================================================================

const COL = {
  ORDER_NO: 0,      // A - รหัส
  DATE: 1,          // B - วันที่
  CUSTOMER: 2,      // C - ลูกค้า
  PRODUCT: 3,       // D - สินค้า
  QUANTITY: 4,      // E - จำนวน
  NOTES: 5,         // F - หมายเหตุ
  DELIVERY: 6,      // G - ผู้ส่ง (empty = not delivered, name = delivered)
  PAYMENT: 7,       // H - จ่ายแล้วหรือยัง
  AMOUNT: 8         // I - ยอดเงิน
};

// ============================================================================
// CREATE ORDER - Multiple rows (one per item)
// ============================================================================

async function createOrderTransaction(orderData) {
  const { customer, items, deliveryPerson = '', paymentStatus = 'unpaid' } = orderData;
  
  if (!customer || !items || !Array.isArray(items) || items.length === 0) {
    return {
      success: false,
      error: 'ข้อมูลไม่ครบถ้วน: ต้องมีลูกค้าและรายการสินค้า'
    };
  }

  try {
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    const orderNo = orderRows.length || 1;
    
    // Get stock data
    const stockRows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
    const stockMap = new Map();
    
    for (let i = 1; i < stockRows.length; i++) {
      const name = (stockRows[i][0] || '').toLowerCase().trim();
      const unit = (stockRows[i][3] || '').toLowerCase().trim();
      const stock = parseInt(stockRows[i][4] || 0);
      const key = `${name}|${unit}`;
      stockMap.set(key, { stock, rowIndex: i + 1 });
    }

    // Verify stock availability
    for (const item of items) {
      const key = `${item.stockItem.item.toLowerCase().trim()}|${item.stockItem.unit.toLowerCase().trim()}`;
      const stockInfo = stockMap.get(key);
      
      if (!stockInfo) {
        return {
          success: false,
          error: `❌ ไม่พบสินค้า: ${item.stockItem.item}`
        };
      }
      
      if (stockInfo.stock < item.quantity) {
        return {
          success: false,
          error: `❌ สต็อกไม่พอ: ${item.stockItem.item}\nมี ${stockInfo.stock} ต้องการ ${item.quantity}`
        };
      }
    }

    // Create rows (one per item)
    const rowsToAdd = [];
    const timestamp = getThaiDateTimeString();
    const paymentText = paymentStatus === 'paid' ? 'จ่ายแล้ว' : 'ยังไม่จ่าย';
    
    for (const item of items) {
      const key = `${item.stockItem.item.toLowerCase().trim()}|${item.stockItem.unit.toLowerCase().trim()}`;
      const stockInfo = stockMap.get(key);
      const newStock = stockInfo.stock - item.quantity;
      
      // Update stock
      await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${stockInfo.rowIndex}`, [[newStock]]);
      
      // Create order row (9 columns)
      const row = [
        orderNo,                    // A - รหัส
        timestamp,                  // B - วันที่
        customer,                   // C - ลูกค้า
        item.stockItem.item,        // D - สินค้า
        item.quantity,              // E - จำนวน
        '',                         // F - หมายเหตุ
        deliveryPerson,             // G - ผู้ส่ง (empty by default)
        paymentText,                // H - จ่ายแล้วหรือยัง
        item.quantity * item.stockItem.price  // I - ยอดเงิน
      ];
      
      rowsToAdd.push(row);
      
      Logger.success(`📦 ${item.stockItem.item}: ${stockInfo.stock} → ${newStock}`);
    }

    // Add all rows at once
    await appendSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I', rowsToAdd);
    await loadStockCache(true);

    const totalAmount = rowsToAdd.reduce((sum, row) => sum + row[COL.AMOUNT], 0);
    
    Logger.success(`✅ Order #${orderNo} created: ${customer} - ${totalAmount}฿`);

    return {
      success: true,
      orderNo,
      customer,
      totalAmount,
      items: items.map((item, idx) => ({
        productName: item.stockItem.item,
        quantity: item.quantity,
        unit: item.stockItem.unit,
        unitPrice: item.stockItem.price,
        lineTotal: rowsToAdd[idx][COL.AMOUNT],
        newStock: stockMap.get(`${item.stockItem.item.toLowerCase().trim()}|${item.stockItem.unit.toLowerCase().trim()}`).stock - item.quantity,
        stockItem: item.stockItem
      }))
    };

  } catch (error) {
    Logger.error('createOrderTransaction failed', error);
    return {
      success: false,
      error: `❌ ไม่สามารถสร้างออเดอร์ได้: ${error.message}`
    };
  }
}

// ============================================================================
// UPDATE PAYMENT STATUS
// ============================================================================

async function updateOrderPaymentStatus(orderNo, newStatus = 'จ่ายแล้ว') {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    const orderRows = [];
    let totalAmount = 0;
    let customer = '';
    
    // Find all rows with this order number
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][COL.ORDER_NO] == orderNo) {
        orderRows.push({ index: i + 1, data: rows[i] });
        totalAmount += parseFloat(rows[i][COL.AMOUNT] || 0);
        customer = rows[i][COL.CUSTOMER];
      }
    }

    if (orderRows.length === 0) {
      return { success: false, error: `ไม่พบออเดอร์ #${orderNo}` };
    }

    // Update all rows (Column H - Payment)
    for (const orderRow of orderRows) {
      await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!H${orderRow.index}`, [[newStatus]]);
    }
    
    Logger.success(`💰 Payment updated: #${orderNo} → ${newStatus}`);

    return {
      success: true,
      orderNo,
      customer,
      totalAmount,
      newStatus
    };
  } catch (error) {
    Logger.error('updateOrderPaymentStatus failed', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// GET LAST ORDER NUMBER
// ============================================================================

async function getLastOrderNumber() {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    if (rows.length <= 1) return null;
    
    // Get the most recent order number (last row)
    const lastRow = rows[rows.length - 1];
    return lastRow[COL.ORDER_NO];
  } catch (error) {
    Logger.error('getLastOrderNumber failed', error);
    return null;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  createOrderTransaction,
  createOrder: createOrderTransaction,
  updateOrderPaymentStatus,
  getLastOrderNumber,
  COL // Export column mapping
};
