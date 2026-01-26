// orderService.js - FIXED: Better lock handling with cleanup
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { getSheetData, appendSheetData, updateSheetData } = require('./googleServices');
const { loadStockCache } = require('./cacheManager');
const { createCreditEntry, markCreditAsPaid } = require('./creditService');

// ============================================================================
// IMPROVED LOCK SYSTEM - With auto-cleanup and better key generation
// ============================================================================

class StockTransactionLock {
  constructor() {
    this.locks = new Map();
    this.timeout = 10000; // Reduced to 10s (from 30s)
    this.maxLocks = 100; // Prevent memory leak
    
    // Auto-cleanup every 15 seconds
    setInterval(() => this.forceCleanup(), 15000);
  }

  // Generate better key - normalize product names
  static generateKey(productName, unit) {
    const name = productName.toLowerCase().trim().replace(/\s+/g, '_');
    const unitNorm = (unit || 'unit').toLowerCase().trim();
    return `${name}|${unitNorm}`;
  }

  async acquireLock(productKey) {
    // Check if at max capacity
    if (this.locks.size >= this.maxLocks) {
      Logger.warn(`⚠️ Lock capacity reached (${this.maxLocks}), forcing cleanup`);
      this.forceCleanup();
    }

    // If already locked, wait in queue
    if (this.locks.has(productKey)) {
      const lock = this.locks.get(productKey);
      
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          Logger.error(`❌ Lock timeout for ${productKey}`);
          
          // Force release on timeout
          this.releaseLock(productKey);
          
          reject(new Error(`Lock timeout for ${productKey} after ${this.timeout}ms`));
        }, this.timeout);
        
        lock.queue.push(() => {
          clearTimeout(timeoutId);
          resolve();
        });
      });
    }
    
    // Create new lock
    this.locks.set(productKey, {
      locked: true,
      queue: [],
      acquiredAt: Date.now()
    });
  }

  releaseLock(productKey) {
    const lock = this.locks.get(productKey);
    if (!lock) return;
    
    // Process queue
    if (lock.queue.length > 0) {
      const next = lock.queue.shift();
      next();
    } else {
      this.locks.delete(productKey);
    }
  }

  forceCleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, lock] of this.locks.entries()) {
      // Remove locks older than timeout
      if (now - lock.acquiredAt > this.timeout) {
        this.locks.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      Logger.info(`🧹 Cleaned ${cleaned} stale locks`);
    }
  }
}

const stockLock = new StockTransactionLock();

// ============================================================================
// SIMPLIFIED ORDER CREATION - Reduced lock scope
// ============================================================================

async function createOrderTransaction(orderData) {
  const { customer, items, deliveryPerson = '', paymentStatus = 'unpaid' } = orderData;
  
  if (!customer || !items || items.length === 0) {
    return {
      success: false,
      error: 'ข้อมูลไม่ครบถ้วน'
    };
  }

  // Generate lock keys with normalized names
  const lockKeys = items.map(item => 
    StockTransactionLock.generateKey(item.stockItem.item, item.stockItem.unit)
  );
  
  const startTime = Date.now();
  
  try {
    // ========================================================================
    // ACQUIRE LOCKS
    // ========================================================================
    
    Logger.info(`🔒 Acquiring ${lockKeys.length} locks...`);
    
    // Acquire all locks with timeout protection
    await Promise.all(lockKeys.map(key => stockLock.acquireLock(key)));
    
    Logger.success(`✅ All locks acquired in ${Date.now() - startTime}ms`);
    
    // ========================================================================
    // READ FRESH DATA
    // ========================================================================
    
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    const orderNo = orderRows.length || 1;
    
    const stockRows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
    const stockMap = new Map();
    
    for (let i = 1; i < stockRows.length; i++) {
      const key = StockTransactionLock.generateKey(stockRows[i][0], stockRows[i][3]);
      stockMap.set(key, {
        stock: parseInt(stockRows[i][4] || 0),
        rowIndex: i + 1,
        name: stockRows[i][0],
        price: parseFloat(stockRows[i][2] || 0),
        unit: stockRows[i][3]
      });
    }

    // ========================================================================
    // VERIFY STOCK
    // ========================================================================
    
    const insufficient = [];
    
    for (const item of items) {
      const key = StockTransactionLock.generateKey(item.stockItem.item, item.stockItem.unit);
      const stockInfo = stockMap.get(key);
      
      if (!stockInfo) {
        throw new Error(`ไม่พบสินค้า: ${item.stockItem.item}`);
      }
      
      if (stockInfo.stock < item.quantity) {
        insufficient.push({
          name: item.stockItem.item,
          available: stockInfo.stock,
          requested: item.quantity
        });
      }
    }
    
    if (insufficient.length > 0) {
      let msg = '❌ สต็อกไม่พอ:\n';
      insufficient.forEach(i => {
        msg += `• ${i.name}: มี ${i.available} ต้องการ ${i.requested}\n`;
      });
      throw new Error(msg);
    }

    // ========================================================================
    // UPDATE STOCK & CREATE ORDERS
    // ========================================================================
    
    const timestamp = getThaiDateTimeString();
    const paymentText = paymentStatus === 'paid' ? 'จ่ายแล้ว' : 'ยังไม่จ่าย';
    const rowsToAdd = [];
    
    for (const item of items) {
      const key = StockTransactionLock.generateKey(item.stockItem.item, item.stockItem.unit);
      const stockInfo = stockMap.get(key);
      const newStock = stockInfo.stock - item.quantity;
      
      // Update stock
      await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${stockInfo.rowIndex}`, [[newStock]]);
      
      // Create order row
      rowsToAdd.push([
        orderNo,
        timestamp,
        customer,
        stockInfo.name,
        item.quantity,
        '',
        deliveryPerson,
        paymentText,
        item.quantity * stockInfo.price
      ]);
    }
    
    // Add all orders
    await appendSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I', rowsToAdd);
    
    // Reload cache
    await loadStockCache(true);

    // ========================================================================
    // BUILD RESULT
    // ========================================================================
    
    const totalAmount = rowsToAdd.reduce((sum, row) => sum + row[8], 0);
    
    const result = {
      success: true,
      orderNo,
      customer,
      totalAmount,
      paymentStatus,
      deliveryPerson,
      processingTime: Date.now() - startTime,
      items: items.map((item, idx) => ({
        productName: rowsToAdd[idx][3],
        quantity: item.quantity,
        unit: item.stockItem.unit,
        unitPrice: item.stockItem.price,
        lineTotal: rowsToAdd[idx][8],
        stockItem: item.stockItem
      }))
    };
    
    // Auto-create credit if unpaid
    if (paymentStatus !== 'paid') {
      try {
        await createCreditEntry(result);
      } catch (err) {
        Logger.error('Credit creation failed (non-fatal)', err);
      }
    }
    
    Logger.success(`✅ Order #${orderNo} completed in ${result.processingTime}ms`);

    return result;

  } catch (error) {
    Logger.error(`❌ Order creation failed:`, error);
    
    return {
      success: false,
      error: error.message || 'ไม่สามารถสร้างออเดอร์ได้'
    };
    
  } finally {
    // ALWAYS RELEASE LOCKS
    lockKeys.forEach(key => stockLock.releaseLock(key));
    Logger.info(`🔓 Released ${lockKeys.length} locks`);
  }
}

// ============================================================================
// OTHER FUNCTIONS (unchanged)
// ============================================================================

async function updateOrderPaymentStatus(orderNo, newStatus = 'จ่ายแล้ว') {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    const orderRows = [];
    let customer = '';
    let totalAmount = 0;
    
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] == orderNo) {
        orderRows.push({ index: i + 1, data: rows[i] });
        customer = rows[i][2];
        totalAmount += parseFloat(rows[i][8] || 0);
      }
    }

    if (orderRows.length === 0) {
      return { success: false, error: `ไม่พบออเดอร์ #${orderNo}` };
    }

    for (const orderRow of orderRows) {
      await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!H${orderRow.index}`, [[newStatus]]);
    }
    
    if (newStatus === 'จ่ายแล้ว') {
      await markCreditAsPaid(orderNo);
    }

    return { success: true, orderNo, customer, totalAmount, newStatus };
    
  } catch (error) {
    Logger.error('updateOrderPaymentStatus failed', error);
    return { success: false, error: error.message };
  }
}

async function getLastOrderNumber() {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    if (rows.length <= 1) return null;
    return rows[rows.length - 1][0];
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
  stockLock
};
