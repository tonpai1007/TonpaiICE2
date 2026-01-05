// customerService.js - Auto-add new customers
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { appendSheetData, getSheetData } = require('./googleServices');
const { loadCustomerCache } = require('./cacheManager');

// ============================================================================
// AUTO-ADD NEW CUSTOMER
// ============================================================================

async function autoAddCustomer(customerName) {
  try {
    // Skip if no name
    if (!customerName || customerName === 'ไม่ระบุ') {
      return { success: false, reason: 'no_name' };
    }

    // Check if already exists
    const rows = await getSheetData(CONFIG.SHEET_ID, 'ลูกค้า!A:D');
    const exists = rows.slice(1).some(row => 
      (row[0] || '').trim().toLowerCase() === customerName.toLowerCase()
    );

    if (exists) {
      Logger.info(`👤 Customer already exists: ${customerName}`);
      return { success: false, reason: 'already_exists' };
    }

    // Add new customer
    const row = [
      customerName,
      '',  // Phone (empty)
      '',  // Address (empty)
      '[Auto-added from order]'  // Notes
    ];

    await appendSheetData(CONFIG.SHEET_ID, 'ลูกค้า!A:D', [row]);
    Logger.success(`✅ Auto-added new customer: ${customerName}`);

    // Reload cache
    await loadCustomerCache(true);

    return { success: true, customer: customerName };

  } catch (error) {
    Logger.error('autoAddCustomer failed', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  autoAddCustomer
};