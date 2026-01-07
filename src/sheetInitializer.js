// sheetInitializer.js - FIXED: Correct column order
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getSheetsList, createSheet, appendSheetData } = require('./googleServices');

// ============================================================================
// REQUIRED SHEETS - CORRECT STRUCTURE
// ============================================================================

const REQUIRED_SHEETS = [
  // 1. คำสั่งซื้อ (Orders) - FIXED COLUMN ORDER
  { 
    name: 'คำสั่งซื้อ', 
    headers: [
      'รหัสคำสั่ง',      // A - Order ID
      'วันที่',          // B - Timestamp
      'ลูกค้า',         // C - Customer name
      'ผู้ส่ง',         // D - Delivery person ✅ FIXED
      'สถานะการจัดส่ง',  // E - Delivery status
      'สถานะการชำระ',    // F - Payment status
      'ยอดรวม',         // G - Total amount
      'รายการสินค้า',    // H - Line items JSON ✅ FIXED
      'หมายเหตุ'        // I - Notes
    ],
    purpose: 'ONE TRUTH for order management - matches orderService.js output'
  },
  
  // 2. สต็อก (Stock)
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
    purpose: 'ONE TRUTH for inventory'
  },
  
  // 3. ลูกค้า (Customers)
  {
    name: 'ลูกค้า',
    headers: ['ชื่อลูกค้า', 'เบอร์โทร', 'ที่อยู่', 'หมายเหตุ'],
    purpose: 'Customer database'
  },
  
  // 4. Dashboard
  { 
    name: 'Dashboard', 
    headers: ['วันที่', 'จำนวนออเดอร์', 'ต้นทุน', 'ยอดขาย', 'กำไร', 'Top5'],
    purpose: 'Daily aggregated metrics'
  },
  
  // 5. เครดิต (Credit)
  {
    name: 'เครดิต',
    headers: ['วันที่', 'ลูกค้า', 'รหัสคำสั่ง', 'ยอดเงิน', 'สถานะ', 'วันครบกำหนด', 'หมายเหตุ'],
    purpose: 'Credit/debt tracking'
  },
  
  // 6. Inbox
  {
    name: 'Inbox',
    headers: ['วันที่/เวลา', 'ข้อความ'],
    purpose: 'Simple notebook'
  },
  
  // 7. VarianceLog
  {
    name: 'VarianceLog',
    headers: ['วันที่', 'สินค้า', 'สต็อกเก่า', 'สต็อกใหม่', 'ส่วนต่าง', 'เหตุผล'],
    purpose: 'Stock adjustment history'
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

    for (const required of REQUIRED_SHEETS) {
      if (!existingSheets.includes(required.name)) {
        issues.push(`Missing sheet: ${required.name}`);
      }
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
  Logger.info('\n📊 Sheet Structure:');
  Logger.info('━'.repeat(60));
  
  REQUIRED_SHEETS.forEach(sheet => {
    const exists = existingSheets.includes(sheet.name);
    const icon = exists ? '✅' : '❌';
    Logger.info(`${icon} ${sheet.name} (${sheet.headers.length} columns)`);
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
  getRequiredSheets,
  getSheetPurpose,
  REQUIRED_SHEETS
};
