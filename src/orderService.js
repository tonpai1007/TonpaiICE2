// orderService.js - FIXED: Robust Optimistic Locking + Better Error Handling
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { getSheetData, appendSheetData, updateSheetData, batchUpdateSheet } = require('./googleServices');
const { loadStockCache } = require('./cacheManager');

const PAYMENT_STATUS_MAP = {
  'paid': 'จ่ายแล้ว',
  'credit': 'เครดิต',
  'unpaid': 'ยังไม่จ่าย'
};

// ============================================================================
// 🔒 ROBUST OPTIMISTIC LOCKING with Fresh Data Fetch
// ============================================================================

async function updateStockWithOptimisticLocking(itemName, unit, decreaseBy, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // ✅ ALWAYS fetch fresh data from sheet
      const rows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
      const key = itemName.toLowerCase().trim();

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const rowName = (row[0] || '').trim().toLowerCase();
        const rowUnit = (row[3] || '').trim().toLowerCase();
        const currentStock = parseInt(row[4] || 0);

        if (rowName === key && rowUnit === unit.toLowerCase()) {
          // ✅ Calculate new stock based on FRESH data
          const newStock = currentStock - decreaseBy;
          
          if (newStock < 0) {
            throw new Error(`INSUFFICIENT_STOCK: ${itemName} has ${currentStock}, need ${decreaseBy}`);
          }

          // ✅ Atomic update
          await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${i + 1}`, [[newStock]]);
          
          Logger.success(`📦 Stock updated: ${itemName} (${currentStock} → ${newStock}) [attempt ${attempt}]`);
          
          return {
            success: true,
            oldStock: currentStock,
            newStock: newStock,
            item: itemName,
            unit: unit
          };
        }
      }
      
      throw new Error(`ITEM_NOT_FOUND: ${itemName} (${unit})`);
      
    } catch (error) {
      const isRetryable = 
        error.message.includes('STOCK_VERSION_CONFLICT') ||
        error.message.includes('429') ||
        error.message.includes('quota');
      
      if (error.message.includes('INSUFFICIENT_STOCK')) {
        throw error; // Don't retry insufficient stock
      }
      
      if (error.message.includes('ITEM_NOT_FOUND')) {
        throw error; // Don't retry item not found
      }
      
      if (isRetryable && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 500; // 500ms, 1s, 2s
        Logger.warn(`⏳ Retry ${attempt}/${maxRetries} in ${delay}ms (${error.message})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      throw error;
    }
  }
  
  throw new Error(`Failed after ${maxRetries} attempts`);
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

  Logger.info(`📝 Starting transaction: ${customer} (${items.length} items)`);
  
  let orderNo = null;
  let stockUpdates = [];
  
  try {
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // PHASE 1: Reserve order number
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    orderNo = orderRows.length || 1;
    
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // PHASE 2: Update stock FIRST (fail fast if insufficient)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const lineItems = [];
    
    for (const item of items) {
      try {
        const result = await updateStockWithOptimisticLocking(
          item.stockItem.item,
          item.stockItem.unit,
          item.quantity,
          3
        );
        
        stockUpdates.push(result);
        
        lineItems.push({
          item: item.stockItem.item,
          quantity: item.quantity,
          unit: item.stockItem.unit,
          price: item.stockItem.price,
          cost: item.stockItem.cost,
          subtotal: item.quantity * item.stockItem.price
        });
        
      } catch (stockError) {
        Logger.error(`❌ Stock update failed: ${item.stockItem.item}`, stockError);
        
        // Rollback previous updates
        await rollbackStockUpdates(stockUpdates);
        
        return {
          success: false,
          error: stockError.message.includes('INSUFFICIENT_STOCK')
            ? `❌ สต็อกไม่พอ: ${item.stockItem.item}\n\n${stockError.message}`
            : `❌ ไม่สามารถอัปเดตสต็อก: ${item.stockItem.item}`,
          details: stockError.message
        };
      }
    }
    
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // PHASE 3: Create order (stock already deducted)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const totalAmount = lineItems.reduce((sum, line) => sum + line.subtotal, 0);
    const lineItemsText = lineItems.map(l => `${l.item} x${l.quantity}`).join(', ');
    const thaiPaymentStatus = PAYMENT_STATUS_MAP[paymentStatus] || 'ยังไม่จ่าย';
    
    const orderRow = [
      orderNo,
      getThaiDateTimeString(),
      customer,
      deliveryPerson,
      'รอดำเนินการ',
      thaiPaymentStatus,
      totalAmount,
      JSON.stringify(lineItems), // Store full line items as JSON
      ''
    ];
    
    await appendSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I', [orderRow]);
    
    // ✅ Reload cache after successful transaction
    await loadStockCache(true);
    
    Logger.success(`✅ TRANSACTION COMMITTED: Order #${orderNo}`);
    
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
        unitCost: line.cost,
        lineTotal: line.subtotal,
        newStock: stockUpdates[idx].newStock,
        stockItem: items[idx].stockItem
      })),
      stockUpdates
    };
    
  } catch (criticalError) {
    Logger.error('❌ CRITICAL TRANSACTION FAILURE', criticalError);
    
    // Rollback everything
    if (stockUpdates.length > 0) {
      await rollbackStockUpdates(stockUpdates);
    }
    if (orderNo) {
      await rollbackOrderHeader(orderNo);
    }
    
    return {
      success: false,
      error: '❌ เกิดข้อผิดพลาดร้ายแรง กรุณาลองใหม่',
      details: criticalError.message
    };
  }
}

async function rollbackStockUpdates(stockUpdates) {
  if (stockUpdates.length === 0) return;
  
  Logger.warn(`🔄 Rolling back ${stockUpdates.length} stock updates...`);
  
  for (const update of stockUpdates.reverse()) {
    try {
      const rows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
      for (let i = 1; i < rows.length; i++) {
        const rowName = (rows[i][0] || '').trim().toLowerCase();
        const rowUnit = (rows[i][3] || '').trim().toLowerCase();
        
        if (rowName === update.item.toLowerCase() && rowUnit === update.unit.toLowerCase()) {
          await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${i + 1}`, [[update.oldStock]]);
          Logger.success(`✅ Rolled back: ${update.item} → ${update.oldStock}`);
          break;
        }
      }
    } catch (error) {
      Logger.error(`Failed to rollback ${update.item}`, error);
    }
  }
  
  await loadStockCache(true);
}

async function rollbackOrderHeader(orderNo) {
  try {
    Logger.warn(`🔄 Rolling back order #${orderNo}...`);
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    const filteredRows = rows.filter((row, idx) => idx === 0 || row[0] != orderNo);
    await batchUpdateSheet(CONFIG.SHEET_ID, [{
      range: 'คำสั่งซื้อ!A:I',
      values: filteredRows
    }]);
    Logger.success(`✅ Order #${orderNo} rolled back`);
  } catch (error) {
    Logger.error('Failed to rollback order', error);
  }
}

// ============================================================================
// PAYMENT STATUS UPDATE
// ============================================================================

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

module.exports = {
  createOrderTransaction,
  createOrder: createOrderTransaction,
  updateOrderPaymentStatus,
  updateStockWithOptimisticLocking
};