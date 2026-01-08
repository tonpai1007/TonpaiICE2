// sheetInitializer.js - Simple Structure (10 columns)
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getSheetsList, createSheet, appendSheetData } = require('./googleServices');

// ============================================================================
// REQUIRED SHEETS - SIMPLE STRUCTURE
// ============================================================================

const REQUIRED_SHEETS = [
  { 
    name: 'คำสั่งซื้อ', 
    headers: [
      'รหัส',              // A
      'วันที่',            // B
      'ลูกค้า',           // C
      'สินค้า',           // D
      'จำนวน',            // E
      'หมายเหตุ',         // F
      'ผู้ส่ง',           // G
      'สถานะ',            // H
      'จ่ายแล้วหรือยัง',   // I
      'ยอดเงิน'           // J
    ],
    purpose: 'Simple order tracking - one row per item'
  },
  
  { 
    name: 'สต็อก', 
    headers: [
      'สินค้า',
      'ต้นทุน',
      'ราคาขาย',
      'หน่วย',
      'จำนวนคงเหลือ',
      'หมวดหมู่',
      'SKU'
    ],
    purpose: 'Inventory management'
  },
  
  {
    name: 'ลูกค้า',
    headers: ['ชื่อลูกค้า', 'เบอร์โทร', 'ที่อยู่', 'หมายเหตุ'],
    purpose: 'Customer database'
  },
  
  { 
    name: 'Dashboard', 
    headers: ['วันที่', 'จำนวนออเดอร์', 'ต้นทุน', 'ยอดขาย', 'กำไร', 'Top5'],
    purpose: 'Daily metrics'
  },
  
  {
    name: 'เครดิต',
    headers: ['วันที่', 'ลูกค้า', 'รหัสคำสั่ง', 'ยอดเงิน', 'สถานะ', 'วันครบกำหนด', 'หมายเหตุ'],
    purpose: 'Credit tracking'
  },
  
  {
    name: 'Inbox',
    headers: ['วันที่/เวลา', 'ข้อความ'],
    purpose: 'Message log'
  },
  
  {
    name: 'VarianceLog',
    headers: ['วันที่', 'สินค้า', 'สต็อกเก่า', 'สต็อกใหม่', 'ส่วนต่าง', 'เหตุผล'],
    purpose: 'Stock adjustments'
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
