// stockAdjustment.js - ENHANCED: Better keyword matching + price hints

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
  
  // Add word tokens
  const tokens = itemName.split(/\s+/);
  tokens.forEach(token => {
    const norm = normalizeText(token);
    if (norm.length >= 2) {
      keywords.add(norm);
    }
  });
  
  // Thai number words
  const thaiNumbers = {
    'หนึ่ง': '1', 'สอง': '2', 'สาม': '3', 'สี่': '4', 'ห้า': '5',
    'หก': '6', 'เจ็ด': '7', 'แปด': '8', 'เก้า': '9', 'สิบ': '10'
  };
  
  for (const [thai, num] of Object.entries(thaiNumbers)) {
    if (itemName.includes(thai)) {
      keywords.add(num);
    }
  }
  
  // Common item variations
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

function fuzzyMatchStock(searchTerm, stockCache, priceHint = null) {
  const normalized = normalizeText(searchTerm);
  const keywords = extractStockKeywords(searchTerm);
  
  Logger.info(`🔍 Searching: "${searchTerm}" (keywords: ${keywords.join(', ')})`);
  
  const matches = [];
  
  for (const item of stockCache) {
    const itemNorm = normalizeText(item.item);
    const itemKeywords = extractStockKeywords(item.item);
    
    let score = 0;
    
    // Exact match
    if (itemNorm === normalized) {
      score += 100;
    }
    
    // Contains match
    if (itemNorm.includes(normalized) || normalized.includes(itemNorm)) {
      score += 50;
    }
    
    // Keyword overlap
    const overlap = keywords.filter(k => itemKeywords.includes(k)).length;
    score += overlap * 20;
    
    // Price hint match (BOOST)
    if (priceHint && item.price === priceHint) {
      score += 200; // Heavy boost for price match
      Logger.success(`🎯 Price match: ${item.item} @ ${priceHint}฿`);
    }
    
    // Fuzzy price match (within 10%)
    if (priceHint && Math.abs(item.price - priceHint) <= (priceHint * 0.1)) {
      score += 100;
    }
    
    if (score > 0) {
      matches.push({ item, score });
    }
  }
  
  // Sort by score
  matches.sort((a, b) => b.score - a.score);
  
  if (matches.length > 0) {
    Logger.info(`📊 Found ${matches.length} matches (best: ${matches[0].item.item} - ${matches[0].score} points)`);
  }
  
  return matches;
}

// ============================================================================
// ENHANCED COMMAND PARSER
// ============================================================================

async function parseAdjustmentCommand(text) {
  const stockCache = getStockCache();
  
  // Must have at least one number
  const numbers = text.match(/\d+/g);
  if (!numbers || numbers.length === 0) {
    return { isAdjustment: false, reason: 'no_number' };
  }
  
  // Detect operation keywords (boost score if found)
  let operation = 'set';
  let hasOperationKeyword = false;
  const lower = text.toLowerCase();
  
  if (lower.includes('เติม') || lower.includes('เพิ่ม') || lower.includes('add')) {
    operation = 'add';
    hasOperationKeyword = true;
  } else if (lower.includes('ลด') || lower.includes('ลบ') || lower.includes('subtract')) {
    operation = 'subtract';
    hasOperationKeyword = true;
  } else if (lower.includes('มี') || lower.includes('เหลือ') || lower.includes('set')) {
    operation = 'set';
    hasOperationKeyword = true;
  }
  
  // If no operation keyword found, this might not be a stock adjustment
  if (!hasOperationKeyword) {
    // Check if it looks more like an order
    if (lower.includes('สั่ง') || lower.includes('จำนวน') || 
        lower.includes('ถุง') || lower.includes('ขวด')) {
      return { isAdjustment: false, reason: 'looks_like_order' };
    }
  }
  
  // Extract product name and values
  let productName = text;
  let value = parseInt(numbers[numbers.length - 1]); // Last number is usually quantity
  let priceHint = null;
  
  // Check if there's a price hint (pattern: [item] [price] [quantity])
  if (numbers.length >= 2) {
    const possiblePrice = parseInt(numbers[numbers.length - 2]);
    const possibleQty = parseInt(numbers[numbers.length - 1]);
    
    // If second-to-last number is large (likely a price)
    if (possiblePrice > 20 && possibleQty <= 100) {
      priceHint = possiblePrice;
      value = possibleQty;
      
      Logger.info(`💡 Detected price hint: ${priceHint}฿, qty: ${value}`);
    }
  }
  
  // Clean product name
  productName = text
    .replace(/เติม|ลด|มี|เหลือ|ปรับ|เพิ่ม|ลบ|set|add|subtract/gi, '')
    .replace(/\d+/g, '')
    .replace(/ถุง|ขวด|กล่อง|ชิ้น|ลัง|บาท|฿/gi, '')
    .trim();
  
  if (!productName) {
    return { isAdjustment: false, reason: 'no_product_name' };
  }
  
  // Find matching product with price hint
  const matches = fuzzyMatchStock(productName, stockCache, priceHint);
  
  if (matches.length === 0) {
    return { isAdjustment: false, reason: 'product_not_found' };
  }
  
  // If multiple matches without clear winner, ask for clarification
  if (matches.length > 1 && matches[0].score === matches[1].score) {
    return {
      isAdjustment: true,
      ambiguous: true,
      suggestions: matches.slice(0, 5).map(m => m.item),
      value: value,
      operation: operation,
      productName: productName
    };
  }
  
  // Best match found
  const bestMatch = matches[0].item;
  
  return {
    isAdjustment: true,
    item: bestMatch.item,
    stockItem: bestMatch,
    value: value,
    operation: operation,
    priceHint: priceHint,
    originalText: text,
    confidence: matches[0].score > 150 ? 'high' : 'medium',
    matchScore: matches[0].score
  };
}

// ============================================================================
// ADJUST STOCK
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
