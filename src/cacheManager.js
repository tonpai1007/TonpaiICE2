// cacheManager.js - Manages stock and customer caching with RAG integration

const { CONFIG } = require('./config');
const { Logger, PerformanceMonitor } = require('./logger');
const { normalizeText, generateSKU } = require('./utils');
const { getSheetData, appendSheetData, batchUpdateSheet } = require('./googleServices');
const { stockVectorStore, customerVectorStore } = require('./vectorStore');

// ============================================================================
// CACHE STATE
// ============================================================================

let stockCache = [];
let customerCache = [];
let lastStockLoadTime = 0;
let lastCustomerLoadTime = 0;

// ============================================================================
// STOCK CACHE
// ============================================================================

async function loadStockCache(forceReload = false) {
  try {
    const now = Date.now();
    if (!forceReload && stockCache.length > 0 && (now - lastStockLoadTime) < CONFIG.CACHE_DURATION) {
      Logger.info('Using cached stock data');
      return stockCache;
    }

    PerformanceMonitor.start('loadStockCache');
    Logger.info('Loading stock from Google Sheets...');

    // ✅ FIXED: Changed from 'รายการสินค้า' to 'สต็อก'
    let rows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');

    if (rows.length <= 1) {
      Logger.warn('⚠️ No stock data found');
      stockCache = [];
      return stockCache;
    }

    stockCache = rows.slice(1).map(row => ({
      item: (row[0] || '').trim(),
      cost: parseFloat(row[1] || 0),
      price: parseFloat(row[2] || 0),
      unit: (row[3] || '').trim(),
      stock: parseInt(row[4] || 0),
      category: (row[5] || '').trim(),
      sku: (row[6] || '').trim()
    }));

    // Generate missing SKUs
    const missingSkuItems = stockCache.filter(it => !it.sku);
    if (missingSkuItems.length > 0) {
      Logger.info(`Generating SKUs for ${missingSkuItems.length} items...`);
      const batchUpdates = [];
      
      stockCache.forEach((it, idx) => {
        if (!it.sku) {
          const newSKU = generateSKU(it.item, it.unit);
          it.sku = newSKU;
          batchUpdates.push({
            // ✅ FIXED: Changed to 'สต็อก'
            range: `สต็อก!G${idx + 2}`,
            values: [[newSKU]]
          });
        }
      });

      if (batchUpdates.length > 0) {
        await batchUpdateSheet(CONFIG.SHEET_ID, batchUpdates);
      }
    }

    lastStockLoadTime = now;
    rebuildStockVectorStore();

    Logger.success(`STOCK CACHE LOADED: ${stockCache.length} items`);
    PerformanceMonitor.end('loadStockCache');

    return stockCache;
  } catch (error) {
    Logger.error('loadStockCache error', error);
    if (error.message.includes('Quota exceeded') && stockCache.length > 0) {
      Logger.warn('Using stale cache due to quota limit');
      return stockCache;
    }
    throw error;
  }
}

function rebuildStockVectorStore() {
  stockVectorStore.rebuild(
    stockCache,
    // Text extractor
    (item) => {
      const keywords = extractKeywords(item.item);
      return [
        item.item,
        item.category,
        item.unit,
        item.sku,
        normalizeText(item.item),
        ...keywords
      ].filter(Boolean).join(' ');
    },
    // Metadata extractor
    (item, index) => ({
      index,
      item: item.item,
      price: item.price,
      unit: item.unit,
      stock: item.stock,
      category: item.category,
      sku: item.sku
    })
  );
}

function extractKeywords(name) {
  const normalized = normalizeText(name);
  const keywords = new Set([normalized]);
  
  // Add word tokens
  const tokens = name.split(/\s+/);
  tokens.forEach(t => {
    const norm = normalizeText(t);
    if (norm.length >= 2) keywords.add(norm);
  });
  
  // ✅ FIXED: Simple common variations instead of ITEM_ALIASES
  const commonVariations = {
    'น้ำแข็ง': ['น้ำ', 'แข็ง'],
    'เบียร์': ['เบีย', 'beer'],
    'โค้ก': ['โคก', 'coke'],
    'น้ำดื่ม': ['น้ำ', 'ดื่ม'],
    'น้ำอัดลม': ['น้ำ', 'อัดลม']
  };
  
  for (const [key, variations] of Object.entries(commonVariations)) {
    if (normalized.includes(normalizeText(key))) {
      keywords.add(normalizeText(key));
      variations.forEach(v => keywords.add(normalizeText(v)));
    }
  }
  
  return Array.from(keywords);
}
// ============================================================================
// CUSTOMER CACHE
// ============================================================================

async function loadCustomerCache(forceReload = false) {
  try {
    const now = Date.now();
    if (!forceReload && customerCache.length > 0 && (now - lastCustomerLoadTime) < CONFIG.CACHE_DURATION) {
      Logger.info('Using cached customer data');
      return customerCache;
    }

    PerformanceMonitor.start('loadCustomerCache');
    Logger.info('Loading customers from Google Sheets...');

    const rows = await getSheetData(CONFIG.SHEET_ID, 'ลูกค้า!A:D');
    
    // Initialize sample data if empty
      if (rows.length <= 1) {
      Logger.warn('⚠️ No customer data found');
      customerCache = [];
      return customerCache;
    }
    customerCache = rows.slice(1)
      .map(row => ({
        name: (row[0] || '').trim(),
        phone: (row[1] || '').trim(),
        address: (row[2] || '').trim(),
        notes: (row[3] || '').trim(),
        normalized: normalizeText(row[0] || '')
      }))
      .filter(c => c.name.length >= 2);

    lastCustomerLoadTime = now;

    // Build RAG vector store
    rebuildCustomerVectorStore();

    Logger.success(`CUSTOMER CACHE LOADED: ${customerCache.length} customers`);
    PerformanceMonitor.end('loadCustomerCache');

    return customerCache;
  } catch (error) {
    Logger.error('loadCustomerCache error', error);
    if (error.message.includes('Quota exceeded') && customerCache.length > 0) {
      Logger.warn('Using stale customer cache due to quota limit');
      return customerCache;
    }
    throw error;
  }
}

function rebuildCustomerVectorStore() {
  customerVectorStore.rebuild(
    customerCache,
    // Text extractor
    (customer) => [
      customer.name,
      customer.phone,
      customer.address,
      customer.normalized,
      ...customer.name.split(/\s+/)
    ].filter(Boolean).join(' '),
    // Metadata extractor
    (customer, index) => ({
      index,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      notes: customer.notes
    })
  );
}

// ============================================================================
// CACHE GETTERS
// ============================================================================

function getStockCache() {
  return stockCache;
}

function getCustomerCache() {
  return customerCache;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  loadStockCache,
  loadCustomerCache,
  getStockCache,
  getCustomerCache
};
