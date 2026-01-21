// stockAdjustment.js - FIXED: Price hint extraction & better pattern matching

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString, normalizeText } = require('./utils');
const { getSheetData, updateSheetData, appendSheetData } = require('./googleServices');
const { getStockCache, loadStockCache } = require('./cacheManager');

// ============================================================================
// ENHANCED KEYWORD EXTRACTION
// ============================================================================

function extractStockKeywords(itemName) {
  const keywords = new Set();
  const normalized = normalizeText(itemName);
  
  keywords.add(normalized);
  
  const tokens = itemName.split(/\s+/);
  tokens.forEach(token => {
    const norm = normalizeText(token);
    if (norm.length >= 2) {
      keywords.add(norm);
    }
  });
  
  const thaiNumbers = {
    'หนึ่ง': '1', 'สอง': '2', 'สาม': '3', 'สี่': '4', 'ห้า': '5',
    'หก': '6', 'เจ็ด': '7', 'แปด': '8', 'เก้า': '9', 'สิบ': '10'
  };
  
  for (const [thai, num] of Object.entries(thaiNumbers)) {
    if (itemName.includes(thai)) {
      keywords.add(num);
    }
  }
  
  const variations = {
    'น้ำแข็ง': ['นำเข็ง', 'น้ำแข็ง', 'ice', 'แข็ง'],
    'หลอด': ['tube', 'ท่อ'],
    'แผ่น': ['sheet', 'เเผ่น'],
    'บด': ['crushed', 'บด'],
    'ถุง': ['bag', 'ถุง'],
    'โค้ก': ['coke', 'โคก', 'coca'],
    'เปปซี่': ['pepsi', 'เป๊ปซี่'],
    'น้ำดื่ม': ['water', 'น้ำ', 'drinking']
  };
  
  for (const [key, vars] of Object.entries(variations)) {
    if (normalized.includes(normalizeText(key))) {
      vars.forEach(v => keywords.add(normalizeText(v)));
    }
  }
  
  return Array.from(keywords);
}

// ============================================================================
// SMART FUZZY MATCHING
// ============================================================================

function fuzzyMatchStock(searchTerm, stockCache, priceHint = null, unitHint = null) {
  const normalized = normalizeText(searchTerm);
  const keywords = extractStockKeywords(searchTerm);
  
  Logger.info(`🔍 Searching: "${searchTerm}" (unit: ${unitHint || '-'}, price: ${priceHint || '-'})`);
  
  const matches = [];
  
  for (const item of stockCache) {
    const itemNorm = normalizeText(item.item);
    const itemUnit = normalizeText(item.unit || '');
    const itemKeywords = extractStockKeywords(item.item);
    
    let score = 0;
    
    // Exact match
    if (itemNorm === normalized) score += 100;
    
    // Contains match
    if (itemNorm.includes(normalized) || normalized.includes(itemNorm)) score += 50;
    
    // Keyword overlap
    const overlap = keywords.filter(k => itemKeywords.includes(k)).length;
    score += overlap * 20;
    
    // Price hint match
    if (priceHint && item.price === priceHint) {
      score += 200;
      Logger.success(`🎯 Exact price match: ${item.item}`);
    } else if (priceHint && Math.abs(item.price - priceHint) <= (priceHint * 0.1)) {
      score += 100;
    }

    // ✅ UNIT HINT BOOST (สำคัญ: ถ้าหน่วยตรงกัน ให้คะแนนพิเศษ)
    if (unitHint) {
      if (itemUnit.includes(unitHint)) {
        score += 150; // คะแนนพิเศษถ้าหน่วยตรง (เช่น "ลัง" ตรงกับ "ลัง")
        Logger.info(`📦 Unit match: ${item.item} (${item.unit}) matches ${unitHint}`);
      } else if (itemNorm.includes(unitHint)) {
        score += 100; // คะแนนพิเศษถ้าชื่อสินค้ามีคำบอกหน่วย (เช่น "โค้ก(ลัง)")
      }
    }
    
    if (score > 0) {
      matches.push({ item, score });
    }
  }
  
  matches.sort((a, b) => b.score - a.score);
  
  if (matches.length > 0) {
    Logger.info(`📊 Best match: ${matches[0].item.item} (${matches[0].score})`);
  }
  
  return matches;
}

// ============================================================================
// ENHANCED COMMAND PARSER (FIXED)
// ============================================================================

async function parseAdjustmentCommand(text) {
  const stockCache = getStockCache();
  
  // Extract numbers
  const numbers = text.match(/\d+/g);
  if (!numbers || numbers.length === 0) {
    return { isAdjustment: false, reason: 'no_number' };
  }
  
  // Operation keywords
  let operation = 'set';
  const lower = text.toLowerCase();
  
  if (lower.match(/เติม|เพิ่ม|add/)) operation = 'add';
  else if (lower.match(/ลด|ลบ|subtract/)) operation = 'subtract';
  
  // Check if it looks like an order (to prevent confusion)
  if (operation === 'set' && !text.match(/มี|เหลือ|set/)) {
    if (text.match(/สั่ง|ร้าน|พี่|คุณ|เอา/)) {
      return { isAdjustment: false, reason: 'looks_like_order' };
    }
  }
  
  // ✅ FIX: Detect Unit Hint BEFORE cleaning (จับคำว่า "รัง" หรือ "ลัง")
  let unitHint = null;
  if (text.match(/รัง|ลัง|crate/)) unitHint = 'ลัง';
  else if (text.match(/ขวด/)) unitHint = 'ขวด';
  else if (text.match(/ถุง|กระสอบ/)) unitHint = 'ถุง';
  else if (text.match(/แพ็ค|แพค/)) unitHint = 'แพ็ค';
  else if (text.match(/โหล/)) unitHint = 'โหล';

  // Extract Price & Quantity
  let value = null;
  let priceHint = null;
  const parsedNumbers = numbers.map(n => parseInt(n));
  
  if (parsedNumbers.length >= 2) {
    value = parsedNumbers[parsedNumbers.length - 1]; // Assume last is qty
    const possiblePrice = parsedNumbers[parsedNumbers.length - 2];
    
    if (possiblePrice > 10 && value <= 1000) {
      priceHint = possiblePrice;
    } else if (possiblePrice <= 1000 && value > 10) {
      // Swapped case
      value = possiblePrice;
      priceHint = parsedNumbers[parsedNumbers.length - 1];
    }
  } else {
    value = parsedNumbers[0];
  }
  
  // Clean product name (เอาคำว่า "รัง", "ลัง" ออกด้วย จะได้เหลือแค่ชื่อสินค้า)
  let productName = text
    .replace(/เติม|ลด|มี|เหลือ|ปรับ|เพิ่ม|ลบ|set|add|subtract/gi, '')
    .replace(/\d+/g, '')
    .replace(/ถุง|ขวด|กล่อง|ชิ้น|ลัง|รัง|บาท|฿|แพ็ค|แพค|โหล/gi, '') // ✅ เพิ่ม 'รัง', 'แพ็ค'
    .trim();
  
  if (!productName) return { isAdjustment: false, reason: 'no_product_name' };
  if (!value || value <= 0) return { isAdjustment: false, reason: 'invalid_value' };
  
  // Match with Hints
  const matches = fuzzyMatchStock(productName, stockCache, priceHint, unitHint);
  
  if (matches.length === 0) return { isAdjustment: false, reason: 'product_not_found' };
  
  // Check ambiguity (only if scores are very close)
  if (matches.length > 1 && (matches[0].score - matches[1].score < 10)) {
    return {
      isAdjustment: true,
      ambiguous: true,
      suggestions: matches.slice(0, 5).map(m => m.item),
      value: value,
      productName: productName
    };
  }
  
  return {
    isAdjustment: true,
    item: matches[0].item.item,
    stockItem: matches[0].item,
    value: value,
    operation: operation,
    priceHint: priceHint,
    originalText: text,
    confidence: matches[0].score > 150 ? 'high' : 'medium'
  };
}

// ============================================================================
// ADJUST STOCK
// ============================================================================

async function adjustStock(itemName, value, operation = 'set', reason = 'manual') {
  try {
    Logger.info(`🔧 Adjusting: ${itemName} ${operation} ${value}`);
    
    if (value < 0 || value > 100000) {
      return { 
        success: false, 
        error: '❌ จำนวนไม่ถูกต้อง (0-100,000)' 
      };
    }
    
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
    
    const rows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
    let rowIndex = -1;
    
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0].toLowerCase() === item.item.toLowerCase()) {
        rowIndex = i + 1;
        break;
      }
    }
    
    if (rowIndex === -1) {
      return { 
        success: false, 
        error: '❌ ไม่พบสินค้าในระบบ' 
      };
    }
    
    await updateSheetData(
      CONFIG.SHEET_ID, 
      `สต็อก!E${rowIndex}`, 
      [[newStock]]
    );
    
    await logVariance(item.item, oldStock, newStock, difference, reason, operation);
    await loadStockCache(true);
    
    Logger.success(`✅ Updated: ${item.item} (${oldStock} → ${newStock})`);
    
    return {
      success: true,
      item: item.item,
      unit: item.unit,
      price: item.price,
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
    const reasonText = `${operation} (${reason})`;
    const row = [getThaiDateTimeString(), item, oldStock, newStock, difference, reasonText];
    await appendSheetData(CONFIG.SHEET_ID, 'VarianceLog!A:F', [row]);
  } catch (e) { Logger.error('Log failed', e); }
}

function getOperationText(op, val) {
  return op === 'add' ? `เติม +${val}` : op === 'subtract' ? `ลด -${val}` : `ตั้งเป็น ${val}`;
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
      const matches = fuzzyMatchStock(searchTerm, stockCache);
      items = matches.map(m => m.item);
      
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
  viewCurrentStock,
  fuzzyMatchStock,
  extractStockKeywords
};
