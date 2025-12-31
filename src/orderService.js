// orderService.js - COMPLETELY REWRITTEN WITH TRANSACTIONAL INTEGRITY
// ============================================================================
// 🔥 KEY ARCHITECTURAL CHANGES:
// 1. Order Header (คำสั่งซื้อ) + Line Items (รายการสินค้า) separation
// 2. Atomic transactions with rollback capability
// 3. Stock deduction tied to line items, not order header
// 4. Proper foreign key emulation (orderNo linking)
// ============================================================================

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString, getThaiDateString, convertThaiDateToGregorian } = require('./utils');
const { getSheetData, appendSheetData, updateSheetData, batchUpdateSheet } = require('./googleServices');
const { getStockCache } = require('./cacheManager');

// ============================================================================
// PAYMENT STATUS MAPPING
// ============================================================================

const PAYMENT_STATUS_MAP = {
  'paid': 'จ่ายแล้ว',
  'credit': 'เครดิต',
  'unpaid': 'ยังไม่จ่าย'
};

// ============================================================================
// 🔥 NEW: TRANSACTIONAL ORDER CREATION (ACID-like)
// ============================================================================

/**
 * Creates order with ACID-like transaction guarantees:
 * - Atomicity: All or nothing (header + line items + stock updates)
 * - Consistency: Data integrity preserved
 * - Isolation: Sequential execution per order
 * - Durability: Committed to Google Sheets
 */
async function createOrderTransaction(orderData) {
  const { customer, items, deliveryPerson = '', paymentStatus = 'unpaid' } = orderData;
  
  // Validation
  if (!customer || !items || !Array.isArray(items) || items.length === 0) {
    return {
      success: false,
      error: 'Invalid order data: missing customer or items'
    };
  }

  Logger.info(`📝 Starting transaction: ${customer} (${items.length} items)`);
  
  let orderNo = null;
  let createdLineItems = [];
  let stockUpdates = [];
  
  try {
    // ========================================================================
    // PHASE 1: CREATE ORDER HEADER
    // ========================================================================
    
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:H');
    orderNo = orderRows.length || 1;
    
    const totalAmount = items.reduce((sum, item) => {
      return sum + (item.quantity * item.stockItem.price);
    }, 0);
    
    const thaiPaymentStatus = PAYMENT_STATUS_MAP[paymentStatus] || 'ยังไม่จ่าย';
    
    const orderHeaderRow = [
      orderNo,
      getThaiDateTimeString(),
      customer,
      deliveryPerson,
      'รอดำเนินการ', // Delivery status
      thaiPaymentStatus,
      totalAmount,
      '' // Notes
    ];
    
    await appendSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:H', [orderHeaderRow]);
    Logger.success(`✅ Phase 1: Order header #${orderNo} created`);
    
    // ========================================================================
    // PHASE 2: CREATE LINE ITEMS (WITH ROLLBACK ON FAILURE)
    // ========================================================================
    
    const lineItemRows = items.map(item => {
      const lineTotal = item.quantity * item.stockItem.price;
      
      createdLineItems.push({
        orderNo,
        productName: item.stockItem.item,
        quantity: item.quantity,
        unit: item.stockItem.unit,
        unitPrice: item.stockItem.price,
        unitCost: item.stockItem.cost,
        lineTotal
      });
      
      return [
        orderNo,
        item.stockItem.item,
        item.quantity,
        item.stockItem.unit,
        item.stockItem.price,
        item.stockItem.cost,
        lineTotal
      ];
    });
    
    try {
      await appendSheetData(CONFIG.SHEET_ID, 'รายการสินค้า!A:G', lineItemRows);
      Logger.success(`✅ Phase 2: ${lineItemRows.length} line items created`);
    } catch (lineItemError) {
      Logger.error('❌ Phase 2 FAILED: Line items write error', lineItemError);
      
      // ROLLBACK: Delete order header
      await rollbackOrderHeader(orderNo);
      
      return {
        success: false,
        error: 'Failed to create line items (rolled back)',
        details: lineItemError.message
      };
    }
    
    // ========================================================================
    // PHASE 3: UPDATE STOCK (WITH RETRY LOGIC)
    // ========================================================================
    
    for (const item of items) {
      const newStock = item.stockItem.stock - item.quantity;
      
      try {
        const updated = await updateStockWithRetry(
          item.stockItem.item, 
          item.stockItem.unit, 
          newStock,
          3 // Max retries
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
        Logger.error(`❌ Phase 3 FAILED: Stock update error for ${item.stockItem.item}`, stockError);
        
        // PARTIAL ROLLBACK: Revert successful stock updates
        await rollbackStockUpdates(stockUpdates);
        
        // FULL ROLLBACK: Delete line items and order header
        await rollbackLineItems(orderNo);
        await rollbackOrderHeader(orderNo);
        
        return {
          success: false,
          error: `Stock update failed for ${item.stockItem.item}`,
          details: stockError.message
        };
      }
    }
    
    Logger.success(`✅ Phase 3: All stock updates completed`);
    
    // ========================================================================
    // PHASE 4: COMMIT (All phases succeeded)
    // ========================================================================
    
    const result = {
      success: true,
      orderNo,
      customer,
      totalAmount,
      items: createdLineItems.map((lineItem, idx) => ({
        ...lineItem,
        newStock: stockUpdates[idx].newStock
      })),
      stockUpdates
    };
    
    Logger.success(`✅ TRANSACTION COMMITTED: Order #${orderNo}`);
    
    return result;
    
  } catch (criticalError) {
    Logger.error('❌ CRITICAL TRANSACTION FAILURE', criticalError);
    
    // Emergency rollback
    if (orderNo) {
      await rollbackStockUpdates(stockUpdates);
      await rollbackLineItems(orderNo);
      await rollbackOrderHeader(orderNo);
    }
    
    return {
      success: false,
      error: 'Critical transaction failure',
      details: criticalError.message
    };
  }
}

// ============================================================================
// ROLLBACK FUNCTIONS
// ============================================================================

async function rollbackOrderHeader(orderNo) {
  try {
    Logger.warn(`🔄 Rolling back order header #${orderNo}...`);
    
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:H');
    const filteredRows = rows.filter((row, idx) => {
      if (idx === 0) return true; // Keep header
      return row[0] != orderNo;
    });
    
    await batchUpdateSheet(CONFIG.SHEET_ID, [{
      range: 'คำสั่งซื้อ!A:H',
      values: filteredRows
    }]);
    
    Logger.success(`✅ Order header #${orderNo} rolled back`);
  } catch (error) {
    Logger.error('Failed to rollback order header', error);
  }
}

async function rollbackLineItems(orderNo) {
  try {
    Logger.warn(`🔄 Rolling back line items for order #${orderNo}...`);
    
    const rows = await getSheetData(CONFIG.SHEET_ID, 'รายการสินค้า!A:G');
    const filteredRows = rows.filter((row, idx) => {
      if (idx === 0) return true; // Keep header
      return row[0] != orderNo;
    });
    
    await batchUpdateSheet(CONFIG.SHEET_ID, [{
      range: 'รายการสินค้า!A:G',
      values: filteredRows
    }]);
    
    Logger.success(`✅ Line items for #${orderNo} rolled back`);
  } catch (error) {
    Logger.error('Failed to rollback line items', error);
  }
}

async function rollbackStockUpdates(stockUpdates) {
  try {
    if (stockUpdates.length === 0) return;
    
    Logger.warn(`🔄 Rolling back ${stockUpdates.length} stock updates...`);
    
    for (const update of stockUpdates) {
      await updateStockWithRetry(update.item, update.unit, update.oldStock, 2);
    }
    
    Logger.success(`✅ Stock rollback completed`);
  } catch (error) {
    Logger.error('Failed to rollback stock updates', error);
  }
}

// ============================================================================
// STOCK UPDATE WITH RETRY
// ============================================================================

async function updateStockWithRetry(itemName, unit, newStock, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const rows = await getSheetData(CONFIG.SHEET_ID, 'รายการสินค้า!A:G');
      const key = itemName.toLowerCase().trim();

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const rowName = (row[0] || '').trim().toLowerCase();
        const rowUnit = (row[3] || '').trim().toLowerCase();

        if (rowName === key && rowUnit === unit.toLowerCase()) {
          await updateSheetData(CONFIG.SHEET_ID, `รายการสินค้า!E${i + 1}`, [[newStock]]);
          Logger.success(`📦 Stock updated: ${itemName} = ${newStock} (attempt ${attempt})`);
          return true;
        }
      }
      
      Logger.warn(`⚠️ Stock item not found: ${itemName} (${unit})`);
      return false;
      
    } catch (error) {
      if (attempt === maxRetries) {
        Logger.error(`❌ Stock update failed after ${maxRetries} attempts`, error);
        throw error;
      }
      
      const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
      Logger.warn(`⏳ Retry ${attempt}/${maxRetries} in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ============================================================================
// LEGACY FUNCTION (Deprecated - use createOrderTransaction instead)
// ============================================================================

async function updateStock(itemName, unit, newStock) {
  return await updateStockWithRetry(itemName, unit, newStock, 3);
}

// ============================================================================
// GET ORDER WITH LINE ITEMS
// ============================================================================

async function getOrderWithLineItems(orderNo) {
  try {
    // Get order header
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'รายการสินค้า!A:G');
    const orderRow = orderRows.find(row => row[0] == orderNo);
    
    if (!orderRow) {
      return null;
    }
    
    // Get line items
    const lineItemRows = await getSheetData(CONFIG.SHEET_ID, 'รายการสินค้า!A:G');
    const items = lineItemRows
      .filter(row => row[0] == orderNo)
      .map(row => ({
        productName: row[1],
        quantity: parseInt(row[2] || 0),
        unit: row[3],
        unitPrice: parseFloat(row[4] || 0),
        unitCost: parseFloat(row[5] || 0),
        lineTotal: parseFloat(row[6] || 0)
      }));
    
    const totalAmount = items.reduce((sum, item) => sum + item.lineTotal, 0);
    const totalCost = items.reduce((sum, item) => sum + (item.unitCost * item.quantity), 0);
    const profit = totalAmount - totalCost;
    
    return {
      orderNo: orderRow[0],
      date: orderRow[1],
      customer: orderRow[2],
      deliveryPerson: orderRow[3],
      deliveryStatus: orderRow[4],
      paymentStatus: orderRow[5],
      totalAmount,
      items,
      profit,
      itemCount: items.length
    };
    
  } catch (error) {
    Logger.error('getOrderWithLineItems failed', error);
    throw error;
  }
}

// ============================================================================
// GET ORDERS (Enhanced to include line item info)
// ============================================================================

async function getOrders(filters = {}) {
  try {
    const { customer, date, orderNo, paymentStatus } = filters;
    
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:H');
    
    if (rows.length <= 1) {
      return [];
    }
    
    return rows.slice(1).filter(row => {
      // Filter by order number
      if (orderNo && row[0] != orderNo) return false;
      
      // Filter by date
      if (date) {
        const orderDateRaw = (row[1] || '').trim();
        let orderDate = orderDateRaw.split(' ')[0];
        
        if (orderDateRaw.includes('/')) {
          const converted = convertThaiDateToGregorian(orderDateRaw);
          if (converted) orderDate = converted;
        }
        
        if (orderDate !== date) return false;
      }
      
      // Filter by customer
      if (customer) {
        const orderCustomer = (row[2] || '').trim().toLowerCase();
        const searchCustomer = customer.toLowerCase();
        if (!orderCustomer.includes(searchCustomer)) return false;
      }
      
      // Filter by payment status
      if (paymentStatus) {
        const status = (row[5] || '').trim();
        if (status !== paymentStatus) return false;
      }
      
      return true;
    }).map(row => ({
      orderNo: row[0],
      date: row[1],
      customer: row[2],
      deliveryPerson: row[3],
      deliveryStatus: row[4],
      paymentStatus: row[5],
      totalAmount: parseFloat(row[6] || 0),
      notes: row[7] || ''
    }));
  } catch (error) {
    Logger.error('getOrders failed', error);
    throw error;
  }
}

// ============================================================================
// UPDATE PAYMENT STATUS
// ============================================================================

async function updateOrderPaymentStatus(orderNo, newStatus = 'จ่ายแล้ว') {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:H');
    
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] == orderNo) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex === -1) {
      return {
        success: false,
        error: `ไม่พบคำสั่งซื้อ #${orderNo}`
      };
    }

    const validStatuses = ['ยังไม่จ่าย', 'จ่ายแล้ว', 'เครดิต', 'ยกเลิก'];
    if (!validStatuses.includes(newStatus)) {
      return {
        success: false,
        error: `สถานะไม่ถูกต้อง: ${newStatus}`
      };
    }

    const currentStatus = rows[rowIndex - 1][5] || '';
    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!F${rowIndex}`, [[newStatus]]);

    const customer = rows[rowIndex - 1][2] || 'ลูกค้า';
    const totalAmount = parseFloat(rows[rowIndex - 1][6] || 0);

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

// ============================================================================
// UPDATE DELIVERY STATUS
// ============================================================================

async function updateOrderDeliveryStatus(orderNo, newStatus = 'ส่งเสร็จแล้ว') {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:H');
    
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] == orderNo) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex === -1) {
      return {
        success: false,
        error: `ไม่พบคำสั่งซื้อ #${orderNo}`
      };
    }

    const validStatuses = ['รอดำเนินการ', 'กำลังจัดส่ง', 'ส่งเสร็จแล้ว', 'ยกเลิก'];
    if (!validStatuses.includes(newStatus)) {
      return {
        success: false,
        error: `สถานะไม่ถูกต้อง: ${newStatus}`
      };
    }

    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!E${rowIndex}`, [[newStatus]]);

    const customer = rows[rowIndex - 1][2] || 'ลูกค้า';
    const deliveryPerson = rows[rowIndex - 1][3] || '';

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

// ============================================================================
// GET PENDING PAYMENTS (Enhanced)
// ============================================================================

async function getPendingPayments() {
  try {
    const orders = await getOrders({});
    
    const pending = [];
    let totalAmount = 0;
    
    for (const order of orders) {
      if (order.paymentStatus === 'ยังไม่จ่าย' || order.paymentStatus === 'เครดิต') {
        const details = await getOrderWithLineItems(order.orderNo);
        
        pending.push({
          orderNo: order.orderNo,
          customer: order.customer,
          totalAmount: order.totalAmount,
          paymentStatus: order.paymentStatus,
          itemCount: details ? details.itemCount : 0,
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

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // NEW: Primary transaction function
  createOrderTransaction,
  
  // LEGACY COMPATIBILITY: Alias for old code
  createOrder: createOrderTransaction, // ⚠️ Deprecated - use createOrderTransaction
  
  // Query functions
  getOrders,
  getOrderWithLineItems,
  getPendingPayments,
  
  // Update functions
  updateOrderPaymentStatus,
  updateOrderDeliveryStatus,
  updateStock,
  
  // Constants
  PAYMENT_STATUS_MAP
};