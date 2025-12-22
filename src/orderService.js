// orderService.js - Order creation, retrieval, and management

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString, getThaiDateString, convertThaiDateToGregorian } = require('./utils');
const { getSheetData, appendSheetData, updateSheetData } = require('./googleServices');
const { getStockCache } = require('./cacheManager');

// ============================================================================
// CREATE ORDER
// ============================================================================

async function createOrder(orderData) {
  try {
    const { customer, item, quantity, deliveryPerson, isCredit, totalAmount } = orderData;
    
    // Get next order number
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:A');
    const nextOrderNo = rows.length || 1;

    const paymentStatus = isCredit ? 'ยังไม่จ่าย' : 'จ่ายแล้ว';

    const orderRow = [
      nextOrderNo,
      getThaiDateTimeString(),
      customer,
      item,
      quantity,
      '', // Note
      deliveryPerson || '',
      'รอดำเนินการ',
      paymentStatus,
      totalAmount
    ];

    await appendSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:J', [orderRow]);
    
    Logger.success(`Order created: #${nextOrderNo}`);
    
    return {
      success: true,
      orderNo: nextOrderNo,
      ...orderData
    };
  } catch (error) {
    Logger.error('createOrder failed', error);
    throw error;
  }
}
async function createOrderWithTransaction(orderData) {
  const { customer, item, quantity, deliveryPerson, isCredit, totalAmount } = orderData;
  
  try {
    // 1. Validate stock availability
    const stockItem = getStockCache().find(s => s.item === item);
    if (!stockItem) {
      throw new Error(`สินค้า "${item}" ไม่พบในระบบ`);
    }
    
    if (quantity > stockItem.stock) {
      throw new Error(`สต็อกไม่เพียงพอ: มี ${stockItem.stock} ต้องการ ${quantity}`);
    }
    
    // 2. Create order first
    const orderResult = await createOrder(orderData);
    
    // 3. Update stock
    const newStock = stockItem.stock - quantity;
    const stockUpdated = await updateStock(item, stockItem.unit, newStock);
    
    if (!stockUpdated) {
      Logger.error('Stock update failed, but order was created', orderResult.orderNo);
      // Could implement order cancellation here
      throw new Error('อัปเดตสต็อกล้มเหลว กรุณาตรวจสอบคำสั่งซื้อ #' + orderResult.orderNo);
    }
    
    // 4. Reload cache
    await loadStockCache(true);
    
    return {
      ...orderResult,
      newStock,
      unit: stockItem.unit
    };
    
  } catch (error) {
    Logger.error('Transaction failed', error);
    throw error;
  }
}
// ============================================================================
// GET ORDERS
// ============================================================================

async function getOrders(filters = {}) {
  try {
    const { customer, date, orderNo } = filters;
    
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
        status: row[7] || '',
        paid: row[8] || '',
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
// UPDATE ORDER STATUS
// ============================================================================

async function updateOrderPaymentStatus(orderNo) {
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

    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!I${rowIndex}`, [['จ่ายแล้ว']]);

    const customer = rows[rowIndex - 1][2] || 'ลูกค้า';
    const item = rows[rowIndex - 1][3] || '';
    const total = rows[rowIndex - 1][9] || '0';

    Logger.success(`Payment updated for order #${orderNo}`);

    return {
      success: true,
      orderNo,
      customer,
      item,
      total
    };
  } catch (error) {
    Logger.error('updateOrderPaymentStatus failed', error);
    throw error;
  }
}

async function updateOrderDeliveryStatus(orderNo) {
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

    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!H${rowIndex}`, [['ส่งเสร็จแล้ว']]);

    const customer = rows[rowIndex - 1][2] || 'ลูกค้า';
    const item = rows[rowIndex - 1][3] || '';
    const delivery = rows[rowIndex - 1][6] || '';

    Logger.success(`Delivery updated for order #${orderNo}`);

    return {
      success: true,
      orderNo,
      customer,
      item,
      delivery
    };
  } catch (error) {
    Logger.error('updateOrderDeliveryStatus failed', error);
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
  updateStock
};
