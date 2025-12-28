// orderService.js - FIXED Payment Status Logic
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString, getThaiDateString, convertThaiDateToGregorian } = require('./utils');
const { getSheetData, appendSheetData, updateSheetData, batchUpdateSheet } = require('./googleServices');
const { getStockCache } = require('./cacheManager');
// ============================================================================
// CREATE ORDER WITH SMART PAYMENT DETECTION
// ============================================================================

async function createOrder(orderData) {
  try {
    const { customer, items, deliveryPerson, isCredit } = orderData;
    
    // Get next order number
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:A');
    const nextOrderNo = rows.length || 1;

    // Calculate total
    const totalAmount = items.reduce((sum, item) => 
      sum + (item.quantity * item.stockItem.price), 0
    );
    
    // Payment status
    const paymentStatus = isCredit ? 'เครดิต' : 'ยังไม่จ่าย';
    const timestamp = getThaiDateTimeString();

    // Create order header
    const orderRow = [
      nextOrderNo,                    // รหัสคำสั่ง
      timestamp,                      // วันที่
      customer,                       // ลูกค้า
      deliveryPerson || '',           // ผู้ส่ง
      'รอดำเนินการ',                  // สถานะการจัดส่ง
      paymentStatus,                  // สถานะการชำระ
      totalAmount,                    // ยอดรวม
      ''                              // หมายเหตุ
    ];

    await appendSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:H', [orderRow]);
    
    // Create line items
    const lineItemRows = items.map(item => [
      nextOrderNo,                              // รหัสคำสั่ง
      item.stockItem.item,                      // สินค้า
      item.quantity,                            // จำนวน
      item.stockItem.unit,                      // หน่วย
      item.stockItem.price,                     // ราคาต่อหน่วย
      item.stockItem.cost || 0,                 // ต้นทุนต่อหน่วย
      item.quantity * item.stockItem.price      // รวม
    ]);

    await appendSheetData(CONFIG.SHEET_ID, 'รายการสินค้า!A:G', lineItemRows);
    
    // If credit, add to เครดิต sheet
    if (isCredit) {
      await addCreditRecord(nextOrderNo, customer, totalAmount, timestamp);
    }
    
    Logger.success(`Order #${nextOrderNo} created with ${items.length} items`);
    
    return {
      success: true,
      orderNo: nextOrderNo,
      paymentStatus,
      totalAmount,
      itemCount: items.length,
      items: items
    };
  } catch (error) {
    Logger.error('createOrder failed', error);
    throw error;
  }
}


async function addCreditRecord(orderNo, customer, amount, timestamp) {
  try {
    // Add 30 days for due date
    const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const dueDateStr = dueDate.toLocaleDateString('th-TH');
    
    const creditRow = [
      timestamp,          // วันที่
      customer,           // ลูกค้า
      orderNo,            // รหัสคำสั่ง
      amount,             // ยอดเงิน
      'ค้างชำระ',         // สถานะ
      dueDateStr,         // วันครบกำหนด
      ''                  // หมายเหตุ
    ];
    
    await appendSheetData(CONFIG.SHEET_ID, 'เครดิต!A:G', [creditRow]);
    Logger.success(`Credit record added for order #${orderNo}`);
  } catch (error) {
    Logger.error('Failed to add credit record', error);
    // Don't throw - credit tracking is secondary
  }
}

// ============================================================================
// GET ORDERS
// ============================================================================

async function getOrders(filters = {}) {
  try {
    const { customer, date, orderNo, paymentStatus, deliveryStatus } = filters;
    
    // Get order headers
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:H');
    
    // Get line items
    const lineItemRows = await getSheetData(CONFIG.SHEET_ID, 'รายการสินค้า!A:G');
    
    if (orderRows.length <= 1) {
      return [];
    }
    
    // Filter orders
    const filteredOrders = orderRows.slice(1).filter(row => {
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
        if (!orderCustomer.includes(customer.toLowerCase())) return false;
      }
      
      if (paymentStatus && row[5] !== paymentStatus) return false;
      if (deliveryStatus && row[4] !== deliveryStatus) return false;
      
      return true;
    });

    // Build order objects with line items
    return filteredOrders.map(row => {
      const orderNumber = row[0];
      
      // Get line items for this order
      const items = lineItemRows
        .slice(1)
        .filter(lineRow => lineRow[0] == orderNumber)
        .map(lineRow => ({
          item: lineRow[1] || '',
          quantity: parseInt(lineRow[2] || 0),
          unit: lineRow[3] || '',
          price: parseFloat(lineRow[4] || 0),
          cost: parseFloat(lineRow[5] || 0),
          total: parseFloat(lineRow[6] || 0)
        }));

      return {
        orderNo: orderNumber,
        date: row[1] || '',
        customer: row[2] || '',
        deliveryPerson: row[3] || '',
        deliveryStatus: row[4] || 'รอดำเนินการ',
        paymentStatus: row[5] || 'ยังไม่จ่าย',
        total: parseFloat(row[6] || 0),
        note: row[7] || '',
        items: items,
        itemCount: items.length
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
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:H');
    
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

    const currentStatus = rows[rowIndex - 1][5] || '';
    const customer = rows[rowIndex - 1][2] || 'ลูกค้า';
    const total = rows[rowIndex - 1][6] || '0';
    
    // Update payment status in คำสั่งซื้อ sheet (column F = index 5)
    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!F${rowIndex}`, [[newStatus]]);

    // Update credit sheet if applicable
    if (currentStatus === 'เครดิต' && newStatus === 'จ่ายแล้ว') {
      await updateCreditStatus(orderNo, 'ชำระแล้ว');
    } else if (newStatus === 'เครดิต' && currentStatus !== 'เครดิต') {
      // Changed to credit - add credit record
      await addCreditRecord(orderNo, customer, parseFloat(total), rows[rowIndex - 1][1]);
    }

    // Get line items for display
    const lineItems = await getSheetData(CONFIG.SHEET_ID, 'รายการสินค้า!A:G');
    const items = lineItems
      .slice(1)
      .filter(row => row[0] == orderNo)
      .map(row => `${row[1]} x${row[2]}`)
      .join(', ');

    Logger.success(`Payment updated: Order #${orderNo} - ${currentStatus} → ${newStatus}`);

    return {
      success: true,
      orderNo,
      customer,
      items,
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
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:H');
    
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

    // Update delivery status (column E = index 4)
    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!E${rowIndex}`, [[newStatus]]);

    const customer = rows[rowIndex - 1][2] || 'ลูกค้า';
    const deliveryPerson = rows[rowIndex - 1][3] || '';
    
    // Get line items
    const lineItems = await getSheetData(CONFIG.SHEET_ID, 'รายการสินค้า!A:G');
    const items = lineItems
      .slice(1)
      .filter(row => row[0] == orderNo)
      .map(row => `${row[1]} x${row[2]}`)
      .join(', ');

    Logger.success(`Delivery updated: Order #${orderNo} → ${newStatus}`);

    return {
      success: true,
      orderNo,
      customer,
      items,
      deliveryPerson,
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
async function updateCreditStatus(orderNo, newStatus) {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'เครดิต!A:G');
    
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][2] == orderNo) {  // Column C = รหัสคำสั่ง
        rowIndex = i + 1;
        break;
      }
    }
    
    if (rowIndex !== -1) {
      await updateSheetData(CONFIG.SHEET_ID, `เครดิต!E${rowIndex}`, [[newStatus]]);
      Logger.success(`Credit status updated for order #${orderNo}`);
    }
  } catch (error) {
    Logger.error('Failed to update credit status', error);
    // Don't throw - continue even if credit update fails
  }
}
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


async function cancelOrder(orderNo, reason = '') {
  try {
    const orders = await getOrders({ orderNo });
    
    if (orders.length === 0) {
      return { success: false, error: `ไม่พบคำสั่งซื้อ #${orderNo}` };
    }
    
    const order = orders[0];
    
    // Update order status
    const deliveryResult = await updateOrderDeliveryStatus(orderNo, 'ยกเลิก');
    
    // Restore stock
    for (const item of order.items) {
      const stockCache = getStockCache();
      const stockItem = stockCache.find(s => s.item === item.item);
      
      if (stockItem) {
        const newStock = stockItem.stock + item.quantity;
        await updateStock(item.item, item.unit, newStock);
      }
    }
    
    // Update credit if applicable
    if (order.paymentStatus === 'เครดิต') {
      await updateCreditStatus(orderNo, 'ยกเลิก');
    }
    
    Logger.success(`Order #${orderNo} cancelled and stock restored`);
    
    return {
      success: true,
      orderNo,
      customer: order.customer,
      reason
    };
  } catch (error) {
    Logger.error('cancelOrder failed', error);
    throw error;
  }
}

module.exports = {
  createOrder,
  getOrders,
  updateOrderPaymentStatus,
  updateOrderDeliveryStatus,
  getPendingPayments,
  updateStock,
  cancelOrder,
  updateCreditStatus,
  addCreditRecord
};