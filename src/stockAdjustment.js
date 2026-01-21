// src/stockAdjustment.js - FIXED: Strict Filtering & Name Length Priority
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
    'ถุง': ['bag', 'ถุง', 'กระสอบ'],
    'โค้ก': ['coke', 'โคก', 'coca'],
    'เปปซี่': ['pepsi', 'เป๊ปซี่'],
    'น้ำดื่ม': ['water', 'น้ำ', 'drinking'],
    'ลัง': ['box', 'case', 'รัง', 'ลัง', 'crate'],
    'แพ็ค': ['pack', 'แพค', 'แพ็ค', 'โหล']
  };
  
  for (const [key, vars] of Object.entries(variations)) {
    if (normalized.includes(normalizeText(key))) {
      vars.forEach(v => keywords.add(normalizeText(v)));
    }
  }
  
  return Array.from(keywords);
}

// ============================================================================
// STRICT FUZZY MATCHING (FILTER LOGIC)
// ============================================================================

function fuzzyMatchStock(searchTerm, stockCache, priceHint = null, unitHint = null) {
  const normalized = normalizeText(searchTerm);
  const keywords = extractStockKeywords(searchTerm);
  
  Logger.info(`🔍 Searching: "${searchTerm}" (unit: ${unitHint || '-'}, price: ${priceHint || '-'})`);
  
  // 1. กรองเบื้องต้นด้วยชื่อ (ต้องมีคำค้นหาอยู่ในชื่อ หรือชื่ออยู่ในคำค้นหา)
  let candidates = stockCache.filter(item => {
    const itemNorm = normalizeText(item.item);
    return itemNorm.includes(normalized) || normalized.includes(itemNorm);
  });

  if (candidates.length === 0) {
    // ถ้าไม่เจอแบบตรงๆ ลองหาด้วย Keywords
    candidates = stockCache.filter(item => {
      const itemKeywords = extractStockKeywords(item.item);
      return keywords.some(k => itemKeywords.includes(k));
    });
  }

  // 2. ⚡ STRICT FILTER: ตัดทิ้งทันทีถ้าราคาหรือหน่วยไม่ตรง
  if (priceHint) {
    const strictPrice = candidates.filter(item => Math.abs(item.price - priceHint) <= (priceHint * 0.05)); // ยอมให้ต่างแค่ 5%
    if (strictPrice.length > 0) {
      Logger.info(`💰 Price Filter: Reduced from ${candidates.length} to ${strictPrice.length} items`);
      candidates = strictPrice;
    }
  }

  if (unitHint) {
    const strictUnit = candidates.filter(item => {
      const itemUnit = normalizeText(item.unit || '');
      const itemNorm = normalizeText(item.item);
      // เช็คทั้งในคอลัมน์หน่วย และในชื่อสินค้า
      return itemUnit.includes(unitHint) || itemNorm.includes(unitHint);
    });
    
    if (strictUnit.length > 0) {
      Logger.info(`📦 Unit Filter: Reduced from ${candidates.length} to ${strictUnit.length} items`);
      candidates = strictUnit;
    }
  }

  // 3. ให้คะแนนผู้รอดชีวิต
  const matches = candidates.map(item => {
    const itemNorm = normalizeText(item.item);
    const itemKeywords = extractStockKeywords(item.item);
    let score = 0;
    
    // Name Match
    if (itemNorm === normalized) score += 100;
    else if (itemNorm.includes(normalized)) score += 60;
    else if (normalized.includes(itemNorm)) score += 50;
    
    // Keyword Overlap
    const overlap = keywords.filter(k => itemKeywords.includes(k)).length;
    score += overlap * 20;

    // Price Bonus (ถ้าตรงเป๊ะๆ ให้เพิ่มอีก)
    if (priceHint && item.price === priceHint) score += 50;

    // Unit Bonus
    if (unitHint && (normalizeText(item.unit || '').includes(unitHint))) score += 50;

    // ⚡ LENGTH PENALTY: ถ้าคะแนนเท่ากัน ตัวที่ชื่อสั้นกว่า (ใกล้เคียงคำค้นหามากกว่า) ชนะ
    // ลบคะแนนตามความยาวส่วนเกิน
    const lengthDiff = Math.abs(itemNorm.length - normalized.length);
    score -= (lengthDiff * 0.5); 

    return { item, score };
  });
  
  matches.sort((a, b) => b.score - a.score);
  
  if (matches.length > 0) {
    Logger.info(`📊 Best match: ${matches[0].item.item} (${matches[0].score})`);
  }
  
  return matches;
}

// ============================================================================
// ENHANCED COMMAND PARSER
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
  
  if (operation === 'set' && !text.match(/มี|เหลือ|set/)) {
    if (text.match(/สั่ง|ร้าน|พี่|คุณ|เอา/)) {
      return { isAdjustment: false, reason: 'looks_like_order' };
    }
  }
  
  // Detect Unit Hint
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
    
    // Logic: ราคาปกติมักจะไม่ใช่ 1-10 (ยกเว้นน้ำแข็ง) และจำนวนมักจะไม่ใช่หลักพัน
    if (possiblePrice > 10 && value <= 1000) {
      priceHint = possiblePrice;
    } else if (possiblePrice <= 1000 && value > 10) {
      value = possiblePrice;
      priceHint = parsedNumbers[parsedNumbers.length - 1];
    } else if (unitHint && possiblePrice > 50) { 
      // ถ้าระบุหน่วยชัดเจน และเลขหน้าดูเหมือนราคา (เกิน 50) ให้เดาว่าเป็นราคาเลย
      priceHint = possiblePrice;
    }
  } else {
    value = parsedNumbers[0];
  }
  
  // Clean product name
  let productName = text
    .replace(/เติม|ลด|มี|เหลือ|ปรับ|เพิ่ม|ลบ|set|add|subtract/gi, '')
    .replace(/\d+/g, '')
    .replace(/ถุง|ขวด|กล่อง|ชิ้น|ลัง|รัง|บาท|฿|แพ็ค|แพค|โหล|ละ|ราคา/gi, '') // เพิ่มคำว่า "ละ", "ราคา"
    .trim();
  
  if (!productName) return { isAdjustment: false, reason: 'no_product_name' };
  if (!value || value <= 0) return { isAdjustment: false, reason: 'invalid_value' };
  
  // Match with Hints
  const matches = fuzzyMatchStock(productName, stockCache, priceHint, unitHint);
  
  if (matches.length === 0) return { isAdjustment: false, reason: 'product_not_found' };
  
  // Ambiguity Check (Strict)
  // แจ้งสับสนก็ต่อเมื่อ คะแนนใกล้กันมาก และ ไม่ใช่สินค้าตัวเดียวกัน (Duplicate)
  if (matches.length > 1) {
    const scoreDiff = matches[0].score - matches[1].score;
    if (scoreDiff < 5 && matches[0].item.item !== matches[1].item.item) {
       return {
        isAdjustment: true,
        ambiguous: true,
        suggestions: matches.slice(0, 5).map(m => m.item),
        value: value,
        productName: productName
      };
    }
  }
  
  return {
    isAdjustment: true,
    item: matches[0].item.item,
    stockItem: matches[0].item,
    value: value,
    operation: operation,
    priceHint: priceHint,
    originalText: text,
    confidence: matches[0].score > 100 ? 'high' : 'medium'
  };
}

// ============================================================================
// ADJUST STOCK
// ============================================================================

async function adjustStock(itemName, value, operation = 'set', reason = 'manual') {
  try {
    const stockCache = getStockCache();
    // ค้นหาแบบตรงตัวจากผลลัพธ์ parser
    const item = stockCache.find(i => i.item === itemName);
    
    if (!item) return { success: false, error: `❌ ไม่พบสินค้า: ${itemName}` };
    
    const oldStock = item.stock;
    let newStock;
    
    switch (operation) {
      case 'add': newStock = oldStock + value; break;
      case 'subtract': 
        newStock = oldStock - value; 
        if (newStock < 0) return { success: false, error: `❌ สต็อกไม่พอ (มี ${oldStock})` };
        break;
      case 'set': newStock = value; break;
    }
    
    // Update Sheet
    const rows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === item.item) {
        rowIndex = i + 1;
        break;
      }
    }
    
    if (rowIndex !== -1) {
      await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${rowIndex}`, [[newStock]]);
      await logVariance(item.item, oldStock, newStock, newStock - oldStock, reason, operation);
      await loadStockCache(true); 
      
      return {
        success: true,
        item: item.item,
        price: item.price,
        oldStock,
        newStock,
        difference: newStock - oldStock,
        unit: item.unit,
        operationText: getOperationText(operation, value)
      };
    }
    return { success: false, error: '❌ Database Error' };
    
  } catch (error) {
    Logger.error('adjustStock failed', error);
    return { success: false, error: error.message };
  }
}

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

module.exports = {
  parseAdjustmentCommand,
  adjustStock,
  fuzzyMatchStock,
  extractStockKeywords
};
