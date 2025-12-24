// orderService.js - FIXED Payment Status Logic

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString, getThaiDateString, convertThaiDateToGregorian } = require('./utils');
const { getSheetData, appendSheetData, updateSheetData } = require('./googleServices');
const { getStockCache } = require('./cacheManager');

// ============================================================================
// CREATE ORDER WITH SMART PAYMENT DETECTION
// ============================================================================

async function createOrder(orderData) {
  try {
    const { customer, item, quantity, deliveryPerson, isCredit, totalAmount } = orderData;
    
    // Get next order number
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:A');
    const nextOrderNo = rows.length || 1;

    // FIXED: Payment status should default to "ยังไม่จ่าย" 
    // Admin must explicitly mark as paid
    const paymentStatus = isCredit ? 'เครดิต' : 'ยังไม่จ่าย';

    const orderRow = [
      nextOrderNo,
      getThaiDateTimeString(),
      customer,
      item,
      quantity,
      '', // Note
      deliveryPerson || '',
      'รอดำเนินการ', // Delivery status
      paymentStatus,   // Payment status
      totalAmount
    ];

    await appendSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:J', [orderRow]);
    
    Logger.success(`Order created: #${nextOrderNo} - Payment: ${paymentStatus}`);
    
    return {
      success: true,
      orderNo: nextOrderNo,
      paymentStatus,
      ...orderData
    };
  } catch (error) {
    Logger.error('createOrder failed', error);
    throw error;
  }
}

// ============================================================================
// GET ORDERS
// ============================================================================

async function getOrders(filters = {}) {
  try {
    const { customer, date, orderNo, paymentStatus } = filters;
    
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:J');
    
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
// UPDATE PAYMENT STATUS (ADMIN ONLY)
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

    const currentStatus = rows[rowIndex - 1][8] || '';
    
    // Validate status change
    const validStatuses = ['ยังไม่จ่าย', 'จ่ายแล้ว', 'เครดิต', 'ยกเลิก'];
    if (!validStatuses.includes(newStatus)) {
      return {
        success: false,
        error: `สถานะไม่ถูกต้อง: ${newStatus}`
      };
    }

    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!I${rowIndex}`, [[newStatus]]);

    const customer = rows[rowIndex - 1][2] || 'ลูกค้า';
    const item = rows[rowIndex - 1][3] || '';
    const total = rows[rowIndex - 1][9] || '0';

    Logger.success(`Payment updated: Order #${orderNo} - ${currentStatus} → ${newStatus}`);

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
// UPDATE DELIVERY STATUS (ADMIN ONLY)
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

    Logger.success(`Delivery updated: Order #${orderNo} → ${newStatus}`);

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
// GET PENDING PAYMENTS (ADMIN ONLY)
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
        Logger.success(`Stock updated: ${itemName} = ${newStock}`);
        return true;
      }
    }
    
    return false;
  } catch (error) {
    Logger.error('updateStock failed', error);
    throw error;
  }
}

module.exports = {
  createOrder,
  getOrders,
  updateOrderPaymentStatus,
  updateOrderDeliveryStatus,
  getPendingPayments,
  updateStock
};