// src/orderParser.js - FIXED: Function order and dependencies
const { Logger } = require('./logger');
const { generateWithGroq } = require('./aiServices');
const { getStockCache, getCustomerCache } = require('./cacheManager');
const { normalizeText } = require('./utils');
const { extractProductKeywords } = require('./productMatcher');
// ============================================================================
// KEYWORD DEFINITIONS
// ============================================================================

const KEYWORDS = {
  CUSTOMER: ['[ลูกค้า]', '[customer]', '[ชื่อ]', '[name]'],
  ORDER: ['[สั่ง]', '[order]', '[ซื้อ]', '[buy]'],
  PRICE: ['[ราคา]', '[price]', '[ละ]', '[each]'],
  QUANTITY: ['[จำนวน]', '[qty]', '[quantity]', '[amount]'],
  DELIVERY: ['[ส่งโดย]', '[delivery]', '[ส่ง]', '[deliver]'],
  PAYMENT: ['[จ่าย]', '[paid]', '[ชำระ]', '[payment]']
};

// ============================================================================
// CORE UTILITIES - DEFINED FIRST
// ============================================================================

/**
 * Extract product keywords for matching
 * MUST BE DEFINED BEFORE buildSmartStockList
 */

/**
 * Calculate match confidence between stock item and price hint
 */
function calculateMatchConfidence(stockItem, priceHint) {
  if (!priceHint) return 'partial';
  
  if (stockItem.price === priceHint) {
    return 'exact';
  }
  
  if (Math.abs(stockItem.price - priceHint) <= (priceHint * 0.1)) {
    return 'fuzzy';
  }
  
  return 'partial';
}

// ============================================================================
// KEYWORD EXTRACTOR
// ============================================================================

function extractKeywordSections(text) {
  const sections = {
    customer: null,
    items: null,
    price: null,
    quantity: null,
    delivery: null,
    payment: null,
    hasKeywords: false
  };

  const allKeywords = Object.values(KEYWORDS).flat();
  const hasAnyKeyword = allKeywords.some(kw => text.includes(kw));
  
  if (!hasAnyKeyword) {
    return { ...sections, hasKeywords: false };
  }

  sections.hasKeywords = true;
  Logger.info('🔖 Detected keyword-based input');

  // Extract customer
  const customerPattern = new RegExp(
    `(${KEYWORDS.CUSTOMER.join('|')})\\s*([^\\[]+?)(?=\\[|$)`,
    'i'
  );
  const customerMatch = text.match(customerPattern);
  if (customerMatch) {
    sections.customer = customerMatch[2].trim();
    Logger.debug(`  [ลูกค้า] → "${sections.customer}"`);
  }

  // Extract items
  const orderPattern = new RegExp(
    `(${KEYWORDS.ORDER.join('|')})\\s*([^\\[]+?)(?=\\[|$)`,
    'i'
  );
  const orderMatch = text.match(orderPattern);
  if (orderMatch) {
    sections.items = orderMatch[2].trim();
    Logger.debug(`  [สั่ง] → "${sections.items}"`);
  }

  // Extract price
  const pricePattern = new RegExp(
    `(${KEYWORDS.PRICE.join('|')})\\s*(\\d+)`,
    'i'
  );
  const priceMatch = text.match(pricePattern);
  if (priceMatch) {
    sections.price = parseInt(priceMatch[2]);
    Logger.debug(`  [ราคา] → ${sections.price}฿`);
  }

  // Extract quantity
  const quantityPattern = new RegExp(
    `(${KEYWORDS.QUANTITY.join('|')})\\s*(\\d+)`,
    'i'
  );
  const quantityMatch = text.match(quantityPattern);
  if (quantityMatch) {
    sections.quantity = parseInt(quantityMatch[2]);
    Logger.debug(`  [จำนวน] → ${sections.quantity}`);
  }

  // Extract delivery
  const deliveryPattern = new RegExp(
    `(${KEYWORDS.DELIVERY.join('|')})\\s*([^\\[]+?)(?=\\[|$)`,
    'i'
  );
  const deliveryMatch = text.match(deliveryPattern);
  if (deliveryMatch) {
    sections.delivery = deliveryMatch[2].trim();
    Logger.debug(`  [ส่งโดย] → "${sections.delivery}"`);
  }

  // Extract payment
  const paymentPattern = new RegExp(
    `(${KEYWORDS.PAYMENT.join('|')})`,
    'i'
  );
  if (paymentPattern.test(text)) {
    sections.payment = 'paid';
    Logger.debug(`  [จ่าย] → PAID`);
  }

  return sections;
}

// ============================================================================
// PAYMENT STATUS DETECTOR
// ============================================================================

function detectPaymentStatus(text) {
  const lower = text.toLowerCase();
  
  if (/เครดิต|ค้าง(?:ชำระ)?|ยังไม่จ่าย/.test(lower)) {
    return { status: 'unpaid', confidence: 'high' };
  }
  
  if (/จ่าย(?:แล้ว|เงิน)|ชำระ(?:แล้ว|เงิน)|เงินสด|โอน(?:แล้ว|เงิน)/.test(lower)) {
    return { status: 'paid', confidence: 'high' };
  }
  
  return { status: null, confidence: 'none' };
}

// ============================================================================
// EXTRACT PRICE HINTS
// ============================================================================

function extractPriceHints(text, keywordPrice = null, keywordQty = null) {
  const hints = [];
  
  if (keywordPrice || keywordQty) {
    Logger.info('💡 Using keyword hints');
    
    let productName = text;
    const allKeywords = Object.values(KEYWORDS).flat();
    allKeywords.forEach(kw => {
      productName = productName.replace(new RegExp(kw, 'gi'), '');
    });
    
    productName = productName.replace(/\d+/g, '').trim();
    
    if (productName && (keywordPrice || keywordQty)) {
      hints.push({
        keyword: productName.toLowerCase(),
        price: keywordPrice,
        quantity: keywordQty,
        confidence: 'high',
        productKeywords: extractProductKeywords(productName)
      });
    }
  }
  
  const explicitMatches = text.matchAll(/([ก-๙a-z0-9\.\-\(\)]+)\s+(?:ราคา\s+)?(\d+)\s*(?:บาท|฿)/gi);
  for (const match of explicitMatches) {
    const productName = match[1].toLowerCase();
    hints.push({ 
      keyword: productName, 
      price: parseInt(match[2]),
      confidence: 'high',
      productKeywords: extractProductKeywords(productName)
    });
  }

  const tripleMatches = text.matchAll(/([ก-๙a-z0-9\s\.\-\(\)]+?)\s+(\d+)\s+(\d+)/gi);
  for (const match of tripleMatches) {
    const productName = match[1].trim();
    const num1 = parseInt(match[2]);
    const num2 = parseInt(match[3]);
    
    if (num1 > 10 && num2 <= 100) {
      hints.push({ 
        keyword: productName.toLowerCase(), 
        price: num1,
        quantity: num2,
        confidence: 'medium',
        productKeywords: extractProductKeywords(productName)
      });
    }
  }

  return hints;
}

// ============================================================================
// BUILD SMART STOCK LIST
// ============================================================================

function buildSmartStockList(stockCache, priceHints) {
  let stockList = '';
  
  const scoredItems = stockCache.map((item, idx) => {
    let score = 0;
    const itemLower = item.item.toLowerCase();
    const itemKeywords = extractProductKeywords(item.item);
    
    for (const hint of priceHints) {
      const keywordOverlap = hint.productKeywords?.filter(k => 
        itemKeywords.includes(k) || itemLower.includes(k)
      ).length || 0;
      
      if (keywordOverlap > 0) {
        score += keywordOverlap * 15;
        
        if (itemLower.includes(hint.keyword)) {
          score += 20;
        }
        
        if (item.price === hint.price) {
          score += 100;
        } else if (Math.abs(item.price - hint.price) <= hint.price * 0.15) {
          score += 40;
        }
        
        if (hint.quantity && item.stock >= hint.quantity) {
          score += 10;
        }
      }
    }
    
    if (item.stock > 50) score += 3;
    if (item.stock > 100) score += 2;
    
    return { item, idx, score };
  });
  
  scoredItems.sort((a, b) => b.score - a.score);
  
  const priorityItems = scoredItems.filter(s => s.score >= 20);
  
  if (priorityItems.length > 0) {
    stockList += '🎯 [PRIORITY MATCHES]:\n';
    priorityItems.slice(0, 10).forEach(({ item, idx, score }) => {
      stockList += `ID:${idx} | ⭐${score} | ${item.item} | ${item.price}฿ | ${item.stock} ${item.unit}\n`;
    });
    stockList += '\n[ALL ITEMS]:\n';
  }
  
  scoredItems.slice(0, 100).forEach(({ item, idx }) => {
    stockList += `ID:${idx} | ${item.item} | ${item.price}฿ | ${item.stock} ${item.unit}\n`;
  });
  
  return stockList;
}

// ============================================================================
// SPLIT MULTIPLE INTENTS
// ============================================================================

function splitMultipleIntents(text) {
  const lower = text.toLowerCase();
  
  // Try keyword extraction first
  const keywordSections = extractKeywordSections(text);
  
  if (keywordSections.hasKeywords) {
    Logger.info('📋 Using keyword-based parsing');
    
    return {
      type: 'order',
      customer: keywordSections.customer || 'ไม่ระบุ',
      itemsPart: keywordSections.items || '',
      priceHint: keywordSections.price,
      quantityHint: keywordSections.quantity,
      deliveryPerson: keywordSections.delivery || '',
      hasPaid: keywordSections.payment === 'paid',
      hasDelivery: !!keywordSections.delivery,
      confidence: 'high',
      pattern: 'keyword_based',
      intents: {
        hasOrder: !!keywordSections.items,
        hasPayment: !!keywordSections.payment,
        hasDelivery: !!keywordSections.delivery
      }
    };
  }

  // Fallback to natural language
  Logger.info('📝 Using natural language parsing');
  
  const paidKeywords = /จ่าย(?:แล้ว|เงิน)|ชำระ(?:แล้ว|เงิน)|โอน(?:แล้ว|เงิน)|เงินสด/i;
  
  const intents = {
    hasOrder: false,
    hasPayment: false,
    hasDelivery: false
  };
  
  if (/สั่ง|ซื้อ|เอา|ขอ|จอง/.test(lower)) {
    intents.hasOrder = true;
  }
  
  const hasExplicitPaid = /จ่าย(?:แล้ว|เงิน)|ชำระ(?:แล้ว)|โอนแล้ว/i.test(text);
  
  if (hasExplicitPaid) {
    intents.paymentStatus = 'paid';
  }
  
  if (/ส่ง|จัดส่ง|delivery|ผู้ส่ง/.test(lower)) {
    intents.hasDelivery = true;
  }
  
  const patterns = [
    {
      regex: /ส่ง(?:โดย|ให้)\s+(\S+)|(?:โดย|ให้)\s+(\S+)\s*ส่ง/i,
      extract: (match, fullText) => {
        const deliveryPerson = (match[1] || match[2] || '').trim();
        
        const cleanText = fullText
          .replace(/ส่ง(?:โดย|ให้)\s+\S+/gi, '')
          .replace(/(?:โดย|ให้)\s+\S+\s*ส่ง/gi, '')
          .trim();
        
        const orderMatch = cleanText.match(/((?:คุณ|พี่|น้อง|เจ๊|ร้าน)\s*\S+)\s*(?:สั่ง|เอา)\s+(.+)/i);
        
        if (orderMatch) {
          return {
            customer: orderMatch[1].trim(),
            itemsPart: orderMatch[2].trim(),
            deliveryPerson: deliveryPerson,
            hasPaid: paidKeywords.test(fullText),
            hasDelivery: true,
            confidence: 'high',
            pattern: 'delivery_extracted'
          };
        }
        
        return null;
      }
    },
    
    {
      regex: /((?:คุณ|พี่|น้อง|เจ๊|ร้าน)\s*\S+)\s*(?:สั่ง|เอา)\s+(.+)/i,
      extract: (match, fullText) => {
        const customer = match[1].trim();
        let itemsPart = match[2].trim();
        
        let deliveryPerson = '';
        const deliveryMatch = itemsPart.match(/ส่ง(?:โดย|ให้)?\s*(\S+)|(?:โดย|ให้)\s*(\S+)\s*ส่ง/i);
        
        if (deliveryMatch) {
          deliveryPerson = (deliveryMatch[1] || deliveryMatch[2] || '').trim();
          itemsPart = itemsPart
            .replace(/ส่ง(?:โดย|ให้)?\s*\S+/gi, '')
            .replace(/(?:โดย|ให้)\s*\S+\s*ส่ง/gi, '')
            .trim();
        }
        
        return {
          customer,
          itemsPart,
          deliveryPerson,
          hasPaid: paidKeywords.test(fullText),
          hasDelivery: deliveryPerson !== '',
          confidence: 'high',
          pattern: 'customer_first'
        };
      }
    }
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) {
      const extracted = pattern.extract(match, text);
      
      if (extracted && extracted.itemsPart) {
        Logger.info(`🎯 Pattern: ${extracted.pattern}`);
        
        return {
          ...extracted,
          type: 'order',
          intents: {
            ...intents,
            hasOrder: true,
            hasPayment: extracted.hasPaid,
            hasDelivery: extracted.hasDelivery
          }
        };
      }
    }
  }
  
  return null;
}

// ============================================================================
// BOOST CONFIDENCE
// ============================================================================

function boostConfidence(aiResult, mappedItems, userInput, customerCache, preProcessed) {
  let confidence = aiResult.confidence || 'low';
  const boostReasons = [];

  const allExactMatch = mappedItems.every(item => item.matchConfidence === 'exact');
  if (allExactMatch && mappedItems.length > 0) {
    boostReasons.push('exact_price_match');
  }

  if (aiResult.customer && aiResult.customer !== 'ไม่ระบุ') {
    boostReasons.push('customer_mentioned');
    
    const customerExists = customerCache.some(c => 
      c.name.toLowerCase().includes(aiResult.customer?.toLowerCase())
    );
    if (customerExists) {
      boostReasons.push('known_customer');
    }
  }

  const allInStock = mappedItems.every(item => item.stockItem.stock >= item.quantity);
  if (allInStock) {
    boostReasons.push('stock_available');
  }

  if (/\d+\s+\d+/.test(userInput)) {
    boostReasons.push('clear_quantity_pattern');
  }
  
  if (preProcessed?.hasPaid) {
    boostReasons.push('payment_confirmed');
  }

  if (confidence === 'medium' && boostReasons.length >= 3) {
    Logger.info(`🚀 Confidence: medium → high`);
    return 'high';
  }

  if (confidence === 'low' && boostReasons.length >= 4) {
    Logger.info(`🚀 Confidence: low → medium`);
    return 'medium';
  }

  return confidence;
}

// ============================================================================
// MAIN PARSE ORDER
// ============================================================================

async function parseOrder(userInput) {
  const stockCache = getStockCache();
  const customerCache = getCustomerCache();
  
  const keywordSections = extractKeywordSections(userInput);
  const preProcessed = splitMultipleIntents(userInput);
  const paymentDetection = detectPaymentStatus(userInput);
  
  const priceHints = extractPriceHints(
    userInput, 
    preProcessed?.priceHint || keywordSections.price,
    preProcessed?.quantityHint || keywordSections.quantity
  );
  
  Logger.info(`🎯 Pre-processed: ${JSON.stringify(preProcessed)}`);
  Logger.info(`💰 Payment: ${paymentDetection.status}`);
  Logger.info(`💡 Hints: ${JSON.stringify(priceHints)}`);
  
  const smartCatalog = buildSmartStockList(stockCache, priceHints);

  const prompt = `คุณคือ AI วิเคราะห์คำสั่งซื้อ

📦 คลังสินค้า:
${smartCatalog}

👥 ลูกค้า: ${customerCache.map(c => c.name).join(', ')}

💬 ข้อความ: "${userInput}"

${preProcessed ? `
🔍 ตรวจพบ:
- ลูกค้า: ${preProcessed.customer}
- สินค้า: ${preProcessed.itemsPart}
- จ่ายแล้ว: ${preProcessed.hasPaid ? 'ใช่' : 'ไม่'}
- ส่ง: ${preProcessed.hasDelivery ? 'ใช่' : 'ไม่'}
${preProcessed.priceHint ? `- ราคา: ${preProcessed.priceHint}฿` : ''}
${preProcessed.quantityHint ? `- จำนวน: ${preProcessed.quantityHint}` : ''}
` : ''}

📋 กฎ:
1. ใช้ข้อมูลจาก hint ถ้ามี
2. เลือกสินค้า ⭐ ก่อน
3. ถ้ามี "ส่ง" → deliveryPerson ต้องมีค่า
4. ถ้ามี "จ่าย" → isPaid: true

JSON:
{
  "intent": "order",
  "customer": "ชื่อ",
  "items": [{"stockId": 0, "quantity": 1}],
  "isPaid": false,
  "deliveryPerson": "",
  "confidence": "high|medium|low",
  "reasoning": "เหตุผล"
}`;

  try {
    const aiResult = await generateWithGroq(prompt, true);
    
    const mappedItems = (aiResult.items || []).map(i => {
      const stockItem = stockCache[i.stockId];
      if (!stockItem) return null;
      
      const priceHint = priceHints.find(h => 
        stockItem.item.toLowerCase().includes(h.keyword)
      );
      
      return {
        stockItem: stockItem,
        quantity: i.quantity || preProcessed?.quantityHint || 1,
        matchConfidence: calculateMatchConfidence(stockItem, priceHint?.price)
      };
    }).filter(i => i !== null);

    const boostedConfidence = boostConfidence(
      aiResult, 
      mappedItems, 
      userInput, 
      customerCache,
      preProcessed
    );

    const result = {
      ...aiResult,
      items: mappedItems,
      confidence: boostedConfidence,
      isPaid: preProcessed?.hasPaid || aiResult.isPaid || false,
      deliveryPerson: preProcessed?.hasDelivery 
        ? (aiResult.deliveryPerson || preProcessed.deliveryPerson || preProcessed.customer) 
        : (aiResult.deliveryPerson || ''),
      rawInput: userInput
    };
    
    Logger.success(`✅ Parsed: ${result.customer}, ${result.items.length} items`);

    return [result];

  } catch (error) {
    Logger.error('parseOrder failed', error);
    return [{ success: false, error: 'AI Error' }];
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = { 
  parseOrder,
  extractPriceHints,
  extractProductKeywords,
  extractKeywordSections,
  buildSmartStockList,
  boostConfidence,
  calculateMatchConfidence,
  splitMultipleIntents,
  detectPaymentStatus,
  KEYWORDS
};