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
  
  if (!customer || !items || !Array.isArray(items) || items.length === 0) {
    return {
      success: false,
      error: 'ข้อมูลไม่ครบถ้วน: ต้องมีลูกค้าและรายการสินค้า'
    };
  }

  try {
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    const orderNo = orderRows.length || 1;
    
    const stockRows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
    const stockMap = new Map();
    
    for (let i = 1; i < stockRows.length; i++) {
      const name = (stockRows[i][0] || '').toLowerCase().trim();
      const unit = (stockRows[i][3] || '').toLowerCase().trim();
      const stock = parseInt(stockRows[i][4] || 0);
      const key = `${name}|${unit}`;
      stockMap.set(key, { stock, rowIndex: i + 1 });
    }

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

    const lineItems = [];
    const stockUpdates = [];

    for (const item of items) {
      const key = `${item.stockItem.item.toLowerCase().trim()}|${item.stockItem.unit.toLowerCase().trim()}`;
      const stockInfo = stockMap.get(key);
      const newStock = stockInfo.stock - item.quantity;
      
      await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${stockInfo.rowIndex}`, [[newStock]]);
      
      lineItems.push({
        item: item.stockItem.item,
        quantity: item.quantity,
        unit: item.stockItem.unit,
        price: item.stockItem.price,
        cost: item.stockItem.cost,
        subtotal: item.quantity * item.stockItem.price
      });
      
      stockUpdates.push({
        item: item.stockItem.item,
        oldStock: stockInfo.stock,
        newStock: newStock
      });
      
      Logger.success(`📦 ${item.stockItem.item}: ${stockInfo.stock} → ${newStock}`);
    }

    const totalAmount = lineItems.reduce((sum, line) => sum + line.subtotal, 0);
    const thaiPaymentStatus = PAYMENT_STATUS_MAP[paymentStatus] || 'ยังไม่จ่าย';
    
    const orderRow = [
      orderNo,
      getThaiDateTimeString(),
      customer,
      deliveryPerson,
      'รอดำเนินการ',
      thaiPaymentStatus,
      totalAmount,
      JSON.stringify(lineItems),
      ''
    ];
    
    await appendSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I', [orderRow]);
    await loadStockCache(true);

    Logger.success(`✅ Order #${orderNo} created: ${customer} - ${totalAmount}฿`);

    return {
      success: true,
      orderNo,
      customer,
      totalAmount,
      items: lineItems.map((line, idx) => ({
        productName: line.item,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.price,
        lineTotal: line.subtotal,
        newStock: stockUpdates[idx].newStock,
        stockItem: items[idx].stockItem
      })),
      stockUpdates
    };

  } catch (error) {
    Logger.error('createOrderTransaction failed', error);
    return {
      success: false,
      error: `❌ ไม่สามารถสร้างออเดอร์ได้: ${error.message}`
    };
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
