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
// ENHANCED: Parse Adjustment Command
// ============================================================================


async function parseAdjustmentCommand(text) {
  const stockCache = getStockCache();
  
  const numbers = text.match(/\d+/g);
  if (!numbers || numbers.length === 0) {
    return { 
      isAdjustment: false, 
      reason: 'no_number',
      errorMessage: '❌ ไม่พบตัวเลข\n\n💡 ตัวอย่าง:\n• "น้ำแข็ง เหลือ 10"\n• "เติม โค้ก 30 20"'
    };
  }
  
  let operation = 'set';
  const lower = text.toLowerCase();
  
  if (lower.match(/เติม|เพิ่ม|add/)) {
    operation = 'add';
  } else if (lower.match(/ลด|ลบ|subtract/)) {
    operation = 'subtract';
  }
  
  // Check if looks like order
  if (operation === 'set' && !text.match(/มี|เหลือ|set/)) {
    if (text.match(/สั่ง|ร้าน|พี่|คุณ|เอา/)) {
      return { 
        isAdjustment: false, 
        reason: 'looks_like_order',
        errorMessage: '❓ ดูเหมือนคำสั่งซื้อมากกว่าปรับสต็อก\n\n💡 ถ้าต้องการปรับสต็อก ใช้:\n• "[สินค้า] มี [จำนวน]"\n• "[สินค้า] เหลือ [จำนวน]"'
      };
    }
  }
  
  // Detect unit hint
  let unitHint = null;
  const unitPatterns = {
    'ลัง': /ลัง|crate|box/i,
    'ขวด': /ขวด|bottle/i,
    'ถุง': /ถุง|bag/i,
    'แพ็ค': /แพ็ค|pack/i,
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
    const sorted = [...parsedNumbers].sort((a, b) => b - a);
    
    if (sorted[0] > 50 && sorted[1] <= 100) {
      priceHint = sorted[0];
      value = sorted[1];
    } else {
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
    .replace(/ถุง|ขวด|กล่อง|ชิ้น|ลัง|บาท|฿|แพ็ค|โหล|ละ|ราคา/gi, '')
    .trim();
  
  if (!productName) {
    return { 
      isAdjustment: false, 
      reason: 'no_product_name',
      errorMessage: '❌ ไม่พบชื่อสินค้า\n\n💡 ตัวอย่าง:\n• "น้ำแข็ง เหลือ 10"\n• "เติม โค้ก 30 20"'
    };
  }
  
  if (!value || value <= 0) {
    return { 
      isAdjustment: false, 
      reason: 'invalid_value',
      errorMessage: '❌ จำนวนไม่ถูกต้อง\n\n💡 จำนวนต้องเป็นตัวเลขบวก'
    };
  }
  
  // Match with hints
  const matches = fuzzyMatchStock(productName, stockCache, priceHint, unitHint);
  
  if (matches.length === 0) {
    return { 
      isAdjustment: false, 
      reason: 'product_not_found',
      searchTerm: productName,
      errorMessage: `❌ ไม่พบสินค้า: "${productName}"\n\n💡 ลองตรวจสอบ:\n• พิมพ์ชื่อสินค้าให้ชัดเจน\n• ดูรายการสต็อก: พิมพ์ "สต็อก"`
    };
  }
  
  // ✅ FIX: Better ambiguity handling
  if (matches.length > 1) {
    const scoreDiff = matches[0].score - matches[1].score;
    
    if (scoreDiff < 100 && matches[0].item.item !== matches[1].item.item) {
      Logger.warn(`⚠️ Ambiguous: "${productName}" matched ${matches.length} items`);
      
      // ✅ IMPROVED: Show clear examples with exact syntax
      return {
        isAdjustment: true,
        ambiguous: true,
        suggestions: matches.slice(0, 5).map(m => m.item),
        value: value,
        operation: operation,
        productName: productName,
        helpMessage: formatAmbiguityHelp(matches.slice(0, 5), operation, value)
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
// ✅ NEW: Format Ambiguity Help Message
// ============================================================================

function formatAmbiguityHelp(matches, operation, value) {
  const operationText = {
    'add': 'เติม',
    'subtract': 'ลด',
    'set': 'มี'
  }[operation] || 'มี';
  
  let msg = `🤔 พบสินค้าหลายรายการ กรุณาระบุให้ชัดเจน\n\n`;
  
  matches.forEach((match, idx) => {
    const item = match.item;
    msg += `${idx + 1}. ${item.item}\n`;
    msg += `   💰 ${item.price}฿ │ 📦 ${item.stock} ${item.unit}\n`;
    
    // ✅ Show exact command to use
    if (idx === 0) {
      msg += `   ✅ พิมพ์: "${operationText} ${item.item} ${value}"\n`;
    }
    
    msg += `\n`;
  });
  
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💡 วิธีระบุให้แม่นยำ:\n\n`;
  msg += `1️⃣ ใช้ชื่อเต็ม:\n`;
  msg += `   "${operationText} ${matches[0].item.item} ${value}"\n\n`;
  msg += `2️⃣ ระบุราคา:\n`;
  msg += `   "${operationText} ${matches[0].item.item.split(' ')[0]} ${matches[0].item.price} ${value}"\n\n`;
  msg += `3️⃣ ระบุหน่วย:\n`;
  msg += `   "${operationText} ${matches[0].item.item.split(' ')[0]} ${value} ${matches[0].item.unit}"`;
  
  return msg;
}

// ============================================================================
// ADJUST STOCK - ✅ IMPROVED: Better success messages
// ============================================================================

async function adjustStock(itemName, value, operation = 'set', reason = 'manual') {
  try {
    const stockCache = getStockCache();
    const item = stockCache.find(i => i.item === itemName);
    
    if (!item) {
      return { 
        success: false, 
        error: `❌ ไม่พบสินค้า: ${itemName}\n\n💡 พิมพ์ "สต็อก" เพื่อดูรายการทั้งหมด`
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
            error: `❌ ลดไม่ได้ สต็อกไม่พอ\n\n📊 มีอยู่: ${oldStock} ${item.unit}\n📉 ต้องการลด: ${value} ${item.unit}\n\n💡 ขาดไป ${Math.abs(newStock)} ${item.unit}`
          };
        }
        break;
      case 'set': 
        newStock = value;
        break;
      default:
        return { success: false, error: '❌ operation ไม่ถูกต้อง' };
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
      
      // ✅ IMPROVED: Better success message with warnings
      let successMsg = formatStockAdjustmentSuccess({
        item: item.item,
        price: item.price,
        oldStock,
        newStock,
        difference: newStock - oldStock,
        unit: item.unit,
        operation: operation,
        operationText: getOperationText(operation, value)
      });
      
      return {
        success: true,
        item: item.item,
        price: item.price,
        oldStock,
        newStock,
        difference: newStock - oldStock,
        unit: item.unit,
        operationText: getOperationText(operation, value),
        message: successMsg
      };
    }
    
    return { success: false, error: '❌ Database Error' };
    
  } catch (error) {
    Logger.error('adjustStock failed', error);
    return { success: false, error: `❌ เกิดข้อผิดพลาด: ${error.message}` };
  }
}

// ============================================================================
// ✅ IMPROVED: Format Success Message
// ============================================================================

function formatStockAdjustmentSuccess(result) {
  const icon = result.difference > 0 ? '📈' : result.difference < 0 ? '📉' : '➖';
  
  let msg = `${icon} ปรับสต็อกสำเร็จ!\n\n`;
  msg += `📦 ${result.item}\n`;
  msg += `💰 ${result.price}฿/${result.unit}\n\n`;
  msg += `📊 สต็อก: ${result.oldStock} → ${result.newStock} ${result.unit}\n`;
  
  if (result.difference !== 0) {
    msg += `${result.difference >= 0 ? '➕' : '➖'} ${Math.abs(result.difference)} ${result.unit}\n`;
  }
  
  msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `✅ ${result.operationText}\n`;
  
  // ✅ Smart warnings
  if (result.newStock === 0) {
    msg += `\n🔴 ⚠️ หมดสต็อก! ควรเติมโดยด่วน`;
  } else if (result.newStock <= 5) {
    msg += `\n🟡 ⚠️ สต็อกเหลือน้อย (${result.newStock} ${result.unit})`;
  } else if (result.newStock > 200) {
    msg += `\n💡 สต็อกเยอะมาก (${result.newStock} ${result.unit})`;
  }
  
  // ✅ Show next steps
  msg += `\n\n💡 คำสั่งอื่นๆ:`;
  msg += `\n• "สต็อก" - ดูรายการทั้งหมด`;
  msg += `\n• "เติม ${result.item} 50" - เติมเพิ่ม`;
  
  return msg;
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
// FUZZY MATCH (Keep from original - line 50-160)
// ============================================================================



function fuzzyMatchStock(searchTerm, stockCache, priceHint = null, unitHint = null) {
  const normalized = normalizeText(searchTerm);
  const keywords = extractStockKeywords(searchTerm);
  
  Logger.info(`🔍 Searching: "${searchTerm}" (price=${priceHint || '-'}, unit=${unitHint || '-'})`);
  
  let candidates = stockCache.filter(item => {
    const itemNorm = normalizeText(item.item);
    
    if (itemNorm.includes(normalized) || normalized.includes(itemNorm)) {
      return true;
    }
    
    const itemKeywords = extractStockKeywords(item.item);
    const overlap = keywords.filter(k => itemKeywords.includes(k)).length;
    
    return overlap >= 1;
  });

  if (priceHint) {
    const priceMatched = candidates.filter(item => 
      Math.abs(item.price - priceHint) <= Math.max(5, priceHint * 0.15)
    );
    
    if (priceMatched.length > 0) {
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
      candidates = unitMatched;
    }
  }

  const matches = candidates.map(item => {
    const itemNorm = normalizeText(item.item);
    const itemKeywords = extractStockKeywords(item.item);
    let score = 0;
    
    if (itemNorm === normalized) {
      score += 1000;
    } else if (itemNorm.includes(normalized)) {
      score += 500;
      if (itemNorm.startsWith(normalized)) {
        score += 100;
      }
    } else if (normalized.includes(itemNorm)) {
      score += 300;
    }
    
    const overlap = keywords.filter(k => itemKeywords.includes(k)).length;
    score += overlap * 50;
    
    if (priceHint) {
      if (item.price === priceHint) {
        score += 200;
      } else if (Math.abs(item.price - priceHint) <= priceHint * 0.05) {
        score += 100;
      }
    }
    
    if (unitHint) {
      const itemUnit = normalizeText(item.unit || '');
      if (itemUnit.includes(unitHint)) {
        score += 150;
      }
    }
    
    const lengthDiff = Math.abs(itemNorm.length - normalized.length);
    score -= (lengthDiff * 2);
    
    if (item.stock > 0) {
      score += 10;
    }

    return { item, score };
  });
  
  matches.sort((a, b) => b.score - a.score);
  
  return matches;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  parseAdjustmentCommand,
  adjustStock,
  fuzzyMatchStock,
  extractStockKeywords,
  formatAmbiguityHelp
};