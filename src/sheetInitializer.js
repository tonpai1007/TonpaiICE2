// sheetInitializer.js - FIXED: Single Source of Truth Architecture
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getSheetsList, createSheet, appendSheetData } = require('./googleServices');

// ============================================================================
// ✅ CLEANED ARCHITECTURE - Two Sources of Truth
// ============================================================================

const REQUIRED_SHEETS = [
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 📦 SOURCE OF TRUTH #1: ORDER MANAGEMENT
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  { 
    name: 'คำสั่งซื้อ', 
    headers: [
      'รหัสคำสั่ง',        // Order ID (PK)
      'วันที่',            // Timestamp
      'ลูกค้า',            // Customer name
      'ผู้ส่ง',            // Delivery person
      'สถานะการจัดส่ง',    // Delivery status
      'สถานะการชำระ',      // Payment status
      'ยอดรวม',            // Total amount
      'รายการสินค้า',      // JSON: [{item, qty, unit, price, cost, subtotal}]
      'หมายเหตุ'           // Notes
    ],
    purpose: 'Single source of truth for all orders - denormalized for performance',
    indexes: ['รหัสคำสั่ง', 'วันที่', 'ลูกค้า']
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 📊 SOURCE OF TRUTH #2: INVENTORY MANAGEMENT
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  { 
    name: 'สต็อก', 
    headers: [
      'สินค้า',            // Product name (PK)
      'ต้นทุน',            // Cost price
      'ราคาขาย',           // Selling price
      'หน่วย',             // Unit
      'จำนวนคงเหลือ',      // Current stock
      'หมวดหมู่',          // Category
      'SKU'                // Stock keeping unit
    ],
    purpose: 'Single source of truth for inventory - updated by orders & adjustments',
    indexes: ['สินค้า', 'SKU']
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🗂️ SUPPORTING DATA (NOT SOURCES OF TRUTH)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  
  // Customer master data
  {
    name: 'ลูกค้า',
    headers: ['ชื่อลูกค้า', 'เบอร์โทร', 'ที่อยู่', 'หมายเหตุ'],
    purpose: 'Customer master data for RAG matching'
  },
  
  // Daily aggregated metrics (derived from orders)
  { 
    name: 'Dashboard', 
    headers: ['วันที่', 'จำนวนออเดอร์', 'ต้นทุน', 'ยอดขาย', 'กำไร', 'Top5'],
    purpose: 'Materialized view - aggregated daily metrics'
  },
  
  // Credit tracking (derived from orders)
  {
    name: 'เครดิต',
    headers: ['วันที่', 'ลูกค้า', 'รหัสคำสั่ง', 'ยอดเงิน', 'สถานะ', 'วันครบกำหนด', 'หมายเหตุ'],
    purpose: 'Credit ledger - filtered view of unpaid orders'
  },
  
  // Raw input log (audit trail)
  {
    name: 'Inbox',
    headers: ['วันที่', 'UserID', 'ประเภท', 'ข้อความ', 'Metadata', 'สถานะ', 'หมายเหตุ'],
    purpose: 'Audit trail - all voice/text inputs'
  },
  
  // Stock adjustment log (audit trail)
  {
    name: 'VarianceLog',
    headers: ['วันที่', 'สินค้า', 'สต็อกเก่า', 'สต็อกใหม่', 'ส่วนต่าง', 'เหตุผล'],
    purpose: 'Audit trail - all stock adjustments'
  }
];

// ============================================================================
// MIGRATION STRATEGY
// ============================================================================

async function migrateOldStructure() {
  try {
    Logger.info('🔄 Starting migration: Old → New architecture...');
    
    const existingSheets = await getSheetsList(CONFIG.SHEET_ID);
    
    // Check if old sheets exist
    const hasOldStructure = 
      existingSheets.includes('รายการสินค้า') || 
      existingSheets.includes('รายละเอียดคำสั่งซื้อ');
    
    if (!hasOldStructure) {
      Logger.info('✅ No old structure detected - clean installation');
      return { migrated: false, reason: 'Clean installation' };
    }

    Logger.warn('⚠️ Old structure detected - migration required');
    Logger.info('📋 Migration plan:');
    Logger.info('  1. Backup old data');
    Logger.info('  2. Merge รายละเอียดคำสั่งซื้อ → คำสั่งซื้อ (JSON column)');
    Logger.info('  3. Delete redundant sheets');
    Logger.info('  4. Validate data integrity');

    // TODO: Implement actual migration logic if needed
    Logger.warn('⚠️ Manual migration required - see migration guide');
    
    return {
      migrated: false,
      reason: 'Manual intervention required',
      oldSheets: ['รายการสินค้า', 'รายละเอียดคำสั่งซื้อ'],
      action: 'Review and approve migration'
    };

  } catch (error) {
    Logger.error('❌ Migration analysis failed', error);
    throw error;
  }
}

// ============================================================================
// INITIALIZE CLEANED STRUCTURE
// ============================================================================

async function initializeSheets() {
  try {
    Logger.info('🔍 Initializing CLEANED architecture...');
    
    // Run migration check
    const migrationStatus = await migrateOldStructure();
    if (migrationStatus.action === 'Review and approve migration') {
      Logger.warn('⚠️ Migration pending - system will use new structure for new data');
    }

    const existingSheets = await getSheetsList(CONFIG.SHEET_ID);
    const missingSheets = REQUIRED_SHEETS.filter(
      required => !existingSheets.includes(required.name)
    );

    if (missingSheets.length === 0) {
      Logger.success('✅ All required sheets exist');
      logSheetStructure(existingSheets);
      return { success: true, created: [] };
    }

    Logger.warn(`⚠️ Missing ${missingSheets.length} sheets. Creating...`);
    const created = [];

    for (const sheet of missingSheets) {
      try {
        Logger.info(`📄 Creating: ${sheet.name}...`);
        await createSheet(CONFIG.SHEET_ID, sheet.name);
        await appendSheetData(CONFIG.SHEET_ID, `${sheet.name}!A1`, [sheet.headers]);
        created.push(sheet.name);
        Logger.success(`✅ Created: ${sheet.name}`);
      } catch (error) {
        if (error.message.includes('already exists')) {
          Logger.warn(`⚠️ Sheet already exists: ${sheet.name}`);
        } else {
          Logger.error(`❌ Failed to create: ${sheet.name}`, error);
        }
      }
    }

    if (created.length > 0) {
      Logger.success(`✅ Initialized ${created.length} new sheets`);
      logSheetStructure(existingSheets.concat(created));
    }

    return { success: true, created };

  } catch (error) {
    Logger.error('❌ Sheet initialization failed', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// VALIDATION
// ============================================================================

async function validateSheetsStructure() {
  try {
    Logger.info('🔍 Validating architecture integrity...');
    
    const existingSheets = await getSheetsList(CONFIG.SHEET_ID);
    const issues = [];

    // Check required sheets
    for (const required of REQUIRED_SHEETS) {
      if (!existingSheets.includes(required.name)) {
        issues.push(`❌ Missing critical sheet: ${required.name}`);
      }
    }

    // Check for deprecated sheets
    const deprecatedSheets = [
      'รายการสินค้า',
      'รายละเอียดคำสั่งซื้อ'
    ];

    deprecatedSheets.forEach(deprecated => {
      if (existingSheets.includes(deprecated)) {
        issues.push(`⚠️ Deprecated sheet detected: ${deprecated} (should be removed)`);
      }
    });

    if (issues.length > 0) {
      Logger.warn(`⚠️ Found ${issues.length} architecture issues:`);
      issues.forEach(issue => Logger.warn(`  ${issue}`));
      return { valid: false, issues };
    }

    Logger.success('✅ Architecture is clean and valid');
    return { valid: true, issues: [] };

  } catch (error) {
    Logger.error('❌ Validation failed', error);
    return { valid: false, issues: [error.message] };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function logSheetStructure(existingSheets) {
  Logger.info('\n📊 CLEANED ARCHITECTURE STRUCTURE:');
  Logger.info('━'.repeat(60));
  
  Logger.info('\n🎯 SOURCES OF TRUTH:');
  REQUIRED_SHEETS.slice(0, 2).forEach(sheet => {
    const exists = existingSheets.includes(sheet.name);
    const icon = exists ? '✅' : '❌';
    Logger.info(`${icon} ${sheet.name}`);
    Logger.info(`   └─ ${sheet.purpose}`);
  });

  Logger.info('\n📋 SUPPORTING DATA:');
  REQUIRED_SHEETS.slice(2).forEach(sheet => {
    const exists = existingSheets.includes(sheet.name);
    const icon = exists ? '✅' : '❌';
    Logger.info(`${icon} ${sheet.name}`);
    Logger.info(`   └─ ${sheet.purpose}`);
  });
  
  Logger.info('━'.repeat(60));
}

function getRequiredSheets() {
  return REQUIRED_SHEETS;
}

function getSheetPurpose(sheetName) {
  const sheet = REQUIRED_SHEETS.find(s => s.name === sheetName);
  return sheet ? sheet.purpose : 'Unknown sheet';
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  initializeSheets,
  validateSheetsStructure,
  migrateOldStructure,
  getRequiredSheets,
  getSheetPurpose,
  REQUIRED_SHEETS
};