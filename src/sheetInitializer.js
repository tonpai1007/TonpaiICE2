// sheetInitializer.js - Single Source of Truth Architecture
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getSheetsList, createSheet, appendSheetData } = require('./googleServices');

// ============================================================================
// REQUIRED SHEETS - SINGLE SOURCE OF TRUTH
// ============================================================================

const REQUIRED_SHEETS = [
  // 1. คำสั่งซื้อ (Orders) - ONE TRUTH for all orders
  // Contains: Order header + line items in single row (comma-separated)
  { 
    name: 'คำสั่งซื้อ', 
    headers: [
      'รหัสคำสั่ง',      // Order ID
      'วันที่',          // Timestamp
      'ลูกค้า',         // Customer name
      'รายการสินค้า',    // Items (format: "สินค้า1 x จำนวน, สินค้า2 x จำนวน")
      'ผู้ส่ง',         // Delivery person
      'สถานะการจัดส่ง',  // Delivery status
      'สถานะการชำระ',    // Payment status
      'ยอดรวม',         // Total amount
      'หมายเหตุ'        // Notes
    ],
    purpose: 'ONE TRUTH for order management - all order data in single sheet'
  },
  
  // 2. สต็อก (Stock) - ONE TRUTH for inventory
  { 
    name: 'สต็อก', 
    headers: [
      'สินค้า',         // Product name
      'ต้นทุน',         // Cost
      'ราคาขาย',        // Selling price
      'หน่วย',          // Unit
      'จำนวนคงเหลือ',    // Stock quantity
      'หมวดหมู่',       // Category
      'SKU'            // SKU code
    ],
    purpose: 'ONE TRUTH for inventory - RAG uses this for product matching'
  },
  
  // 3. ลูกค้า (Customers) - Customer database
  {
    name: 'ลูกค้า',
    headers: ['ชื่อลูกค้า', 'เบอร์โทร', 'ที่อยู่', 'หมายเหตุ'],
    purpose: 'Customer database - RAG uses this for customer matching'
  },
  
  // 4. Dashboard - Daily metrics (derived from คำสั่งซื้อ)
  { 
    name: 'Dashboard', 
    headers: ['วันที่', 'จำนวนออเดอร์', 'ต้นทุน', 'ยอดขาย', 'กำไร', 'Top5'],
    purpose: 'Daily aggregated metrics - calculated from orders'
  },
  
  // 5. เครดิต (Credit) - Credit tracking (links to คำสั่งซื้อ)
  {
    name: 'เครดิต',
    headers: ['วันที่', 'ลูกค้า', 'รหัสคำสั่ง', 'ยอดเงิน', 'สถานะ', 'วันครบกำหนด', 'หมายเหตุ'],
    purpose: 'Credit/debt tracking - references orders by ID'
  },
  
  // 6. Inbox - Simple notebook (วันที่/เวลา + ข้อความ)
  {
    name: 'Inbox',
    headers: ['วันที่/เวลา', 'ข้อความ'],
    purpose: 'Simple notebook - easy to read transcription log'
  },
  
  // 7. VarianceLog - Stock adjustments (tracks changes to สต็อก)
  {
    name: 'VarianceLog',
    headers: ['วันที่', 'สินค้า', 'สต็อกเก่า', 'สต็อกใหม่', 'ส่วนต่าง', 'เหตุผล'],
    purpose: 'Stock adjustment history - audit trail for inventory changes'
  }
];

// ============================================================================
// INITIALIZE SHEETS
// ============================================================================

async function initializeSheets() {
  try {
    Logger.info('🔍 Checking Google Sheets structure...');
    
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
        Logger.success(`✅ Created: ${sheet.name} (${sheet.headers.length} columns)`);
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
// VALIDATE SHEETS STRUCTURE
// ============================================================================

async function validateSheetsStructure() {
  try {
    Logger.info('🔍 Validating sheets structure...');
    
    const existingSheets = await getSheetsList(CONFIG.SHEET_ID);
    const issues = [];

    // Check required sheets exist
    for (const required of REQUIRED_SHEETS) {
      if (!existingSheets.includes(required.name)) {
        issues.push(`Missing sheet: ${required.name}`);
      }
    }

    // Check for deprecated sheets
    const deprecatedSheets = ['รายการสินค้า', 'รายละเอียดคำสั่งซื้อ'];
    const foundDeprecated = existingSheets.filter(s => deprecatedSheets.includes(s));
    
    if (foundDeprecated.length > 0) {
      Logger.warn(`⚠️ Found deprecated sheets: ${foundDeprecated.join(', ')}`);
      Logger.warn(`💡 These can be safely deleted - data is now in คำสั่งซื้อ and สต็อก`);
    }

    if (issues.length > 0) {
      Logger.warn(`⚠️ Found ${issues.length} issues:`);
      issues.forEach(issue => Logger.warn(`  - ${issue}`));
      return { valid: false, issues };
    }

    Logger.success('✅ All sheets are valid');
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
  Logger.info('\n📊 Sheet Structure (Single Source of Truth):');
  Logger.info('━'.repeat(60));
  
  REQUIRED_SHEETS.forEach(sheet => {
    const exists = existingSheets.includes(sheet.name);
    const icon = exists ? '✅' : '❌';
    Logger.info(`${icon} ${sheet.name} (${sheet.headers.length} columns)`);
    Logger.info(`   └─ ${sheet.purpose}`);
  });
  
  Logger.info('━'.repeat(60));
  Logger.info('\n🎯 Architecture:');
  Logger.info('  • คำสั่งซื้อ = ONE TRUTH for orders');
  Logger.info('  • สต็อก = ONE TRUTH for inventory');
  Logger.info('  • Other sheets reference these two sources\n');
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
  getRequiredSheets,
  getSheetPurpose,
  REQUIRED_SHEETS
};