// orderParser.js - COMPLETELY REBUILT WITH ARCHITECTURAL INTEGRITY
// ============================================================================
// Design Philosophy:
// 1. Single Source of Truth: Stock cache structure is THE contract
// 2. Fail-Fast Validation: Catch errors early, provide clear messages
// 3. Consistent Output: Always return the SAME structure regardless of path
// ============================================================================

const { Logger } = require('./logger');
const { normalizeText, calculateAdvancedSimilarity } = require('./utils');
const { generateWithGemini, isGeminiAvailable } = require('./aiServices');
const { getStockCache } = require('./cacheManager');
const { stockVectorStore } = require('./vectorStore');

// ============================================================================
// CONFIDENCE THRESHOLDS
// ============================================================================

const CONFIDENCE = {
  PERFECT_MATCH: 0.95,    // Exact or near-exact match
  HIGH: 0.80,             // Very confident
  MEDIUM: 0.65,           // Acceptable
  LOW: 0.50,              // Risky but allowed
  REJECT: 0.49            // Below this = reject
};

// ============================================================================
// CORE: FIND BEST MATCHING PRODUCT
// ============================================================================

function findBestMatch(searchTerm, stockCache, minConfidence = CONFIDENCE.LOW) {
  if (!searchTerm || !stockCache || stockCache.length === 0) {
    Logger.warn('Invalid search parameters');
    return null;
  }

  const normalized = normalizeText(searchTerm);
  Logger.info(`Searching for: "${searchTerm}" (normalized: "${normalized}")`);

  let bestMatch = null;
  let bestScore = 0;
  let matchMethod = 'none';

  // ========================================================================
  // PHASE 1: EXACT MATCH (Highest Priority)
  // ========================================================================
  for (const product of stockCache) {
    const productNorm = normalizeText(product.item);
    
    if (productNorm === normalized) {
      Logger.success(`EXACT MATCH: "${product.item}" (100%)`);
      return {
        product,
        confidence: 1.0,
        method: 'exact'
      };
    }
  }

  // ========================================================================
  // PHASE 2: SUBSTRING MATCH (High Priority)
  // ========================================================================
  for (const product of stockCache) {
    const productNorm = normalizeText(product.item);
    
    // Check if search term contains product name
    if (normalized.includes(productNorm)) {
      const score = 0.90 + (productNorm.length / normalized.length) * 0.09;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = product;
        matchMethod = 'substring_product_in_search';
      }
    }
    
    // Check if product name contains search term
    if (productNorm.includes(normalized)) {
      const score = 0.85 + (normalized.length / productNorm.length) * 0.09;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = product;
        matchMethod = 'substring_search_in_product';
      }
    }
  }

  // ========================================================================
  // PHASE 3: FUZZY SIMILARITY (Medium Priority)
  // ========================================================================
  if (bestScore < CONFIDENCE.HIGH) {
    for (const product of stockCache) {
      const productNorm = normalizeText(product.item);
      const similarity = calculateAdvancedSimilarity(normalized, productNorm);
      
      if (similarity > bestScore) {
        bestScore = similarity;
        bestMatch = product;
        matchMethod = 'fuzzy';
      }
    }
  }

  // ========================================================================
  // PHASE 4: RAG VECTOR SEARCH (Fallback)
  // ========================================================================
  if (bestScore < CONFIDENCE.MEDIUM) {
    Logger.info('Using RAG vector search...');
    const ragResults = stockVectorStore.search(searchTerm, 3, 0.3);
    
    if (ragResults.length > 0) {
      const topResult = ragResults[0];
      const ragProduct = stockCache[topResult.metadata.index];
      
      if (ragProduct && topResult.similarity > bestScore) {
        bestScore = topResult.similarity * 0.9; // Slight penalty for RAG
        bestMatch = ragProduct;
        matchMethod = 'rag_vector';
      }
    }
  }

  // ========================================================================
  // VALIDATION & RETURN
  // ========================================================================
  if (!bestMatch || bestScore < minConfidence) {
    Logger.warn(`No match found for "${searchTerm}" (best: ${bestScore.toFixed(3)})`);
    return null;
  }

  const confidencePercent = (bestScore * 100).toFixed(1);
  Logger.success(`Match: "${bestMatch.item}" (${confidencePercent}% via ${matchMethod})`);

  return {
    product: bestMatch,
    confidence: bestScore,
    method: matchMethod
  };
}

// ============================================================================
// GEMINI-POWERED MULTI-ITEM PARSER
// ============================================================================

async function parseWithGemini(text, customerName) {
  if (!isGeminiAvailable()) {
    throw new Error('GEMINI_UNAVAILABLE');
  }

  Logger.info('Gemini parsing multi-item order...');

  const stockCache = getStockCache();
  
  if (stockCache.length === 0) {
    throw new Error('STOCK_CACHE_EMPTY');
  }

  // Build product reference (limit to 50 for token efficiency)
  const productList = stockCache
    .slice(0, 50)
    .map(p => `- ${p.item} (${p.unit})`)
    .join('\n');

  const schema = {
    type: 'object',
    properties: {
      customer: {
        type: 'string',
        description: 'Customer name'
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            product_name: {
              type: 'string',
              description: 'Product name matching inventory'
            },
            quantity: {
              type: 'number',
              description: 'Quantity ordered'
            }
          },
          required: ['product_name', 'quantity']
        }
      },
      is_multi_item: {
        type: 'boolean',
        description: 'Whether order has multiple items'
      }
    },
    required: ['customer', 'items', 'is_multi_item']
  };

  const prompt = `You are an AI assistant parsing Thai product orders.

Available Products:
${productList}

Customer Input:
"${text}"

${customerName ? `Detected Customer: "${customerName}"` : ''}

Task:
1. Identify customer name
2. Extract all products and quantities
3. Match products to inventory list (use closest match)

Rules:
- Use exact product names from inventory
- If quantity not specified, use 1
- If customer not found, use "Customer"

Example:
Input: "Somchai order ice 2 bags, beer 5 cans"
Output: {
  "customer": "Somchai",
  "items": [
    {"product_name": "ice", "quantity": 2},
    {"product_name": "beer", "quantity": 5}
  ],
  "is_multi_item": true
}

Return valid JSON that can be immediately processed.`;

  try {
    const result = await generateWithGemini(prompt, schema, 0.1);
    
    Logger.info(`Gemini identified: ${result.items.length} items`);
    
    return {
      success: true,
      customer: result.customer || customerName || 'Customer',
      rawItems: result.items,
      isMultiItem: result.is_multi_item
    };
    
  } catch (error) {
    Logger.error('Gemini parsing failed', error);
    throw new Error('GEMINI_PARSE_FAILED');
  }
}

// ============================================================================
// MULTI-ITEM ORDER PROCESSOR
// ============================================================================

async function processMultiItemOrder(rawItems, customerName, stockCache) {
  Logger.info(`Processing ${rawItems.length} items...`);

  const parsedItems = [];
  const failures = [];

  for (const rawItem of rawItems) {
    const productName = rawItem.product_name;
    const quantity = parseFloat(rawItem.quantity) || 1;

    Logger.info(`Item: "${productName}" x${quantity}`);

    // Find matching product
    const matchResult = findBestMatch(productName, stockCache, CONFIDENCE.LOW);

    if (!matchResult) {
      failures.push({
        input: productName,
        reason: 'Product not found in inventory'
      });
      Logger.warn(`No match for: "${productName}"`);
      continue;
    }

    // Validate confidence
    if (matchResult.confidence < CONFIDENCE.LOW) {
      failures.push({
        input: productName,
        matched: matchResult.product.item,
        confidence: matchResult.confidence,
        reason: 'Confidence too low'
      });
      Logger.warn(`Low confidence: ${matchResult.confidence.toFixed(2)}`);
      continue;
    }

    // Validate quantity
    if (quantity <= 0 || quantity > 10000) {
      failures.push({
        input: productName,
        reason: `Invalid quantity: ${quantity}`
      });
      Logger.warn(`Invalid quantity: ${quantity}`);
      continue;
    }

    // SUCCESS: Add to parsed items
    parsedItems.push({
      stockItem: matchResult.product, // CRITICAL: This is the contract
      quantity: quantity,
      confidence: matchResult.confidence,
      matchMethod: matchResult.method
    });

    Logger.success(`Added: ${matchResult.product.item} x${quantity}`);
  }

  // ========================================================================
  // VALIDATION: Did we parse at least ONE item?
  // ========================================================================
  if (parsedItems.length === 0) {
    Logger.error('No items successfully parsed');
    
    let errorMsg = 'Cannot parse any products\n\n';
    
    if (failures.length > 0) {
      errorMsg += 'Products not found:\n';
      failures.forEach(f => {
        errorMsg += `- "${f.input}": ${f.reason}\n`;
      });
      errorMsg += '\nPlease check product names against inventory';
    }
    
    throw new Error(errorMsg);
  }

  // ========================================================================
  // SUCCESS: Return standardized structure
  // ========================================================================
  Logger.success(`Parsed ${parsedItems.length}/${rawItems.length} items successfully`);

  return {
    success: true,
    customer: customerName,
    items: parsedItems, // Array of { stockItem, quantity, confidence, matchMethod }
    failedItems: failures,
    totalItems: parsedItems.length
  };
}

// ============================================================================
// MAIN ENTRY POINT: PARSE ORDER
// ============================================================================

async function parseOrder(text, customerContext = null) {
  try {
    Logger.info('Starting order parse...');
    Logger.info(`Input: "${text}"`);

    const stockCache = getStockCache();
    
    if (stockCache.length === 0) {
      throw new Error('STOCK_CACHE_EMPTY: Please refresh cache');
    }

    // Extract customer name from context or text
    let customerName = customerContext?.name || null;
    
    if (!customerName) {
      // Try to extract customer name from Thai text patterns
      const customerMatch = text.match(/^([\u0E00-\u0E7Fa-zA-Z\s]+?)(?:\s+\u0E2A\u0E31\u0E48\u0E07|\s+\u0E0B\u0E37\u0E49\u0E2D|\s+\u0E40\u0E2D\u0E32)/);
      if (customerMatch) {
        customerName = customerMatch[1].trim();
        Logger.info(`Customer detected: "${customerName}"`);
      }
    }

    customerName = customerName || 'Customer';

    // ========================================================================
    // DECISION: Use Gemini or Fallback?
    // ========================================================================
    
    let geminiResult = null;
    
    if (isGeminiAvailable()) {
      try {
        geminiResult = await parseWithGemini(text, customerName);
        Logger.success('Gemini parsing successful');
      } catch (geminiError) {
        Logger.warn('Gemini failed, using fallback', geminiError.message);
      }
    } else {
      Logger.info('Gemini unavailable, using direct fallback');
    }

    // ========================================================================
    // PROCESS ITEMS (Gemini or Manual Extraction)
    // ========================================================================
    
    let rawItems = [];
    
    if (geminiResult && geminiResult.rawItems) {
      rawItems = geminiResult.rawItems;
      customerName = geminiResult.customer;
    } else {
      // Manual extraction fallback
      Logger.info('Manual item extraction...');
      
      // Remove customer name from text (Thai pattern)
      let cleanText = text.replace(/^[\u0E00-\u0E7Fa-zA-Z\s]+?(?:\u0E2A\u0E31\u0E48\u0E07|\u0E0B\u0E37\u0E49\u0E2D|\u0E40\u0E2D\u0E32)\s*/, '');
      
      // Check if multi-item (comma-separated)
      const isMultiItem = /[,،]/.test(cleanText);
      
      if (isMultiItem) {
        const segments = cleanText.split(/[,،]/).map(s => s.trim()).filter(Boolean);
        
        for (const segment of segments) {
          const qtyMatch = segment.match(/(\d+(?:\.\d+)?)/);
          const quantity = qtyMatch ? parseFloat(qtyMatch[1]) : 1;
          const productName = segment
            .replace(/\d+(?:\.\d+)?/g, '')
            .replace(/\u0E16\u0E38\u0E07|\u0E25\u0E31\u0E07|\u0E02\u0E27\u0E14|\u0E01\u0E25\u0E48\u0E2D\u0E07|\u0E41\u0E1E\u0E47\u0E04/g, '')
            .trim();
          
          rawItems.push({ product_name: productName, quantity });
        }
      } else {
        // Single item
        const qtyMatch = cleanText.match(/(\d+(?:\.\d+)?)/);
        const quantity = qtyMatch ? parseFloat(qtyMatch[1]) : 1;
        const productName = cleanText
          .replace(/\d+(?:\.\d+)?/g, '')
          .replace(/\u0E16\u0E38\u0E07|\u0E25\u0E31\u0E07|\u0E02\u0E27\u0E14|\u0E01\u0E25\u0E48\u0E2D\u0E07|\u0E41\u0E1E\u0E47\u0E04/g, '')
          .trim();
        
        rawItems.push({ product_name: productName, quantity });
      }
    }

    Logger.info(`Found ${rawItems.length} raw items to process`);

    // ========================================================================
    // PROCESS & VALIDATE ALL ITEMS
    // ========================================================================
    
    const result = await processMultiItemOrder(rawItems, customerName, stockCache);
    
    // Build warning message if needed
    let warning = null;
    
    if (result.failedItems && result.failedItems.length > 0) {
      warning = `Warning: Could not parse some items (${result.failedItems.length}):\n`;
      result.failedItems.slice(0, 3).forEach(f => {
        warning += `- ${f.input}\n`;
      });
    }

    return {
      success: true,
      customer: result.customer,
      items: result.items, // CRITICAL: Array of { stockItem, quantity }
      warning
    };

  } catch (error) {
    Logger.error('Parse order failed', error);
    
    // User-friendly error
    if (error.message.includes('STOCK_CACHE_EMPTY')) {
      return {
        success: false,
        error: 'System not loaded properly. Please type "refresh"'
      };
    }
    
    if (error.message.startsWith('Cannot parse')) {
      return {
        success: false,
        error: error.message
      };
    }
    
    return {
      success: false,
      error: 'Cannot parse order. Please try again or contact admin.'
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  parseOrder,
  findBestMatch,
  parseWithGemini,
  processMultiItemOrder,
  CONFIDENCE
};