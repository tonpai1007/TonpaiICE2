// stockAdjustment.js - FIXED: Safe mutex implementation with timeout
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { getSheetData, updateSheetData, appendSheetData } = require('./googleServices');
const { getStockCache, loadStockCache } = require('./cacheManager');

// ============================================================================
// SAFE MUTEX LOCK - WITH TIMEOUT & AUTO-RELEASE
// ============================================================================

class SafeMutex {
  constructor(name = 'mutex', timeoutMs = 5000) {
    this.name = name;
    this.locked = false;
    this.timeoutMs = timeoutMs;
    this.lockTimer = null;
  }

  async acquire() {
    let attempts = 0;
    const maxAttempts = 50;
    
    while (this.locked && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }
    
    if (this.locked) {
      throw new Error(`⏱️ ${this.name}: Failed to acquire lock after ${attempts * 100}ms`);
    }
    
    this.locked = true;
    
    // Auto-release after timeout (safety mechanism)
    this.lockTimer = setTimeout(() => {
      if (this.locked) {
        Logger.error(`🚨 ${this.name}: Auto-releasing stuck lock!`);
        this.release();
      }
    }, this.timeoutMs);
    
    Logger.debug(`🔒 ${this.name}: Lock acquired`);
  }

  release() {
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
    this.locked = false;
    Logger.debug(`🔓 ${this.name}: Lock released`);
  }

  async executeWithLock(fn) {
    try {
      await this.acquire();
      return await fn();
    } finally {
      this.release();
    }
  }
}

const adjustmentMutex = new SafeMutex('StockAdjustment', 10000);

// ============================================================================
// PARSE ADJUSTMENT COMMAND
// ============================================================================

async function parseAdjustmentCommand(text) {
  const patterns = [
    { regex: /(?:เติม|เพิ่ม)\s*(.+?)\s*(\d+)/i, operation: 'add' },
    { regex: /(?:ลด|ตัด|หัก)\s*(.+?)\s*(\d+)/i, operation: 'subtract' },
    { regex: /ปรับ\s*(.+?)\s*เหลือ\s*(\d+)/i, operation: 'set' },
    { regex: /(.+?)\s*เหลือ\s*(\d+)/i, operation: 'set' },
    { regex: /(.+?)\s*มี\s*(\d+)/i, operation: 'set' },
    { regex: /ปรับ(?:สต็อก)?\s*(.+?)\s*(\d+)/i, operation: 'set' }
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) {
      let itemName = match[1].trim();
      
      // Auto-complete common shortcuts
      if (itemName === 'แข็ง' || itemName === 'เเข็ง') {
        itemName = 'น้ำแข็ง';
      }
      
      return {
        isAdjustment: true,
        item: itemName,
        value: parseInt(match[2]),
        operation: pattern.operation,
        originalText: text
      };
    }
  }

  return { isAdjustment: false };
}

// ============================================================================
// IMPROVED ITEM MATCHING
// ============================================================================

function findBestStockMatch(itemName, stockCache) {
  const searchTerm = itemName.toLowerCase().trim();
  
  // Priority 1: EXACT match
  let matches = stockCache.filter(i => 
    i.item.toLowerCase() === searchTerm
  );
  
  if (matches.length === 1) {
    return { item: matches[0], confidence: 'exact', ambiguous: false };
  }
  
  // Priority 2: STARTS WITH
  matches = stockCache.filter(i => 
    i.item.toLowerCase().startsWith(searchTerm)
  );
  
  if (matches.length === 1) {
    return { item: matches[0], confidence: 'high', ambiguous: false };
  } else if (matches.length > 1) {
    return { 
      item: null, 
      confidence: 'low', 
      ambiguous: true,
      suggestions: matches.slice(0, 5)
    };
  }
  
  // Priority 3: CONTAINS
  matches = stockCache.filter(i => 
    i.item.toLowerCase().includes(searchTerm)
  );
  
  if (matches.length === 1) {
    return { item: matches[0], confidence: 'medium', ambiguous: false };
  } else if (matches.length > 1) {
    return { 
      item: null, 
      confidence: 'low', 
      ambiguous: true,
      suggestions: matches.slice(0, 5)
    };
  }
  
  // Priority 4: FUZZY
  const normalized = searchTerm.replace(/[^\u0E00-\u0E7F0-9a-z]/g, '');
  matches = stockCache.filter(i => {
    const itemNormalized = i.item.toLowerCase().replace(/[^\u0E00-\u0E7F0-9a-z]/g, '');
    return itemNormalized.includes(normalized) || normalized.includes(itemNormalized);
  });
  
  if (matches.length === 1) {
    return { item: matches[0], confidence: 'fuzzy', ambiguous: false };
  } else if (matches.length > 1) {
    return { 
      item: null, 
      confidence: 'low', 
      ambiguous: true,
      suggestions: matches.slice(0, 5)
    };
  }
  
  return { item: null, confidence: 'none', ambiguous: false };
}

// ============================================================================
// ADJUST STOCK - WITH SAFE MUTEX
// ============================================================================

async function adjustStock(itemName, value, operation = 'set', reason = 'manual') {
  return adjustmentMutex.executeWithLock(async () => {
    try {
      Logger.info(`🔧 Stock adjustment: ${itemName} ${operation} ${value}`);

      // Validate value
      if (value < 0) {
        return { success: false, error: '❌ จำนวนต้องเป็นบวก' };
      }
      
      if (value > 100000) {
        return { success: false, error: '❌ จำนวนสูงเกินไป (max: 100,000)' };
      }

      // Find item
      const stockCache = getStockCache();
      const matchResult = findBestStockMatch(itemName, stockCache);
      
      if (!matchResult.item) {
        if (matchResult.ambiguous) {
          const suggestions = matchResult.suggestions
            .map(i => `• ${i.item} (${i.stock} ${i.unit})`)
            .join('\n');
          
          return { 
            success: false, 
            error: `❓ พบหลายรายการ "${itemName}":\n\n${suggestions}\n\n💡 กรุณาระบุชื่อให้ชัดเจนขึ้น`
          };
        } else {
          const suggestions = stockCache
            .filter(i => i.item.toLowerCase().includes(itemName.substring(0, 3)))
            .slice(0, 5)
            .map(i => i.item)
            .join(', ');
          
          return { 
            success: false, 
            error: `❌ ไม่พบสินค้า: "${itemName}"\n\n` +
                   (suggestions ? `💡 สินค้าที่คล้ายกัน: ${suggestions}\n\n` : '') +
                   `พิมพ์ "สต็อก" เพื่อดูรายการทั้งหมด`
          };
        }
      }

      const item = matchResult.item;
      const oldStock = item.stock;
      let newStock = oldStock;

      // Calculate new stock
      switch (operation) {
        case 'add':
          newStock = oldStock + value;
          break;
        case 'subtract':
          newStock = oldStock - value;
          if (newStock < 0) {
            return { 
              success: false, 
              error: `❌ สต็อกไม่พอลด\n\n` +
                     `มีอยู่: ${oldStock} ${item.unit}\n` +
                     `ต้องการลด: ${value} ${item.unit}\n` +
                     `ผลลัพธ์: ${newStock} (ติดลบ!)`
            };
          }
          break;
        case 'set':
          if (value < 0) {
            return { 
              success: false, 
              error: '❌ ไม่สามารถตั้งค่าเป็นจำนวนติดลบได้' 
            };
          }
          newStock = value;
          break;
      }

      const difference = newStock - oldStock;

      // Update Google Sheets
      const rows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
      let rowIndex = -1;

      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0].toLowerCase() === item.item.toLowerCase()) {
          rowIndex = i + 1;
          break;
        }
      }

      if (rowIndex === -1) {
        return { success: false, error: '❌ ไม่พบสินค้าในระบบ (cache mismatch)' };
      }

      // Update sheet
      await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${rowIndex}`, [[newStock]]);

      // Log variance
      const logSuccess = await logVariance(
        item.item, 
        oldStock, 
        newStock, 
        difference, 
        reason, 
        operation
      );
      
      if (!logSuccess) {
        Logger.warn('⚠️ VarianceLog failed, but stock updated successfully');
      }

      // Reload cache
      await loadStockCache(true);

      Logger.success(`✅ Stock adjusted: ${item.item} (${oldStock} → ${newStock}, ${difference >= 0 ? '+' : ''}${difference})`);

      return {
        success: true,
        item: item.item,
        unit: item.unit,
        oldStock,
        newStock,
        difference,
        operation,
        operationText: getOperationText(operation, value),
        matchConfidence: matchResult.confidence,
        varianceLogged: logSuccess
      };

    } catch (error) {
      Logger.error('❌ adjustStock failed', error);
      throw error; // Re-throw to be caught by mutex handler
    }
  }).catch(error => {
    // Catch any errors (including lock timeout)
    Logger.error('Stock adjustment error', error);
    return { 
      success: false, 
      error: `❌ เกิดข้อผิดพลาด: ${error.message}`
    };
  });
}

// ============================================================================
// LOG VARIANCE
// ============================================================================

async function logVariance(item, oldStock, newStock, difference, reason, operation = 'set') {
  try {
    const reasonText = getReasonText(reason, operation);
    
    const row = [
      getThaiDateTimeString(),
      item,
      oldStock,
      newStock,
      difference,
      reasonText
    ];

    await appendSheetData(CONFIG.SHEET_ID, 'VarianceLog!A:F', [row]);
    Logger.success(`📊 VarianceLog saved: ${item} (${difference >= 0 ? '+' : ''}${difference})`);
    
    return true;
  } catch (error) {
    Logger.error('❌ logVariance failed', error);
    
    try {
      const { pushToAdmin } = require('./app');
      await pushToAdmin(
        `⚠️ VarianceLog Failed\n\n` +
        `Item: ${item}\n` +
        `Change: ${oldStock} → ${newStock}\n` +
        `Error: ${error.message}`
      );
    } catch (notifyError) {
      Logger.error('Failed to notify admin', notifyError);
    }
    
    return false;
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getOperationText(operation, value) {
  switch (operation) {
    case 'add': return `เติม +${value}`;
    case 'subtract': return `ลด -${value}`;
    case 'set': return `ตั้งค่าเป็น ${value}`;
    default: return `ปรับเป็น ${value}`;
  }
}

function getReasonText(reason, operation) {
  const operationMap = {
    'add': 'เติมสต็อก',
    'subtract': 'ลดสต็อก',
    'set': 'ปรับสต็อก'
  };

  const reasonMap = {
    'manual': 'ปรับด้วยมือ',
    'manual_adjustment': 'ปรับด้วยมือ',
    'voice_adjustment': 'ปรับผ่านเสียง',
    'text_adjustment': 'ปรับผ่านข้อความ',
    'restock': 'เติมสินค้า',
    'damage': 'สินค้าเสียหาย',
    'loss': 'สินค้าสูญหาย',
    'inventory_check': 'ตรวจนับสต็อก'
  };

  const opText = operationMap[operation] || 'ปรับสต็อก';
  const reasonText = reasonMap[reason] || reason;
  
  return `${opText} (${reasonText})`;
}

// ============================================================================
// VIEW CURRENT STOCK
// ============================================================================

async function viewCurrentStock(searchTerm = null) {
  try {
    const stockCache = getStockCache();
    
    if (stockCache.length === 0) {
      return '❌ ไม่มีข้อมูลสต็อก\n\n💡 กรุณารีเฟรช: พิมพ์ "รีเฟรช"';
    }

    let items = stockCache;
    
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      items = stockCache.filter(item => 
        item.item.toLowerCase().includes(term) ||
        item.category.toLowerCase().includes(term)
      );
      
      if (items.length === 0) {
        return `❌ ไม่พบสินค้า "${searchTerm}"\n\n💡 ลองค้นหาด้วยชื่ออื่น`;
      }
    }

    const displayItems = items.slice(0, 20);
    
    let report = `📦 สต็อกสินค้า\n${'='.repeat(40)}\n\n`;
    
    displayItems.forEach(item => {
      const stockIcon = item.stock === 0 ? '🔴' : item.stock < 10 ? '🟡' : '🟢';
      report += `${stockIcon} ${item.item}\n`;
      report += `   ${item.stock} ${item.unit} │ ${item.price}฿ │ ${item.category}\n\n`;
    });

    if (items.length > 20) {
      report += `... และอีก ${items.length - 20} รายการ\n\n`;
    }

    report += `รวม: ${items.length} รายการ`;

    return report;

  } catch (error) {
    Logger.error('❌ viewCurrentStock failed', error);
    return `❌ ไม่สามารถดูสต็อกได้\n\n${error.message}`;
  }
}

// ============================================================================
// GENERATE VARIANCE REPORT
// ============================================================================

async function generateVarianceReport(period = 'today') {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'VarianceLog!A:F');
    
    if (rows.length <= 1) {
      return '📊 ยังไม่มีการปรับสต็อก\n\n💡 ลองใช้คำสั่ง:\n• "เติมน้ำแข็ง 20"\n• "ลดน้ำแข็ง 10"\n• "น้ำแข็ง มี 50"';
    }

    const today = new Date().toLocaleDateString('en-CA');
    const variances = rows.slice(1)
      .filter(row => {
        if (period === 'today') {
          const rowDate = row[0].split(' ')[0];
          return rowDate === today;
        }
        return true;
      })
      .map(row => ({
        date: row[0],
        item: row[1],
        oldStock: parseInt(row[2] || 0),
        newStock: parseInt(row[3] || 0),
        difference: parseInt(row[4] || 0),
        reason: row[5] || '-'
      }));

    if (variances.length === 0) {
      return `📊 ไม่มีการปรับสต็อกวันนี้ (${today})\n\n✅ สต็อกไม่มีการเปลี่ยนแปลง`;
    }

    let report = `📊 รายงานการปรับสต็อก\n${'='.repeat(40)}\n`;
    report += period === 'today' ? `📅 วันนี้ (${today})\n\n` : `📅 ทั้งหมด\n\n`;
    
    const itemMap = new Map();
    variances.forEach(v => {
      if (!itemMap.has(v.item)) {
        itemMap.set(v.item, []);
      }
      itemMap.get(v.item).push(v);
    });

    itemMap.forEach((changes, itemName) => {
      const totalDiff = changes.reduce((sum, c) => sum + c.difference, 0);
      const icon = totalDiff === 0 ? '➖' : totalDiff > 0 ? '📈' : '📉';
      
      report += `${icon} **${itemName}**\n`;
      
      changes.forEach(v => {
        const time = v.date.split(' ')[1];
        const sign = v.difference >= 0 ? '+' : '';
        report += `   ${time} │ ${v.oldStock} → ${v.newStock} (${sign}${v.difference})\n`;
        report += `   └─ ${v.reason}\n`;
      });
      
      report += `\n`;
    });

    const totalAdjustments = variances.length;
    const totalIncrease = variances.filter(v => v.difference > 0).length;
    const totalDecrease = variances.filter(v => v.difference < 0).length;

    report += `${'='.repeat(40)}\n`;
    report += `📊 สรุป: ${totalAdjustments} รายการ\n`;
    report += `   📈 เพิ่ม: ${totalIncrease} ครั้ง\n`;
    report += `   📉 ลด: ${totalDecrease} ครั้ง\n`;

    return report;

  } catch (error) {
    Logger.error('❌ generateVarianceReport failed', error);
    return `❌ ไม่สามารถสร้างรายงานได้\n\n${error.message}`;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  parseAdjustmentCommand,
  adjustStock,
  logVariance,
  generateVarianceReport,
  viewCurrentStock,
  findBestStockMatch,
  SafeMutex
};
