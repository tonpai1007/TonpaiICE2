// stockAdjustment.js - Enhanced UX with auto variance logging
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { getSheetData, updateSheetData, appendSheetData } = require('./googleServices');
const { getStockCache, loadStockCache } = require('./cacheManager');

// ============================================================================
// PARSE ADJUSTMENT COMMAND - Enhanced with +/- operations
// ============================================================================

async function parseAdjustmentCommand(text) {
  const patterns = [
    // Pattern 1: เติม/เพิ่ม (Add operation)
    { 
      regex: /(?:เติม|เพิ่ม)\s*(.+?)\s*(\d+)/i, 
      operation: 'add' 
    },
    
    // Pattern 2: ลด/ตัด (Subtract operation)
    { 
      regex: /(?:ลด|ตัด|หัก)\s*(.+?)\s*(\d+)/i, 
      operation: 'subtract' 
    },
    
    // Pattern 3: ปรับ...เหลือ (Set exact value)
    { 
      regex: /ปรับ\s*(.+?)\s*เหลือ\s*(\d+)/i, 
      operation: 'set' 
    },
    
    // Pattern 4: ...เหลือ (Set exact value - short form)
    { 
      regex: /(.+?)\s*เหลือ\s*(\d+)/i, 
      operation: 'set' 
    },
    
    // Pattern 5: ปรับสต็อก (Set exact value)
    { 
      regex: /ปรับ(?:สต็อก)?\s*(.+?)\s*(\d+)/i, 
      operation: 'set' 
    }
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) {
      return {
        isAdjustment: true,
        item: match[1].trim(),
        value: parseInt(match[2]),
        operation: pattern.operation,
        originalText: text
      };
    }
  }

  return { isAdjustment: false };
}

// ============================================================================
// ADJUST STOCK - Enhanced with operation modes
// ============================================================================

async function adjustStock(itemName, value, operation = 'set', reason = 'manual') {
  try {
    Logger.info(`🔧 Stock adjustment: ${itemName} ${operation} ${value}`);

    // Find item in cache
    const stockCache = getStockCache();
    const item = stockCache.find(i => 
      i.item.toLowerCase().includes(itemName.toLowerCase())
    );

    if (!item) {
      return { 
        success: false, 
        error: `❌ ไม่พบสินค้า: "${itemName}"\n\n💡 ลองพิมพ์ชื่อให้ถูกต้อง หรือพิมพ์ "สต็อก" เพื่อดูรายการ` 
      };
    }

    const oldStock = item.stock;
    let newStock = oldStock;

    // Calculate new stock based on operation
    switch (operation) {
      case 'add':
        newStock = oldStock + value;
        break;
      case 'subtract':
        newStock = oldStock - value;
        if (newStock < 0) {
          return { 
            success: false, 
            error: `❌ ไม่สามารถลดได้\n\nสต็อกปัจจุบัน: ${oldStock}\nพยายามลด: ${value}\nผลลัพธ์จะติดลบ!` 
          };
        }
        break;
      case 'set':
        newStock = value;
        break;
    }

    const difference = newStock - oldStock;

    // Update stock in Google Sheets
    const rows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
    let rowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0].toLowerCase() === item.item.toLowerCase()) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex === -1) {
      return { success: false, error: '❌ ไม่พบสินค้าในระบบ (ข้อมูลไม่ตรงกับ cache)' };
    }

    // Update sheet
    await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${rowIndex}`, [[newStock]]);

    // Auto-log to VarianceLog
    await logVariance(item.item, oldStock, newStock, difference, reason, operation);

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
      operationText: getOperationText(operation, value)
    };

  } catch (error) {
    Logger.error('❌ adjustStock failed', error);
    return { success: false, error: `❌ เกิดข้อผิดพลาด: ${error.message}` };
  }
}

// ============================================================================
// LOG VARIANCE - Auto-save to VarianceLog sheet
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
    // Don't fail the whole operation if logging fails
    return false;
  }
}

// ============================================================================
// VARIANCE REPORT - View stock changes
// ============================================================================

async function generateVarianceReport(period = 'today') {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'VarianceLog!A:F');
    
    if (rows.length <= 1) {
      return '📊 ยังไม่มีการปรับสต็อก\n\n💡 ลองใช้คำสั่ง:\n• "เติมน้ำแข็ง 20"\n• "ลดน้ำแข็ง 10"\n• "น้ำแข็งเหลือ 50"';
    }

    const today = new Date().toLocaleDateString('en-CA');
    const variances = rows.slice(1)
      .filter(row => {
        if (period === 'today') {
          const rowDate = row[0].split(' ')[0];
          return rowDate === today;
        }
        return true; // Show all for other periods
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
    
    // Group by item
    const itemMap = new Map();
    variances.forEach(v => {
      if (!itemMap.has(v.item)) {
        itemMap.set(v.item, []);
      }
      itemMap.get(v.item).push(v);
    });

    // Display grouped data
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

    // Summary
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
// VIEW CURRENT STOCK - Quick reference
// ============================================================================

async function viewCurrentStock(searchTerm = null) {
  try {
    const stockCache = getStockCache();
    
    if (stockCache.length === 0) {
      return '❌ ไม่มีข้อมูลสต็อก\n\n💡 กรุณารีเฟรช: พิมพ์ "รีเฟรช"';
    }

    let items = stockCache;
    
    // Filter if search term provided
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

    // Limit to 20 items for readability
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
// EXPORTS
// ============================================================================

module.exports = {
  parseAdjustmentCommand,
  adjustStock,
  logVariance,
  generateVarianceReport,
  viewCurrentStock
};
