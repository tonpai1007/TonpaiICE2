// src/cacheManager.js - FIXED: Proper imports

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
// EXTRACT KEYWORDS - SHARED FUNCTION
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
    'น้ำแข็ง': ['น้ำ', 'แข็ง', 'ice'],
    'โค้ก': ['โคก', 'coke', 'coca'],
    'เป็ปซี่': ['pepsi', 'เปปซี่'],
    'สิงห์': ['singha', 'singh'],
    'ช้าง': ['chang', 'elephant'],
    'ลีโอ': ['leo'],
    'น้ำดื่ม': ['water', 'น้ำ'],
    'ลัง': ['box', 'case', 'crate'],
    'ขวด': ['bottle'],
    'ถุง': ['bag']
  };
  
  for (const [key, vars] of Object.entries(variations)) {
    if (normalized.includes(normalizeText(key))) {
      vars.forEach(v => keywords.add(normalizeText(v)));
    }
  }
  
  return Array.from(keywords);
}

function extractCustomerKeywords(name) {
  const keywords = new Set();
  
  // Common Thai prefixes
  const prefixes = ['คุณ', 'พี่', 'น้อง', 'เจ๊', 'ป้า', 'ลุง', 'อา', 'ร้าน'];
  
  prefixes.forEach(prefix => {
    if (name.includes(prefix)) {
      const withoutPrefix = name.replace(prefix, '').trim();
      if (withoutPrefix) {
        keywords.add(normalizeText(withoutPrefix));
      }
    }
  });
  
  // Location keywords
  const locations = ['ตลาด', 'หน้าปาก', 'ซอย', 'ข้าง', 'หลัง'];
  locations.forEach(loc => {
    if (name.includes(loc)) {
      keywords.add(normalizeText(loc));
    }
  });
  
  return Array.from(keywords);
}

// ============================================================================
// STOCK CACHE
// ============================================================================

async function loadStockCache(forceReload = false) {
  try {
    const now = Date.now();
    if (!forceReload && stockCache.length > 0 && (now - lastStockLoadTime) < CONFIG.CACHE_DURATION) {
      Logger.info('📦 Using cached stock data');
      return stockCache;
    }

    PerformanceMonitor.start('loadStockCache');
    Logger.info('📦 Loading stock from Google Sheets...');

    const rows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');

    if (rows.length <= 1) {
      Logger.warn('⚠️ No stock data found - sheet may be empty');
      stockCache = [];
      return stockCache;
    }

    stockCache = rows.slice(1)
      .filter(row => row[0]) // Filter out empty rows
      .map(row => ({
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
      Logger.info(`🔧 Generating SKUs for ${missingSkuItems.length} items...`);
      const batchUpdates = [];
      
      stockCache.forEach((it, idx) => {
        if (!it.sku) {
          const newSKU = generateSKU(it.item, it.unit);
          it.sku = newSKU;
          batchUpdates.push({
            range: `สต็อก!G${idx + 2}`,
            values: [[newSKU]]
          });
        }
      });

      if (batchUpdates.length > 0) {
        await batchUpdateSheet(CONFIG.SHEET_ID, batchUpdates);
        Logger.success(`✅ Generated ${batchUpdates.length} SKUs`);
      }
    }

    lastStockLoadTime = now;
    
    // Rebuild vector store
    rebuildStockVectorStore();

    Logger.success(`✅ STOCK LOADED: ${stockCache.length} items`);
    PerformanceMonitor.end('loadStockCache');

    return stockCache;
  } catch (error) {
    Logger.error('❌ loadStockCache error', error);
    if (error.message.includes('Quota exceeded') && stockCache.length > 0) {
      Logger.warn('⚠️ Using stale cache due to quota limit');
      return stockCache;
    }
    throw error;
  }
}

function rebuildStockVectorStore() {
  Logger.info('🧹 Clearing old vector store data...');
  stockVectorStore.clear();
  
  stockVectorStore.rebuild(
    stockCache,
    // Text extractor
    (item) => {
      const keywords = extractStockKeywords(item.item);
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
      cost: item.cost,
      unit: item.unit,
      stock: item.stock,
      category: item.category,
      sku: item.sku
    })
  );
  
  Logger.success(`🔍 Stock Vector Store: ${stockVectorStore.size()} items indexed`);
}

// ============================================================================
// CUSTOMER CACHE
// ============================================================================

async function loadCustomerCache(forceReload = false) {
  try {
    const now = Date.now();
    if (!forceReload && customerCache.length > 0 && (now - lastCustomerLoadTime) < CONFIG.CACHE_DURATION) {
      Logger.info('👤 Using cached customer data');
      return customerCache;
    }

    PerformanceMonitor.start('loadCustomerCache');
    Logger.info('👤 Loading customers from Google Sheets...');

    const rows = await getSheetData(CONFIG.SHEET_ID, 'ลูกค้า!A:D');
    
    if (rows.length <= 1) {
      Logger.warn('⚠️ No customer data found - sheet may be empty');
      customerCache = [];
      return customerCache;
    }

    customerCache = rows.slice(1)
      .filter(row => row[0]) // Filter out empty rows
      .map(row => ({
        name: (row[0] || '').trim(),
        phone: (row[1] || '').trim(),
        address: (row[2] || '').trim(),
        notes: (row[3] || '').trim(),
        normalized: normalizeText(row[0] || '')
      }))
      .filter(c => c.name.length >= 2); // Remove invalid entries

    lastCustomerLoadTime = now;

    // Rebuild vector store
    rebuildCustomerVectorStore();

    Logger.success(`✅ CUSTOMERS LOADED: ${customerCache.length} customers`);
    PerformanceMonitor.end('loadCustomerCache');

    return customerCache;
  } catch (error) {
    Logger.error('❌ loadCustomerCache error', error);
    if (error.message.includes('Quota exceeded') && customerCache.length > 0) {
      Logger.warn('⚠️ Using stale customer cache due to quota limit');
      return customerCache;
    }
    throw error;
  }
}

function rebuildCustomerVectorStore() {
  Logger.info('🧹 Clearing old customer vector store data...');
  customerVectorStore.clear();
  
  customerVectorStore.rebuild(
    customerCache,
    // Text extractor
    (customer) => {
      const tokens = customer.name.split(/\s+/);
      return [
        customer.name,
        customer.phone,
        customer.address,
        customer.normalized,
        ...tokens,
        ...extractCustomerKeywords(customer.name)
      ].filter(Boolean).join(' ');
    },
    // Metadata extractor
    (customer, index) => ({
      index,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      notes: customer.notes
    })
  );
  
  Logger.success(`🔍 Customer Vector Store: ${customerVectorStore.size()} customers indexed`);
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
// MEMORY MONITORING
// ============================================================================

function getCacheStats() {
  return {
    stock: {
      items: stockCache.length,
      vectorSize: stockVectorStore.size(),
      lastLoaded: new Date(lastStockLoadTime).toISOString()
    },
    customer: {
      items: customerCache.length,
      vectorSize: customerVectorStore.size(),
      lastLoaded: new Date(lastCustomerLoadTime).toISOString()
    },
    memory: process.memoryUsage()
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  loadStockCache,
  loadCustomerCache,
  getStockCache,
  getCustomerCache,
  getCacheStats,
  extractStockKeywords,    // ✅ Export for use in other modules
  extractCustomerKeywords  // ✅ Export for use in other modules
};