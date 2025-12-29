// orderService.js - FULLY FIXED to match app.js expectations

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
// CREATE SINGLE ORDER - FIXED SIGNATURE
// ============================================================================

async function createOrder(orderData) {
  try {
    // Validate input
    if (!orderData) {
      throw new Error('orderData is required');
    }

    const { 
      customer, 
      item, 
      quantity, 
      deliveryPerson = '', 
      isCredit = false,
      paymentStatus,
      totalAmount 
    } = orderData;
    
    // Validate required fields
    if (!customer || !item || !quantity || !totalAmount) {
      Logger.error('Missing required fields', orderData);
      throw new Error('Missing required order fields: customer, item, quantity, totalAmount');
    }

    Logger.info(`📝 Creating order: ${customer} - ${item} x${quantity}`);
    
    // Get next order number
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:A');
    const nextOrderNo = rows.length || 1;

    // Determine payment status
    let thaiPaymentStatus;
    if (paymentStatus) {
      thaiPaymentStatus = PAYMENT_STATUS_MAP[paymentStatus] || 'ยังไม่จ่าย';
    } else {
      thaiPaymentStatus = isCredit ? 'เครดิต' : 'ยังไม่จ่าย';
    }

    Logger.info(`💰 Payment status: ${thaiPaymentStatus}`);

    const orderRow = [
      nextOrderNo,
      getThaiDateTimeString(),
      customer,
      item,
      quantity,
      '', // Note
      deliveryPerson || '',
      'รอดำเนินการ', // Delivery status
      thaiPaymentStatus,
      totalAmount
    ];

    await appendSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:J', [orderRow]);
    
    Logger.success(`✅ Order #${nextOrderNo} created - ${thaiPaymentStatus}`);
    
    return {
      success: true,
      orderNo: nextOrderNo,
      paymentStatus: thaiPaymentStatus,
      paymentStatusCode: paymentStatus || (isCredit ? 'credit' : 'unpaid'),
      customer,
      item,
      quantity,
      totalAmount
    };
  } catch (error) {
    Logger.error('createOrder failed', error);
    throw error;
  }
}

// ============================================================================
// GET ORDERS WITH FILTERS
// ============================================================================

async function getOrders(filters = {}) {
  try {
    const { customer, date, orderNo, paymentStatus } = filters;
    
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:J');
    
    if (rows.length <= 1) {
      return [];
    }
    
    const stockCache = getStockCache();
    
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
        const status = (row[8] || '').trim();
        if (status !== paymentStatus) return false;
      }
      
      return true;
    }).map(row => {
      const stockItem = stockCache.find(s => s.item === row[3]);
      return {
        orderNo: row[0],
        date: row[1],
        customer: row[2],
        item: row[3],
        qty: parseInt(row[4] || 0),
        unit: stockItem?.unit || '',
        note: row[5] || '',
        delivery: row[6] || '',
        deliveryStatus: row[7] || 'รอดำเนินการ',
        paymentStatus: row[8] || 'ยังไม่จ่าย',
        total: parseFloat(row[9] || 0),
        cost: stockItem ? stockItem.cost * parseInt(row[4] || 0) : 0
      };
    });
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
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:J');
    
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

    const currentStatus = rows[rowIndex - 1][8] || '';
    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!I${rowIndex}`, [[newStatus]]);

    const customer = rows[rowIndex - 1][2] || 'ลูกค้า';
    const item = rows[rowIndex - 1][3] || '';
    const total = rows[rowIndex - 1][9] || '0';

    Logger.success(`💰 Payment updated: Order #${orderNo} - ${currentStatus} → ${newStatus}`);

    return {
      success: true,
      orderNo,
      customer,
      item,
      total,
      oldStatus: currentStatus,
      newStatus
    };
  } catch (error) {
    Logger.error('updateOrderPaymentStatus failed', error);
    throw error;
  }
}

// ============================================================================
// UPDATE MULTIPLE PAYMENTS - BATCH
// ============================================================================

async function updateMultiplePaymentStatus(orderNos, newStatus = 'จ่ายแล้ว') {
  if (!Array.isArray(orderNos) || orderNos.length === 0) {
    return {
      success: false,
      error: 'กรุณาระบุหมายเลขคำสั่งซื้อ'
    };
  }

  try {
    Logger.info(`🔄 Updating payment for ${orderNos.length} orders...`);
    
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:J');
    const batchUpdates = [];
    const results = [];
    
    for (const orderNo of orderNos) {
      let rowIndex = -1;
      
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] == orderNo) {
          rowIndex = i + 1;
          break;
        }
      }

      if (rowIndex === -1) {
        Logger.warn(`⚠️ Order #${orderNo} not found`);
        results.push({
          orderNo,
          success: false,
          error: 'ไม่พบคำสั่งซื้อ'
        });
        continue;
      }

      const currentStatus = rows[rowIndex - 1][8] || '';
      const customer = rows[rowIndex - 1][2] || '';
      const item = rows[rowIndex - 1][3] || '';
      const total = parseFloat(rows[rowIndex - 1][9] || 0);

      batchUpdates.push({
        range: `คำสั่งซื้อ!I${rowIndex}`,
        values: [[newStatus]]
      });

      results.push({
        orderNo,
        success: true,
        customer,
        item,
        total,
        oldStatus: currentStatus,
        newStatus
      });
    }

    // Execute batch update
    if (batchUpdates.length > 0) {
      await batchUpdateSheet(CONFIG.SHEET_ID, batchUpdates);
      Logger.success(`✅ Updated ${batchUpdates.length} orders successfully`);
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    const totalAmount = results
      .filter(r => r.success)
      .reduce((sum, r) => sum + r.total, 0);

    return {
      success: successCount > 0,
      results,
      summary: {
        total: orderNos.length,
        success: successCount,
        failed: failCount,
        totalAmount
      }
    };
  } catch (error) {
    Logger.error('updateMultiplePaymentStatus failed', error);
    throw error;
  }
}

// ============================================================================
// UPDATE DELIVERY STATUS
// ============================================================================

async function updateOrderDeliveryStatus(orderNo, newStatus = 'ส่งเสร็จแล้ว') {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:J');
    
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

    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!H${rowIndex}`, [[newStatus]]);

    const customer = rows[rowIndex - 1][2] || 'ลูกค้า';
    const item = rows[rowIndex - 1][3] || '';
    const delivery = rows[rowIndex - 1][6] || '';

    Logger.success(`🚚 Delivery updated: Order #${orderNo} → ${newStatus}`);

    return {
      success: true,
      orderNo,
      customer,
      item,
      delivery,
      newStatus
    };
  } catch (error) {
    Logger.error('updateOrderDeliveryStatus failed', error);
    throw error;
  }
}

// ============================================================================
// GET PENDING PAYMENTS
// ============================================================================

async function getPendingPayments() {
  try {
    const orders = await getOrders({});
    
    const pending = orders.filter(order => 
      order.paymentStatus === 'ยังไม่จ่าย' || order.paymentStatus === 'เครดิต'
    );
    
    const totalPending = pending.reduce((sum, order) => sum + order.total, 0);
    
    return {
      orders: pending,
      count: pending.length,
      totalAmount: totalPending
    };
  } catch (error) {
    Logger.error('getPendingPayments failed', error);
    throw error;
  }
}

// ============================================================================
// UPDATE STOCK
// ============================================================================

async function updateStock(itemName, unit, newStock) {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
    const key = itemName.toLowerCase().trim();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowName = (row[0] || '').trim().toLowerCase();
      const rowUnit = (row[3] || '').trim().toLowerCase();

      if (rowName === key && rowUnit === unit.toLowerCase()) {
        await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${i + 1}`, [[newStock]]);
        Logger.success(`📦 Stock updated: ${itemName} = ${newStock}`);
        return true;
      }
    }
    
    Logger.warn(`⚠️ Stock item not found: ${itemName} (${unit})`);
    return false;
  } catch (error) {
    Logger.error('updateStock failed', error);
    throw error;
  }
}

// ============================================================================
// DETECT PAYMENT INTENT FROM USER INPUT
// ============================================================================

function detectPaymentIntent(userInput) {
  const lower = userInput.toLowerCase();
  
  // Check for explicit paid keywords
  const paidKeywords = ['จ่ายแล้ว', 'จ่ายเงินแล้ว', 'เงินสด', 'จ่ายสด', 'ชำระแล้ว'];
  if (paidKeywords.some(kw => lower.includes(kw))) {
    Logger.info('💰 Detected: จ่ายแล้ว');
    return 'paid';
  }
  
  // Check for credit keywords
  const creditKeywords = ['เครดิต', 'เครดิด', 'เคริดิต', 'ค้าง'];
  if (creditKeywords.some(kw => lower.includes(kw))) {
    Logger.info('📖 Detected: เครดิต');
    return 'credit';
  }
  
  // Default: unpaid
  Logger.info('⏳ Default: ยังไม่จ่าย');
  return 'unpaid';
}

// ============================================================================
// USER-FRIENDLY PAYMENT STATUS DISPLAY
// ============================================================================

function getPaymentStatusMessage(paymentStatus) {
  const messages = {
    'paid': {
      icon: '✅',
      text: 'จ่ายแล้ว',
      description: 'ชำระเงินเรียบร้อย'
    },
    'credit': {
      icon: '📖',
      text: 'เครดิต',
      description: 'ค้างชำระ (จ่ายทีหลัง)'
    },
    'unpaid': {
      icon: '⏳',
      text: 'ยังไม่จ่าย',
      description: 'รอรับชำระเงิน'
    }
  };
  
  return messages[paymentStatus] || messages['unpaid'];
}

// ============================================================================
// BULK PAYMENT UPDATE
// ============================================================================

async function bulkUpdatePaymentStatus(orderNos, newStatus) {
  if (!Array.isArray(orderNos)) {
    orderNos = [orderNos];
  }
  
  Logger.info(`🔄 Bulk payment update: ${orderNos.length} orders → ${newStatus}`);
  
  const results = [];
  for (const orderNo of orderNos) {
    try {
      const result = await updateOrderPaymentStatus(orderNo, newStatus);
      results.push(result);
    } catch (error) {
      Logger.error(`Failed to update #${orderNo}`, error);
      results.push({
        success: false,
        orderNo,
        error: error.message
      });
    }
  }
  
  const successCount = results.filter(r => r.success).length;
  Logger.success(`✅ Updated ${successCount}/${orderNos.length} orders`);
  
  return {
    success: successCount > 0,
    total: orderNos.length,
    successful: successCount,
    failed: orderNos.length - successCount,
    results
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  createOrder,
  getOrders,
  updateOrderPaymentStatus,
  updateMultiplePaymentStatus,
  updateOrderDeliveryStatus,
  getPendingPayments,
  updateStock,
  detectPaymentIntent,
  getPaymentStatusMessage,
  bulkUpdatePaymentStatus,
  PAYMENT_STATUS_MAP
};