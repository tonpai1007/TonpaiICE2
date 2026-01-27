// orderService.js - FIXED: Better null safety and validation
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { getSheetData, appendSheetData, updateSheetData } = require('./googleServices');
const { loadStockCache } = require('./cacheManager');
const { createCreditEntry, markCreditAsPaid } = require('./creditService');

// ============================================================================
// IMPROVED LOCK SYSTEM - With null safety
// ============================================================================

class StockTransactionLock {
  constructor() {
    this.locks = new Map();
    this.timeout = 10000;
    this.maxLocks = 100;
    this.stats = {
      currentLocks: 0,
      totalTimeouts: 0,
      totalAcquired: 0
    };
    
    setInterval(() => this.forceCleanup(), 15000);
  }

  // ✅ FIX: Add null safety and validation
  static generateKey(productName, unit) {
    if (!productName) {
      Logger.error('generateKey called with undefined productName');
      throw new Error('Product name is required for lock key');
    }
    
    const name = String(productName).toLowerCase().trim().replace(/\s+/g, '_');
    const unitNorm = unit ? String(unit).toLowerCase().trim() : 'unit';
    
    return `${name}|${unitNorm}`;
  }

  async acquireLock(productKey) {
    this.stats.totalAcquired++;
    
    if (this.locks.size >= this.maxLocks) {
      Logger.warn(`⚠️ Lock capacity reached (${this.maxLocks}), forcing cleanup`);
      this.forceCleanup();
    }

    if (this.locks.has(productKey)) {
      const lock = this.locks.get(productKey);
      
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this.stats.totalTimeouts++;
          Logger.error(`❌ Lock timeout for ${productKey}`);
          this.releaseLock(productKey);
          reject(new Error(`Lock timeout for ${productKey} after ${this.timeout}ms`));
        }, this.timeout);
        
        lock.queue.push(() => {
          clearTimeout(timeoutId);
          resolve();
        });
      });
    }
    
    this.locks.set(productKey, {
      locked: true,
      queue: [],
      acquiredAt: Date.now()
    });
    
    this.stats.currentLocks = this.locks.size;
  }

  releaseLock(productKey) {
    const lock = this.locks.get(productKey);
    if (!lock) return;
    
    if (lock.queue.length > 0) {
      const next = lock.queue.shift();
      next();
    } else {
      this.locks.delete(productKey);
      this.stats.currentLocks = this.locks.size;
    }
  }

  forceCleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, lock] of this.locks.entries()) {
      if (now - lock.acquiredAt > this.timeout) {
        this.locks.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      Logger.info(`🧹 Cleaned ${cleaned} stale locks`);
      this.stats.currentLocks = this.locks.size;
    }
  }

  getStats() {
    return {
      ...this.stats,
      activeKeys: this.locks.size
    };
  }
}

const stockLock = new StockTransactionLock();

// ============================================================================
// VALIDATE ORDER DATA
// ============================================================================

function validateOrderData(orderData) {
  const errors = [];
  
  if (!orderData) {
    errors.push('Order data is null or undefined');
    return { valid: false, errors };
  }
  
  if (!orderData.customer || typeof orderData.customer !== 'string') {
    errors.push('Customer name is required');
  }
  
  if (!orderData.items || !Array.isArray(orderData.items)) {
    errors.push('Items array is required');
  } else if (orderData.items.length === 0) {
    errors.push('At least one item is required');
  } else {
    // Validate each item
    orderData.items.forEach((item, idx) => {
      if (!item.stockItem) {
        errors.push(`Item ${idx}: Missing stockItem`);
      } else {
        if (!item.stockItem.item) {
          errors.push(`Item ${idx}: Missing product name`);
        }
        if (typeof item.stockItem.price !== 'number') {
          errors.push(`Item ${idx}: Invalid price`);
        }
        if (!item.quantity || item.quantity <= 0) {
          errors.push(`Item ${idx}: Invalid quantity`);
        }
      }
    });
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

// ============================================================================
// SIMPLIFIED ORDER CREATION - With validation
// ============================================================================

async function createOrderTransaction(orderData) {
  // ✅ FIX: Validate input first
  const validation = validateOrderData(orderData);
  
  if (!validation.valid) {
    Logger.error('Order validation failed:', validation.errors);
    return {
      success: false,
      error: 'ข้อมูลไม่ถูกต้อง: ' + validation.errors.join(', ')
    };
  }
  
  const { customer, items, deliveryPerson = '', paymentStatus = 'unpaid' } = orderData;
  
  // ✅ FIX: Generate lock keys with explicit null checks
  const lockKeys = [];
  
  try {
    for (const item of items) {
      if (!item.stockItem || !item.stockItem.item) {
        throw new Error(`Invalid item: missing stockItem or item name`);
      }
      
      const key = StockTransactionLock.generateKey(
        item.stockItem.item, 
        item.stockItem.unit
      );
      lockKeys.push(key);
    }
  } catch (error) {
    Logger.error('Failed to generate lock keys', error);
    return {
      success: false,
      error: 'ไม่สามารถสร้าง lock keys: ' + error.message
    };
  }
  
  const startTime = Date.now();
  
  try {
    // ========================================================================
    // ACQUIRE LOCKS
    // ========================================================================
    
    Logger.info(`🔒 Acquiring ${lockKeys.length} locks...`);
    
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
      const productName = stockRows[i][0];
      const unit = stockRows[i][3];
      
      // ✅ FIX: Skip invalid rows
      if (!productName) {
        Logger.warn(`Skipping stock row ${i + 1} - missing product name`);
        continue;
      }
      
      const key = StockTransactionLock.generateKey(productName, unit);
      stockMap.set(key, {
        stock: parseInt(stockRows[i][4] || 0),
        rowIndex: i + 1,
        name: productName,
        price: parseFloat(stockRows[i][2] || 0),
        unit: unit || 'ชิ้น'
      });
    }

    // ========================================================================
    // VERIFY STOCK
    // ========================================================================
    
    const insufficient = [];
    
    for (const item of items) {
      const key = StockTransactionLock.generateKey(
        item.stockItem.item, 
        item.stockItem.unit
      );
      
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
      const key = StockTransactionLock.generateKey(
        item.stockItem.item, 
        item.stockItem.unit
      );
      
      const stockInfo = stockMap.get(key);
      const newStock = stockInfo.stock - item.quantity;
      
      // Update stock
      await updateSheetData(
        CONFIG.SHEET_ID, 
        `สต็อก!E${stockInfo.rowIndex}`, 
        [[newStock]]
      );
      
      // Create order row
      rowsToAdd.push([
        orderNo,                          // A - Order number
        timestamp,                        // B - Date/time
        customer,                         // C - Customer
        stockInfo.name,                   // D - Product
        item.quantity,                    // E - Quantity
        '',                               // F - Notes
        deliveryPerson,                   // G - Delivery person
        paymentText,                      // H - Payment status
        item.quantity * stockInfo.price   // I - Amount
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
        unit: item.stockItem.unit || 'ชิ้น',
        unitPrice: item.stockItem.price,
        lineTotal: rowsToAdd[idx][8],
        stockItem: item.stockItem,
        newStock: stockMap.get(
          StockTransactionLock.generateKey(item.stockItem.item, item.stockItem.unit)
        ).stock - item.quantity
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
      await updateSheetData(
        CONFIG.SHEET_ID, 
        `คำสั่งซื้อ!H${orderRow.index}`, 
        [[newStatus]]
      );
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