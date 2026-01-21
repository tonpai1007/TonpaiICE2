// src/stockAdjustment.js - FIXED: ลดความสับสน + แม่นยำขึ้น
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString, normalizeText } = require('./utils');
const { getSheetData, updateSheetData, appendSheetData } = require('./googleServices');
const { getStockCache, loadStockCache } = require('./cacheManager');

// ============================================================================
// ENHANCED: Extract Keywords แม่นยำขึ้น
// ============================================================================

function extractStockKeywords(itemName) {
  const keywords = new Set();
  const normalized = normalizeText(itemName);
  
  keywords.add(normalized);
  
  // Tokenize
  const tokens = itemName.split(/\s+/);
  tokens.forEach(token => {
    const norm = normalizeText(token);
    if (norm.length >= 2) {
      keywords.add(norm);
    }
  });
  
  // Common product variations
  const variations = {
    'น้ำแข็ง': ['นําเเข็ง', 'น้ำเเข็ง', 'ice', 'แข็ง', 'นํา'],
    'หลอด': ['tube', 'ท่อ'],
    'แผ่น': ['sheet', 'เเผ่น'],
    'บด': ['crushed', 'บด'],
    'ถุง': ['bag', 'ถุง', 'กระสอบ'],
    'โค้ก': ['coke', 'โค', 'coca', 'โคก'],
    'เป็ปซี่': ['pepsi', 'เป๊ปซี่', 'เปปซี่'],
    'น้ำดื่ม': ['water', 'น้ำ', 'drinking', 'นํา'],
    'ลัง': ['box', 'case', 'รัง', 'ลัง', 'crate'],
    'แพ็ค': ['pack', 'แพค', 'แพ็ค', 'โหล'],
    'สิงห์': ['singha', 'singh', 'singห์'],
    'ช้าง': ['chang', 'elephant'],
    'ลีโอ': ['leo']
  };
  
  for (const [key, vars] of Object.entries(variations)) {
    if (normalized.includes(normalizeText(key))) {
      vars.forEach(v => keywords.add(normalizeText(v)));
    }
  }
  
  return Array.from(keywords);
}

// ============================================================================
// IMPROVED: Fuzzy Match with Weighted Scoring
// ============================================================================

function fuzzyMatchStock(searchTerm, stockCache, priceHint = null, unitHint = null) {
  const normalized = normalizeText(searchTerm);
  const keywords = extractStockKeywords(searchTerm);
  
  Logger.info(`🔍 Searching: "${searchTerm}" (price=${priceHint || '-'}, unit=${unitHint || '-'})`);
  
  // Phase 1: Initial filtering
  let candidates = stockCache.filter(item => {
    const itemNorm = normalizeText(item.item);
    
    // Direct substring match
    if (itemNorm.includes(normalized) || normalized.includes(itemNorm)) {
      return true;
    }
    
    // Keyword overlap
    const itemKeywords = extractStockKeywords(item.item);
    const overlap = keywords.filter(k => itemKeywords.includes(k)).length;
    
    return overlap >= 1;
  });

  Logger.info(`📊 Initial candidates: ${candidates.length}`);

  // Phase 2: STRICT filtering by hints
  if (priceHint) {
    const priceMatched = candidates.filter(item => 
      Math.abs(item.price - priceHint) <= Math.max(5, priceHint * 0.15) // ±15% หรือ ±5฿
    );
    
    if (priceMatched.length > 0) {
      Logger.info(`💰 Price filter: ${candidates.length} → ${priceMatched.length}`);
      candidates = priceMatched;
    }
  }

  if (unitHint) {
    const unitMatched = candidates.filter(item => {
      const itemUnit = normalizeText(item.unit || '');
      const itemName = normalizeText(item.item);
      
      return itemUnit.includes(unitHint) || itemName.includes(unitHint);
    });
    
    if (unitMatched.length > 0) {
      Logger.info(`📦 Unit filter: ${candidates.length} → ${unitMatched.length}`);
      candidates = unitMatched;
    }
  }

  // Phase 3: Weighted scoring
  const matches = candidates.map(item => {
    const itemNorm = normalizeText(item.item);
    const itemKeywords = extractStockKeywords(item.item);
    let score = 0;
    
    // 1. Exact name match = HUGE bonus
    if (itemNorm === normalized) {
      score += 1000;
    }
    // 2. Full substring match
    else if (itemNorm.includes(normalized)) {
      score += 500;
      
      // Bonus: ถ้าเป็น prefix (เริ่มต้นด้วย)
      if (itemNorm.startsWith(normalized)) {
        score += 100;
      }
    }
    // 3. Reverse substring
    else if (normalized.includes(itemNorm)) {
      score += 300;
    }
    
    // 4. Keyword overlap score
    const overlap = keywords.filter(k => itemKeywords.includes(k)).length;
    score += overlap * 50;
    
    // 5. Price match bonus
    if (priceHint) {
      if (item.price === priceHint) {
        score += 200;
      } else if (Math.abs(item.price - priceHint) <= priceHint * 0.05) {
        score += 100;
      }
    }
    
    // 6. Unit match bonus
    if (unitHint) {
      const itemUnit = normalizeText(item.unit || '');
      if (itemUnit.includes(unitHint)) {
        score += 150;
      }
    }
    
    // 7. Length penalty (prefer shorter, more specific matches)
    const lengthDiff = Math.abs(itemNorm.length - normalized.length);
    score -= (lengthDiff * 2);
    
    // 8. Stock availability bonus
    if (item.stock > 0) {
      score += 10;
    }

    return { item, score };
  });
  
  // Sort by score
  matches.sort((a, b) => b.score - a.score);
  
  if (matches.length > 0) {
    Logger.info(`🏆 Top match: ${matches[0].item.item} (score: ${matches[0].score})`);
    
    // Log top 3 for debugging
    matches.slice(0, 3).forEach((m, i) => {
      Logger.debug(`  ${i + 1}. ${m.item.item} - ${m.score} pts`);
    });
  }
  
  return matches;
}

// ============================================================================
// ENHANCED: Parse Adjustment Command
// ============================================================================

async function parseAdjustmentCommand(text) {
  const stockCache = getStockCache();
  
  // Extract numbers
  const numbers = text.match(/\d+/g);
  if (!numbers || numbers.length === 0) {
    return { isAdjustment: false, reason: 'no_number' };
  }
  
  // Determine operation
  let operation = 'set';
  const lower = text.toLowerCase();
  
  if (lower.match(/เติม|เพิ่ม|add/)) {
    operation = 'add';
  } else if (lower.match(/ลด|ลบ|subtract/)) {
    operation = 'subtract';
  }
  
  // Check if looks like order (not stock adjustment)
  if (operation === 'set' && !text.match(/มี|เหลือ|set/)) {
    if (text.match(/สั่ง|ร้าน|พี่|คุณ|เอา/)) {
      return { isAdjustment: false, reason: 'looks_like_order' };
    }
  }
  
  // Detect unit hint
  let unitHint = null;
  const unitPatterns = {
    'ลัง': /รัง|ลัง|crate|box/i,
    'ขวด': /ขวด|bottle/i,
    'ถุง': /ถุง|กระสอบ|bag/i,
    'แพ็ค': /แพ็ค|แพค|โหล|pack/i,
    'โหล': /โหล|dozen/i
  };
  
  for (const [unit, pattern] of Object.entries(unitPatterns)) {
    if (pattern.test(text)) {
      unitHint = normalizeText(unit);
      break;
    }
  }
  
  // Extract price & quantity
  let value = null;
  let priceHint = null;
  const parsedNumbers = numbers.map(n => parseInt(n));
  
  if (parsedNumbers.length >= 2) {
    // Logic: เลขใหญ่ = ราคา, เลขเล็ก = จำนวน
    const sorted = [...parsedNumbers].sort((a, b) => b - a);
    
    if (sorted[0] > 50 && sorted[1] <= 100) {
      priceHint = sorted[0];
      value = sorted[1];
    } else {
      // Fallback: last = qty
      value = parsedNumbers[parsedNumbers.length - 1];
      priceHint = parsedNumbers[parsedNumbers.length - 2];
    }
  } else {
    value = parsedNumbers[0];
  }
  
  // Clean product name
  let productName = text
    .replace(/เติม|ลด|มี|เหลือ|ปรับ|เพิ่ม|ลบ|set|add|subtract/gi, '')
    .replace(/\d+/g, '')
    .replace(/ถุง|ขวด|กล่อง|ชิ้น|ลัง|รัง|บาท|฿|แพ็ค|แพค|โหล|ละ|ราคา/gi, '')
    .trim();
  
  if (!productName) {
    return { isAdjustment: false, reason: 'no_product_name' };
  }
  
  if (!value || value <= 0) {
    return { isAdjustment: false, reason: 'invalid_value' };
  }
  
  // Match with hints
  const matches = fuzzyMatchStock(productName, stockCache, priceHint, unitHint);
  
  if (matches.length === 0) {
    return { 
      isAdjustment: false, 
      reason: 'product_not_found',
      searchTerm: productName
    };
  }
  
  // Ambiguity check with STRICTER threshold
  if (matches.length > 1) {
    const scoreDiff = matches[0].score - matches[1].score;
    
    // ถ้าคะแนนต่างกันน้อยกว่า 100 = สับสน
    if (scoreDiff < 100 && matches[0].item.item !== matches[1].item.item) {
      Logger.warn(`⚠️ Ambiguous: Top 2 scores are close (${matches[0].score} vs ${matches[1].score})`);
      
      return {
        isAdjustment: true,
        ambiguous: true,
        suggestions: matches.slice(0, 5).map(m => m.item),
        value: value,
        productName: productName
      };
    }
  }
  
  // Clear winner
  return {
    isAdjustment: true,
    item: matches[0].item.item,
    stockItem: matches[0].item,
    value: value,
    operation: operation,
    priceHint: priceHint,
    originalText: text,
    confidence: matches[0].score > 500 ? 'high' : 'medium'
  };
}

// ============================================================================
// ADJUST STOCK (unchanged)
// ============================================================================

async function adjustStock(itemName, value, operation = 'set', reason = 'manual') {
  try {
    const stockCache = getStockCache();
    const item = stockCache.find(i => i.item === itemName);
    
    if (!item) {
      return { success: false, error: `❌ ไม่พบสินค้า: ${itemName}` };
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
          return { success: false, error: `❌ สต็อกไม่พอ (มี ${oldStock})` };
        }
        break;
      case 'set': 
        newStock = value; 
        break;
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
  } catch (e) { 
    Logger.error('Log failed', e); 
  }
}

function getOperationText(op, val) {
  return op === 'add' ? `เติม +${val}` : 
         op === 'subtract' ? `ลด -${val}` : 
         `ตั้งเป็น ${val}`;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  parseAdjustmentCommand,
  adjustStock,
  fuzzyMatchStock,
  extractStockKeywords
};