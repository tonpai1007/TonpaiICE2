// src/stockAdjustment.js
const { getStockCache } = require('./cacheManager');
const { updateStock } = require('./orderService'); // ใช้ฟังก์ชัน updateStock เดิมที่มีอยู่
const { Logger } = require('./logger');

async function parseAdjustmentCommand(text) {
  // Pattern: "ปรับ [สินค้า] เหลือ [จำนวน]"
  const match = text.match(/ปรับ\s*(.+?)\s*เหลือ\s*(\d+)/i);
  if (!match) return { isAdjustment: false };

  return {
    isAdjustment: true,
    item: match[1].trim(),
    actualStock: parseInt(match[2])
  };
}

async function adjustStock(itemName, actualStock, reason = 'manual_adjustment') {
  const stockCache = getStockCache();
  const stockItem = stockCache.find(i => i.item.includes(itemName) || itemName.includes(i.item));

  if (!stockItem) {
    return { success: false, error: 'หาสินค้าไม่เจอ' };
  }

  const oldStock = stockItem.stock;
  const difference = actualStock - oldStock;

  try {
    // เรียก updateStock จาก orderService (ต้องแน่ใจว่า export มาแล้ว)
    // หรือเรียก updateStockWithOptimisticLocking โดยตรงก็ได้
    const success = await updateStock(stockItem.item, stockItem.unit, actualStock);
    
    if (success) {
      Logger.info(`🔧 Stock Adjustment: ${stockItem.item} ${oldStock} -> ${actualStock} (${reason})`);
      return { 
        success: true, 
        item: stockItem.item, 
        unit: stockItem.unit,
        oldStock, 
        newStock: actualStock, 
        difference 
      };
    } else {
      return { success: false, error: 'Update failed' };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function generateVarianceReport(period = 'today') {
  // ในเวอร์ชันเริ่มต้น ยังไม่ต้องทำ Report จริงจัง
  return "📊 Variance Report: (Feature coming soon)";
}

module.exports = {
  parseAdjustmentCommand,
  adjustStock,
  generateVarianceReport
};