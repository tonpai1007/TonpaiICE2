// orderService.js - FIXED: Optimistic Locking + Proper productName return
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString, getThaiDateString, convertThaiDateToGregorian } = require('./utils');
const { getSheetData, appendSheetData, updateSheetData, batchUpdateSheet } = require('./googleServices');
const { getStockCache } = require('./cacheManager');

const PAYMENT_STATUS_MAP = {
  'paid': 'จ่ายแล้ว',
  'credit': 'เครดิต',
  'unpaid': 'ยังไม่จ่าย'
};

// ============================================================================
// 🔒 OPTIMISTIC LOCKING: Stock Version Control
// ============================================================================

async function updateStockWithOptimisticLocking(itemName, unit, newStock, expectedOldStock, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const rows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
      const key = itemName.toLowerCase().trim();

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const rowName = (row[0] || '').trim().toLowerCase();
        const rowUnit = (row[3] || '').trim().toLowerCase();
        const currentStock = parseInt(row[4] || 0);

        if (rowName === key && rowUnit === unit.toLowerCase()) {
          // 🔒 OPTIMISTIC LOCK: Verify stock hasn't changed
          if (currentStock !== expectedOldStock) {
            Logger.warn(`⚠️ Stock changed: ${itemName} (expected ${expectedOldStock}, got ${currentStock})`);
            throw new Error('STOCK_VERSION_CONFLICT');
          }

          await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${i + 1}`, [[newStock]]);
          Logger.success(`📦 Stock updated: ${itemName} = ${newStock} (attempt ${attempt})`);
          return true;
        }
      }
      
      Logger.warn(`⚠️ Stock item not found: ${itemName} (${unit})`);
      return false;
      
    } catch (error) {
      if (error.message === 'STOCK_VERSION_CONFLICT' && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 500;
        Logger.warn(`⏳ Retry ${attempt}/${maxRetries} in ${delay}ms (version conflict)...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Re-fetch expected stock for next attempt
        const freshCache = getStockCache();
        const freshItem = freshCache.find(item => 
          item.item.toLowerCase() === itemName.toLowerCase() && 
          item.unit.toLowerCase() === unit.toLowerCase()
        );
        if (freshItem) {
          expectedOldStock = freshItem.stock;
          newStock = expectedOldStock - (expectedOldStock - newStock);
        }
        continue;
      }
      
      if (attempt === maxRetries) {
        Logger.error(`❌ Stock update failed after ${maxRetries} attempts`, error);
        throw error;
      }
      
      const delay = Math.pow(2, attempt) * 1000;
      Logger.warn(`⏳ Retry ${attempt}/${maxRetries} in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ============================================================================
// TRANSACTIONAL ORDER CREATION (FIXED)
// ============================================================================

async function createOrderTransaction(orderData) {
  const { customer, items, deliveryPerson = '', paymentStatus = 'unpaid' } = orderData;
  
  if (!customer || !items || !Array.isArray(items) || items.length === 0) {
    return {
      success: false,
      error: 'Invalid order data: missing customer or items'
    };
  }

  Logger.info(`📝 Starting CLEANED transaction: ${customer} (${items.length} items)`);
  
  let orderNo = null;
  let createdLineItems = [];
  let stockUpdates = [];
  
  try {
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    orderNo = orderRows.length || 1;
    
    const totalAmount = items.reduce((sum, item) => {
      return sum + (item.quantity * item.stockItem.price);
    }, 0);
    
    // Format line items as comma-separated string: "สินค้า1 x5, สินค้า2 x10"
    const lineItemsText = items.map(item => 
      `${item.stockItem.item} x${item.quantity}`
    ).join(', ');
    
    const thaiPaymentStatus = PAYMENT_STATUS_MAP[paymentStatus] || 'ยังไม่จ่าย';
    
    const orderHeaderRow = [
      orderNo,
      getThaiDateTimeString(),
      customer,
      lineItemsText,          // NEW: All items in one column
      deliveryPerson,
      'รอดำเนินการ',
      thaiPaymentStatus,
      totalAmount,
      ''
    ];
    
    await appendSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I', [orderHeaderRow]);
    Logger.success(`✅ Phase 1: Order #${orderNo} created (denormalized)`);
    
    // Phase 2: Build line items data (for response only, not saved to separate sheet)
    Logger.success(`✅ Phase 2: Order contains ${items.length} items`);
    
    // Phase 3: Update stock for each item
    for (const item of items) {
      const lineTotal = item.quantity * item.stockItem.price;
      
      // Store line item details for response
      createdLineItems.push({
        orderNo,
        productName: item.stockItem.item,  // ✅ FIXED: Store actual product name
        quantity: item.quantity,
        unit: item.stockItem.unit,
        unitPrice: item.stockItem.price,
        unitCost: item.stockItem.cost,
        lineTotal
      });
      
      const newStock = item.stockItem.stock - item.quantity;
      const expectedOldStock = item.stockItem.stock;
      
      try {
        const updated = await updateStockWithOptimisticLocking(
          item.stockItem.item, 
          item.stockItem.unit, 
          newStock,
          expectedOldStock,
          3
        );
        
        if (!updated) {
          throw new Error(`Stock update returned false for ${item.stockItem.item}`);
        }
        
        stockUpdates.push({
          item: item.stockItem.item,
          oldStock: item.stockItem.stock,
          newStock: newStock,
          unit: item.stockItem.unit
        });
        
        Logger.success(`✅ Stock updated: ${item.stockItem.item} (${item.stockItem.stock} → ${newStock})`);
        
      } catch (stockError) {
        Logger.error(`❌ Phase 3 FAILED: ${item.stockItem.item}`, stockError);
        await rollbackStockUpdates(stockUpdates);
        await rollbackOrderHeader(orderNo);
        
        return {
          success: false,
          error: `Stock update failed for ${item.stockItem.item}`,
          details: stockError.message
        };
      }
    }
    
    Logger.success(`✅ TRANSACTION COMMITTED: Order #${orderNo}`);
    
    // ✅ FIXED: Return proper structure with productName
    return {
      success: true,
      orderNo,
      customer,
      totalAmount,
      items: createdLineItems.map((lineItem, idx) => ({
        productName: lineItem.productName,     // ✅ Product name from lineItem
        quantity: lineItem.quantity,
        unit: lineItem.unit,
        unitPrice: lineItem.unitPrice,
        unitCost: lineItem.unitCost,
        lineTotal: lineItem.lineTotal,
        newStock: stockUpdates[idx].newStock,  // ✅ New stock after deduction
        stockItem: items[idx].stockItem         // ✅ Original stockItem for fallback
      })),
      stockUpdates
    };
    
  } catch (criticalError) {
    Logger.error('❌ CRITICAL TRANSACTION FAILURE', criticalError);
    
    if (orderNo) {
      await rollbackStockUpdates(stockUpdates);
      await rollbackOrderHeader(orderNo);
    }
    
    return {
      success: false,
      error: 'Critical transaction failure',
      details: criticalError.message
    };
  }
}

async function rollbackOrderHeader(orderNo) {
  try {
    Logger.warn(`🔄 Rolling back order header #${orderNo}...`);
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    const filteredRows = rows.filter((row, idx) => {
      if (idx === 0) return true;
      return row[0] != orderNo;
    });
    await batchUpdateSheet(CONFIG.SHEET_ID, [{
      range: 'คำสั่งซื้อ!A:I',
      values: filteredRows
    }]);
    Logger.success(`✅ Order header #${orderNo} rolled back`);
  } catch (error) {
    Logger.error('Failed to rollback order header', error);
  }
}

async function rollbackStockUpdates(stockUpdates) {
  try {
    if (stockUpdates.length === 0) return;
    Logger.warn(`🔄 Rolling back ${stockUpdates.length} stock updates...`);
    for (const update of stockUpdates) {
      await updateStockWithOptimisticLocking(update.item, update.unit, update.oldStock, update.newStock, 2);
    }
    Logger.success(`✅ Stock rollback completed`);
  } catch (error) {
    Logger.error('Failed to rollback stock updates', error);
  }
}

// Legacy wrapper
async function updateStock(itemName, unit, newStock) {
  const stockCache = getStockCache();
  const item = stockCache.find(i => 
    i.item.toLowerCase() === itemName.toLowerCase() && 
    i.unit.toLowerCase() === unit.toLowerCase()
  );
  
  if (!item) {
    Logger.error(`Item not found in cache: ${itemName}`);
    return false;
  }
  
  return await updateStockWithOptimisticLocking(itemName, unit, newStock, item.stock, 3);
}

async function getOrders(filters = {}) {
  try {
    const { customer, date, orderNo, paymentStatus } = filters;
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    
    if (rows.length <= 1) return [];
    
    return rows.slice(1).filter(row => {
      if (orderNo && row[0] != orderNo) return false;
      if (date) {
        const orderDateRaw = (row[1] || '').trim();
        let orderDate = orderDateRaw.split(' ')[0];
        if (orderDateRaw.includes('/')) {
          const converted = convertThaiDateToGregorian(orderDateRaw);
          if (converted) orderDate = converted;
        }
        if (orderDate !== date) return false;
      }
      if (customer) {
        const orderCustomer = (row[2] || '').trim().toLowerCase();
        const searchCustomer = customer.toLowerCase();
        if (!orderCustomer.includes(searchCustomer)) return false;
      }
      if (paymentStatus) {
        const status = (row[6] || '').trim();
        if (status !== paymentStatus) return false;
      }
      return true;
    }).map(row => ({
      orderNo: row[0],
      date: row[1],
      customer: row[2],
      items: row[3],           // Line items as text
      deliveryPerson: row[4],
      deliveryStatus: row[5],
      paymentStatus: row[6],
      totalAmount: parseFloat(row[7] || 0),
      notes: row[8] || ''
    }));
  } catch (error) {
    Logger.error('getOrders failed', error);
    throw error;
  }
}

async function updateOrderPaymentStatus(orderNo, newStatus = 'จ่ายแล้ว') {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] == orderNo) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex === -1) {
      return { success: false, error: `ไม่พบคำสั่งซื้อ #${orderNo}` };
    }

    const validStatuses = ['ยังไม่จ่าย', 'จ่ายแล้ว', 'เครดิต', 'ยกเลิก'];
    if (!validStatuses.includes(newStatus)) {
      return { success: false, error: `สถานะไม่ถูกต้อง: ${newStatus}` };
    }

    const currentStatus = rows[rowIndex - 1][6] || '';
    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!G${rowIndex}`, [[newStatus]]);

    const customer = rows[rowIndex - 1][2] || 'ลูกค้า';
    const totalAmount = parseFloat(rows[rowIndex - 1][7] || 0);

    Logger.success(`💰 Payment updated: Order #${orderNo} - ${currentStatus} → ${newStatus}`);

    return {
      success: true,
      orderNo,
      customer,
      totalAmount,
      oldStatus: currentStatus,
      newStatus
    };
  } catch (error) {
    Logger.error('updateOrderPaymentStatus failed', error);
    throw error;
  }
}

async function updateOrderDeliveryStatus(orderNo, newStatus = 'ส่งเสร็จแล้ว') {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] == orderNo) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex === -1) {
      return { success: false, error: `ไม่พบคำสั่งซื้อ #${orderNo}` };
    }

    const validStatuses = ['รอดำเนินการ', 'กำลังจัดส่ง', 'ส่งเสร็จแล้ว', 'ยกเลิก'];
    if (!validStatuses.includes(newStatus)) {
      return { success: false, error: `สถานะไม่ถูกต้อง: ${newStatus}` };
    }

    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!F${rowIndex}`, [[newStatus]]);

    const customer = rows[rowIndex - 1][2] || 'ลูกค้า';
    const deliveryPerson = rows[rowIndex - 1][4] || '';

    Logger.success(`🚚 Delivery updated: Order #${orderNo} → ${newStatus}`);

    return {
      success: true,
      orderNo,
      customer,
      deliveryPerson,
      newStatus
    };
  } catch (error) {
    Logger.error('updateOrderDeliveryStatus failed', error);
    throw error;
  }
}

async function getPendingPayments() {
  try {
    const orders = await getOrders({});
    const pending = [];
    let totalAmount = 0;
    
    for (const order of orders) {
      if (order.paymentStatus === 'ยังไม่จ่าย' || order.paymentStatus === 'เครดิต') {
        pending.push({
          orderNo: order.orderNo,
          customer: order.customer,
          totalAmount: order.totalAmount,
          paymentStatus: order.paymentStatus,
          date: order.date
        });
        totalAmount += order.totalAmount;
      }
    }
    
    return {
      orders: pending,
      count: pending.length,
      totalAmount
    };
  } catch (error) {
    Logger.error('getPendingPayments failed', error);
    throw error;
  }
}

module.exports = {
  createOrderTransaction,
  createOrder: createOrderTransaction,
  getOrders,
  getPendingPayments,
  updateOrderPaymentStatus,
  updateOrderDeliveryStatus,
  updateStock,
  PAYMENT_STATUS_MAP
};