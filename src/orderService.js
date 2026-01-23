// orderService.js - FIXED: Race condition prevention + Auto credit entry

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString, extractGregorianDate } = require('./utils');
const { getSheetData, appendSheetData, updateSheetData } = require('./googleServices');
const { loadStockCache } = require('./cacheManager');

// Import credit service
const { createCreditEntry, markCreditAsPaid } = require('./creditService');

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
  DELIVERY: 6,      // G - ผู้ส่ง
  PAYMENT: 7,       // H - จ่ายแล้วหรือยัง
  AMOUNT: 8         // I - ยอดเงิน
};

// ============================================================================
// TRANSACTION LOCK SYSTEM - Prevents race conditions
// ============================================================================

class StockTransactionLock {
  constructor() {
    this.locks = new Map(); // productKey -> { locked, queue, acquiredAt }
    this.timeout = 30000; // 30 seconds max lock
    this.stats = {
      totalAcquired: 0,
      totalReleased: 0,
      totalTimeouts: 0,
      currentLocks: 0
    };
  }

  async acquireLock(productKey) {
    this.stats.totalAcquired++;
    
    // If already locked, wait in queue
    if (this.locks.has(productKey)) {
      const lock = this.locks.get(productKey);
      
      Logger.debug(`⏳ Waiting for lock: ${productKey} (${lock.queue.length} in queue)`);
      
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.stats.totalTimeouts++;
          Logger.error(`❌ Lock timeout: ${productKey}`);
          reject(new Error(`Lock timeout for ${productKey} after ${this.timeout}ms`));
        }, this.timeout);
        
        lock.queue.push(() => {
          clearTimeout(timeoutId);
          Logger.debug(`✅ Lock acquired from queue: ${productKey}`);
          resolve();
        });
      });
    }
    
    // Create new lock
    this.locks.set(productKey, {
      locked: true,
      queue: [],
      acquiredAt: Date.now(),
      acquiredBy: new Error().stack.split('\n')[2] // For debugging
    });
    
    this.stats.currentLocks = this.locks.size;
    Logger.debug(`🔒 New lock created: ${productKey}`);
  }

  releaseLock(productKey) {
    const lock = this.locks.get(productKey);
    if (!lock) {
      Logger.warn(`⚠️ Attempted to release non-existent lock: ${productKey}`);
      return;
    }
    
    this.stats.totalReleased++;
    
    // Process queue
    if (lock.queue.length > 0) {
      const next = lock.queue.shift();
      Logger.debug(`📤 Passing lock to queued caller: ${productKey}`);
      next(); // Call next waiting function
    } else {
      this.locks.delete(productKey);
      this.stats.currentLocks = this.locks.size;
      Logger.debug(`🔓 Lock released: ${productKey}`);
    }
  }

  isLocked(productKey) {
    return this.locks.has(productKey);
  }

  // Cleanup stale locks (safety mechanism)
  cleanupStaleLocks() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, lock] of this.locks.entries()) {
      if (now - lock.acquiredAt > this.timeout) {
        Logger.warn(`⚠️ Cleaning stale lock: ${key} (held for ${now - lock.acquiredAt}ms)`);
        
        // Release all queued waiters with timeout error
        lock.queue.forEach(waiter => {
          try {
            waiter();
          } catch (e) {
            Logger.error('Error releasing queued waiter', e);
          }
        });
        
        this.locks.delete(key);
        cleaned++;
        this.stats.totalTimeouts++;
      }
    }
    
    if (cleaned > 0) {
      this.stats.currentLocks = this.locks.size;
      Logger.info(`🧹 Cleaned ${cleaned} stale locks`);
    }
  }

  getStats() {
    return {
      ...this.stats,
      activeLocks: Array.from(this.locks.keys()),
      queueLengths: Array.from(this.locks.values()).map(l => l.queue.length)
    };
  }
}

// Singleton instance
const stockLock = new StockTransactionLock();

// Cleanup stale locks every minute
setInterval(() => stockLock.cleanupStaleLocks(), 60000);

// ============================================================================
// CREATE ORDER WITH TRANSACTION LOCKING - COMPLETE REWRITE
// ============================================================================

async function createOrderTransaction(orderData) {
  const { customer, items, deliveryPerson = '', paymentStatus = 'unpaid' } = orderData;
  
  // Validation
  if (!customer || !items || !Array.isArray(items) || items.length === 0) {
    return {
      success: false,
      error: 'ข้อมูลไม่ครบถ้วน: ต้องมีลูกค้าและรายการสินค้า'
    };
  }

  // Generate product keys for locking
  const productKeys = items.map(item => 
    `${item.stockItem.item.toLowerCase().trim()}|${item.stockItem.unit.toLowerCase().trim()}`
  );
  
  const startTime = Date.now();
  
  try {
    // ========================================================================
    // PHASE 1: ACQUIRE ALL LOCKS (Prevents race conditions)
    // ========================================================================
    
    Logger.info(`🔒 Acquiring locks for ${productKeys.length} items...`);
    
    await Promise.all(productKeys.map(key => stockLock.acquireLock(key)));
    
    const lockTime = Date.now() - startTime;
    Logger.success(`✅ All locks acquired in ${lockTime}ms`);
    
    // ========================================================================
    // PHASE 2: READ FRESH DATA (Inside lock - guaranteed consistent)
    // ========================================================================
    
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    const orderNo = orderRows.length || 1;
    
    Logger.info(`📝 Creating order #${orderNo} for ${customer}`);
    
    // Get FRESH stock data
    const stockRows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
    const stockMap = new Map();
    
    for (let i = 1; i < stockRows.length; i++) {
      const name = (stockRows[i][0] || '').toLowerCase().trim();
      const unit = (stockRows[i][3] || '').toLowerCase().trim();
      const stock = parseInt(stockRows[i][4] || 0);
      const key = `${name}|${unit}`;
      
      stockMap.set(key, { 
        stock, 
        rowIndex: i + 1,
        name: stockRows[i][0], // Original name
        price: parseFloat(stockRows[i][2] || 0),
        cost: parseFloat(stockRows[i][1] || 0)
      });
    }

    // ========================================================================
    // PHASE 3: VERIFY STOCK AVAILABILITY (All or nothing)
    // ========================================================================
    
    const insufficientItems = [];
    
    for (const item of items) {
      const key = `${item.stockItem.item.toLowerCase().trim()}|${item.stockItem.unit.toLowerCase().trim()}`;
      const stockInfo = stockMap.get(key);
      
      if (!stockInfo) {
        throw new Error(`ไม่พบสินค้า: ${item.stockItem.item}`);
      }
      
      if (stockInfo.stock < item.quantity) {
        insufficientItems.push({
          name: item.stockItem.item,
          available: stockInfo.stock,
          requested: item.quantity,
          shortage: item.quantity - stockInfo.stock
        });
      }
    }
    
    // If ANY item is insufficient, abort entire transaction
    if (insufficientItems.length > 0) {
      let errorMsg = '❌ สต็อกไม่พอ:\n\n';
      
      insufficientItems.forEach(item => {
        errorMsg += `• ${item.name}\n`;
        errorMsg += `  มี ${item.available} ต้องการ ${item.requested}\n`;
        errorMsg += `  ขาด ${item.shortage}\n\n`;
      });
      
      errorMsg += '💡 อาจมีคนสั่งก่อนหน้านี้\nลองรีเฟรชแล้วเช็คใหม่';
      
      throw new Error(errorMsg);
    }

    // ========================================================================
    // PHASE 4: UPDATE STOCK ATOMICALLY (All items together)
    // ========================================================================
    
    const rowsToAdd = [];
    const timestamp = getThaiDateTimeString();
    const paymentText = paymentStatus === 'paid' ? 'จ่ายแล้ว' : 'ยังไม่จ่าย';
    const stockUpdates = [];
    
    for (const item of items) {
      const key = `${item.stockItem.item.toLowerCase().trim()}|${item.stockItem.unit.toLowerCase().trim()}`;
      const stockInfo = stockMap.get(key);
      const newStock = stockInfo.stock - item.quantity;
      
      // Prepare stock update
      stockUpdates.push({
        range: `สต็อก!E${stockInfo.rowIndex}`,
        newStock: newStock,
        oldStock: stockInfo.stock,
        item: stockInfo.name
      });
      
      // Create order row
      const row = [
        orderNo,                              // A - รหัส
        timestamp,                            // B - วันที่
        customer,                             // C - ลูกค้า
        stockInfo.name,                       // D - สินค้า (use original name)
        item.quantity,                        // E - จำนวน
        '',                                   // F - หมายเหตุ
        deliveryPerson,                       // G - ผู้ส่ง
        paymentText,                          // H - จ่ายแล้วหรือยัง
        item.quantity * stockInfo.price       // I - ยอดเงิน
      ];
      
      rowsToAdd.push(row);
    }
    
    // Execute all stock updates
    for (const update of stockUpdates) {
      await updateSheetData(CONFIG.SHEET_ID, update.range, [[update.newStock]]);
      Logger.success(`📦 ${update.item}: ${update.oldStock} → ${update.newStock}`);
    }

    // Add all order rows at once
    await appendSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I', rowsToAdd);
    
    // Reload cache
    await loadStockCache(true);

    // ========================================================================
    // PHASE 5: BUILD RESULT
    // ========================================================================
    
    const totalAmount = rowsToAdd.reduce((sum, row) => sum + row[COL.AMOUNT], 0);
    
    const result = {
      success: true,
      orderNo,
      customer,
      totalAmount,
      paymentStatus,
      deliveryPerson,
      processingTime: Date.now() - startTime,
      items: items.map((item, idx) => {
        const key = `${item.stockItem.item.toLowerCase().trim()}|${item.stockItem.unit.toLowerCase().trim()}`;
        const stockInfo = stockMap.get(key);
        
        return {
          productName: stockInfo.name,
          quantity: item.quantity,
          unit: item.stockItem.unit,
          unitPrice: stockInfo.price,
          lineTotal: rowsToAdd[idx][COL.AMOUNT],
          newStock: stockInfo.stock - item.quantity,
          stockItem: item.stockItem
        };
      })
    };
    
    // ========================================================================
    // PHASE 6: AUTO-CREATE CREDIT ENTRY IF UNPAID
    // ========================================================================
    
    if (paymentStatus !== 'paid') {
      try {
        await createCreditEntry(result);
        Logger.info(`💳 Credit entry auto-created for #${orderNo}`);
      } catch (creditError) {
        Logger.error('Credit entry creation failed (non-fatal)', creditError);
        // Don't fail the entire order
      }
    }
    
    Logger.success(`✅ Order #${orderNo} completed in ${result.processingTime}ms`);
    Logger.info(`   Customer: ${customer}`);
    Logger.info(`   Total: ${totalAmount}฿`);
    Logger.info(`   Payment: ${paymentStatus}`);
    Logger.info(`   Delivery: ${deliveryPerson || 'None'}`);

    return result;

  } catch (error) {
    const duration = Date.now() - startTime;
    Logger.error(`❌ Order creation failed after ${duration}ms`, error);
    
    return {
      success: false,
      error: error.message || '❌ ไม่สามารถสร้างออเดอร์ได้'
    };
    
  } finally {
    // ========================================================================
    // ALWAYS RELEASE LOCKS (Even on error)
    // ========================================================================
    
    productKeys.forEach(key => stockLock.releaseLock(key));
    
    const totalTime = Date.now() - startTime;
    Logger.info(`🔓 All locks released (total time: ${totalTime}ms)`);
  }
}

// ============================================================================
// UPDATE PAYMENT STATUS - WITH AUTO CREDIT UPDATE
// ============================================================================

async function updateOrderPaymentStatus(orderNo, newStatus = 'จ่ายแล้ว') {
  try {
    Logger.info(`💰 Updating payment for order #${orderNo} → ${newStatus}`);
    
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
      return { 
        success: false, 
        error: `ไม่พบออเดอร์ #${orderNo}` 
      };
    }

    // Update all rows (Column H - Payment)
    for (const orderRow of orderRows) {
      await updateSheetData(
        CONFIG.SHEET_ID, 
        `คำสั่งซื้อ!H${orderRow.index}`, 
        [[newStatus]]
      );
    }
    
    // Auto-update credit entry if paid
    if (newStatus === 'จ่ายแล้ว') {
      try {
        await markCreditAsPaid(orderNo);
        Logger.success(`💳 Credit entry marked as paid for #${orderNo}`);
      } catch (creditError) {
        Logger.error('Credit update failed (non-fatal)', creditError);
      }
    }
    
    Logger.success(`✅ Payment updated: #${orderNo} → ${newStatus}`);

    return {
      success: true,
      orderNo,
      customer,
      totalAmount,
      newStatus
    };
    
  } catch (error) {
    Logger.error('updateOrderPaymentStatus failed', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
}

// ============================================================================
// GET LAST ORDER NUMBER
// ============================================================================

async function getLastOrderNumber() {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    
    if (rows.length <= 1) {
      Logger.warn('No orders found');
      return null;
    }
    
    // Get the most recent order number (last row)
    const lastRow = rows[rows.length - 1];
    const orderNo = lastRow[COL.ORDER_NO];
    
    Logger.debug(`Last order number: ${orderNo}`);
    return orderNo;
    
  } catch (error) {
    Logger.error('getLastOrderNumber failed', error);
    return null;
  }
}

// ============================================================================
// HEALTH CHECK
// ============================================================================

function getOrderServiceHealth() {
  const lockStats = stockLock.getStats();
  
  return {
    status: lockStats.currentLocks === 0 ? 'healthy' : 'active',
    locks: lockStats,
    warnings: lockStats.totalTimeouts > 0 
      ? [`${lockStats.totalTimeouts} lock timeouts detected`] 
      : []
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  createOrderTransaction,
  createOrder: createOrderTransaction, // Alias
  updateOrderPaymentStatus,
  getLastOrderNumber,
  getOrderServiceHealth,
  stockLock, // Export for monitoring
  COL
};