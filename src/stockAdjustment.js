// FIXED: stockAdjustment.js - Simplified voice-friendly version

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { getSheetData, updateSheetData, appendSheetData } = require('./googleServices');
const { getStockCache, loadStockCache } = require('./cacheManager');

// ============================================================================
// SIMPLE COMMAND PARSER (NO AI NEEDED)
// ============================================================================

async function parseAdjustmentCommand(text) {
  const stockCache = getStockCache();
  
  // Must have a number
  const numberMatch = text.match(/\d+/);
  if (!numberMatch) {
    return { isAdjustment: false, reason: 'no_number' };
  }
  
  const value = parseInt(numberMatch[0]);
  
  // Detect operation
  let operation = 'set'; // default
  const lower = text.toLowerCase();
  
  if (lower.includes('เติม') || lower.includes('เพิ่ม') || lower.includes('add')) {
    operation = 'add';
  } else if (lower.includes('ลด') || lower.includes('subtract')) {
    operation = 'subtract';
  } else if (lower.includes('มี') || lower.includes('เหลือ')) {
    operation = 'set';
  }
  
  // Extract product name (remove operation words and numbers)
  let productName = text
    .replace(/เติม|ลด|มี|เหลือ|ปรับ|เพิ่ม/gi, '')
    .replace(/\d+/g, '')
    .replace(/ถุง|ขวด|กล่อง|ชิ้น|ลัง/gi, '')
    .trim();
  
  if (!productName) {
    return { isAdjustment: false, reason: 'no_product_name' };
  }
  
  // Find matching product
  const lowerProduct = productName.toLowerCase();
  
  // Try exact match first
  let match = stockCache.find(item => 
    item.item.toLowerCase() === lowerProduct
  );
  
  // Try contains match
  if (!match) {
    const matches = stockCache.filter(item => 
      item.item.toLowerCase().includes(lowerProduct) ||
      lowerProduct.includes(item.item.toLowerCase())
    );
    
    if (matches.length === 1) {
      match = matches[0];
    } else if (matches.length > 1) {
      // Multiple matches - return suggestions
      return {
        isAdjustment: true,
        ambiguous: true,
        suggestions: matches,
        value: value,
        operation: operation
      };
    }
  }
  
  if (!match) {
    return { isAdjustment: false, reason: 'product_not_found' };
  }
  
  return {
    isAdjustment: true,
    item: match.item,
    stockItem: match,
    value: value,
    operation: operation,
    originalText: text,
    confidence: 'high'
  };
}

// ============================================================================
// ADJUST STOCK - SIMPLIFIED
// ============================================================================

async function adjustStock(itemName, value, operation = 'set', reason = 'manual') {
  try {
    Logger.info(`🔧 Adjusting: ${itemName} ${operation} ${value}`);
    
    // Validate
    if (value < 0 || value > 100000) {
      return { 
        success: false, 
        error: '❌ จำนวนไม่ถูกต้อง (0-100,000)' 
      };
    }
    
    // Find item in cache
    const stockCache = getStockCache();
    const item = stockCache.find(i => 
      i.item.toLowerCase() === itemName.toLowerCase()
    );
    
    if (!item) {
      return { 
        success: false, 
        error: `❌ ไม่พบสินค้า: ${itemName}` 
      };
    }
    
    // Calculate new stock
    const oldStock = item.stock;
    let newStock;
    
    switch (operation) {
      case 'add':
        newStock = oldStock + value;
        break;
      case 'subtract':
        newStock = oldStock - value;
        if (newStock < 0) {
          return {
            success: false,
            error: `❌ สต็อกไม่พอลด\n\nมี: ${oldStock}\nต้องการลด: ${value}\nขาด: ${Math.abs(newStock)}`
          };
        }
        break;
      case 'set':
        newStock = value;
        break;
      default:
        return { success: false, error: '❌ คำสั่งไม่ถูกต้อง' };
    }
    
    const difference = newStock - oldStock;
    
    // Update in Google Sheets
    const rows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
    let rowIndex = -1;
    
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0].toLowerCase() === item.item.toLowerCase()) {
        rowIndex = i + 1; // +1 because sheets are 1-indexed
        break;
      }
    }
    
    if (rowIndex === -1) {
      return { 
        success: false, 
        error: '❌ ไม่พบสินค้าในระบบ' 
      };
    }
    
    // Update the stock value
    await updateSheetData(
      CONFIG.SHEET_ID, 
      `สต็อก!E${rowIndex}`, 
      [[newStock]]
    );
    
    // Log to variance
    await logVariance(item.item, oldStock, newStock, difference, reason, operation);
    
    // Reload cache
    await loadStockCache(true);
    
    Logger.success(`✅ Updated: ${item.item} (${oldStock} → ${newStock})`);
    
    return {
      success: true,
      item: item.item,
      unit: item.unit,
      oldStock: oldStock,
      newStock: newStock,
      difference: difference,
      operation: operation,
      operationText: getOperationText(operation, value)
    };
    
  } catch (error) {
    Logger.error('adjustStock failed', error);
    return {
      success: false,
      error: `❌ เกิดข้อผิดพลาด: ${error.message}`
    };
  }
}

// ============================================================================
// LOG VARIANCE
// ============================================================================

async function logVariance(item, oldStock, newStock, difference, reason, operation) {
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
    Logger.success(`📊 Logged variance: ${item} (${difference >= 0 ? '+' : ''}${difference})`);
    
    return true;
  } catch (error) {
    Logger.error('logVariance failed', error);
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
    'loss': 'สินค้าสูญหาย'
  };
  
  const opText = operationMap[operation] || 'ปรับสต็อก';
  const reasonText = reasonMap[reason] || reason;
  
  return `${opText} (${reasonText})`;
}

// ============================================================================
// VIEW STOCK
// ============================================================================

async function viewCurrentStock(searchTerm = null) {
  try {
    const stockCache = getStockCache();
    
    if (stockCache.length === 0) {
      return '❌ ไม่มีข้อมูลสต็อก';
    }
    
    let items = stockCache;
    
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      items = stockCache.filter(item => 
        item.item.toLowerCase().includes(term) ||
        item.category.toLowerCase().includes(term)
      );
      
      if (items.length === 0) {
        return `❌ ไม่พบ "${searchTerm}"`;
      }
    }
    
    const displayItems = items.slice(0, 20);
    
    let report = `📦 สต็อกสินค้า\n${'='.repeat(40)}\n\n`;
    
    displayItems.forEach(item => {
      const icon = item.stock === 0 ? '🔴' : item.stock < 10 ? '🟡' : '🟢';
      report += `${icon} ${item.item}\n`;
      report += `   ${item.stock} ${item.unit} │ ${item.price}฿\n\n`;
    });
    
    if (items.length > 20) {
      report += `... และอีก ${items.length - 20} รายการ\n`;
    }
    
    return report;
    
  } catch (error) {
    Logger.error('viewCurrentStock failed', error);
    return `❌ เกิดข้อผิดพลาด: ${error.message}`;
  }
}

// ============================================================================
// GENERATE VARIANCE REPORT
// ============================================================================

async function generateVarianceReport(period = 'today') {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'VarianceLog!A:F');
    
    if (rows.length <= 1) {
      return '📊 ยังไม่มีการปรับสต็อก';
    }
    
    const today = new Date().toLocaleDateString('en-CA');
    const variances = rows.slice(1)
      .filter(row => {
        if (period === 'today') {
          const rowDate = row[0].split(' ')[0];
          return rowDate.includes(today);
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
      return `📊 ไม่มีการปรับสต็อกวันนี้`;
    }
    
    let report = `📊 รายงานการปรับสต็อก\n${'='.repeat(40)}\n\n`;
    
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
      
      report += `${icon} ${itemName}\n`;
      
      changes.forEach(v => {
        const time = v.date.split(' ')[1] || '';
        const sign = v.difference >= 0 ? '+' : '';
        report += `   ${time} │ ${v.oldStock} → ${v.newStock} (${sign}${v.difference})\n`;
      });
      
      report += `\n`;
    });
    
    return report;
    
  } catch (error) {
    Logger.error('generateVarianceReport failed', error);
    return `❌ เกิดข้อผิดพลาด: ${error.message}`;
  }
}

module.exports = {
  parseAdjustmentCommand,
  adjustStock,
  logVariance,
  generateVarianceReport,
  viewCurrentStock
};
