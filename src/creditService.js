// src/creditService.js - FIXED: Duplicate prevention + Enhanced features

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString, extractGregorianDate } = require('./utils');
const { getSheetData, appendSheetData, updateSheetData } = require('./googleServices');

// ============================================================================
// CREDIT ENTRY CACHE (Prevents duplicate checks)
// ============================================================================

class CreditCache {
  constructor() {
    this.cache = new Map(); // orderNo -> creditRowIndex
    this.lastRefresh = 0;
    this.REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
  }

  async refresh() {
    try {
      const rows = await getSheetData(CONFIG.SHEET_ID, 'เครดิต!A:G');
      this.cache.clear();
      
      for (let i = 1; i < rows.length; i++) {
        const orderNo = rows[i][2]; // Column C: รหัสคำสั่ง
        if (orderNo) {
          this.cache.set(String(orderNo), i + 1); // Store row index
        }
      }
      
      this.lastRefresh = Date.now();
      Logger.debug(`💳 Credit cache refreshed: ${this.cache.size} entries`);
      
    } catch (error) {
      Logger.error('Credit cache refresh failed', error);
    }
  }

  async ensureFresh() {
    if (Date.now() - this.lastRefresh > this.REFRESH_INTERVAL) {
      await this.refresh();
    }
  }

  has(orderNo) {
    return this.cache.has(String(orderNo));
  }

  get(orderNo) {
    return this.cache.get(String(orderNo));
  }

  set(orderNo, rowIndex) {
    this.cache.set(String(orderNo), rowIndex);
  }

  delete(orderNo) {
    this.cache.delete(String(orderNo));
  }
}

const creditCache = new CreditCache();

// ============================================================================
// AUTO-CREATE CREDIT ENTRY - FIXED: Duplicate Prevention
// ============================================================================

async function createCreditEntry(orderResult) {
  const { orderNo, customer, totalAmount } = orderResult;
  
  // Validate input
  if (!orderNo || !customer || !totalAmount) {
    Logger.warn('Invalid credit entry data - missing required fields');
    return { success: false, reason: 'invalid_data' };
  }

  try {
    Logger.info(`💳 Creating credit entry for order #${orderNo}...`);
    
    // ========================================================================
    // STEP 1: ENSURE CACHE IS FRESH
    // ========================================================================
    
    await creditCache.ensureFresh();
    
    // ========================================================================
    // STEP 2: CHECK CACHE FIRST (Fast path)
    // ========================================================================
    
    if (creditCache.has(orderNo)) {
      const existingRow = creditCache.get(orderNo);
      Logger.warn(`⚠️ Credit entry already exists for order #${orderNo} at row ${existingRow}`);
      return { 
        success: false, 
        reason: 'duplicate',
        existingRow: existingRow
      };
    }
    
    // ========================================================================
    // STEP 3: DOUBLE-CHECK IN SHEET (Prevent race conditions)
    // ========================================================================
    
    const rows = await getSheetData(CONFIG.SHEET_ID, 'เครดิต!A:G');
    
    for (let i = 1; i < rows.length; i++) {
      const creditOrderNo = rows[i][2]; // Column C: รหัสคำสั่ง
      
      if (String(creditOrderNo) === String(orderNo)) {
        Logger.warn(`⚠️ Credit entry found in sheet check for #${orderNo}`);
        
        // Update cache
        creditCache.set(orderNo, i + 1);
        
        return { 
          success: false, 
          reason: 'duplicate',
          existingRow: i + 1
        };
      }
    }
    
    // ========================================================================
    // STEP 4: CREATE NEW ENTRY (No duplicate found)
    // ========================================================================
    
    // Calculate due date (30 days from now)
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30);
    const dueDateStr = dueDate.toISOString().split('T')[0]; // YYYY-MM-DD
    
    const row = [
      getThaiDateTimeString(),           // A - วันที่
      customer,                          // B - ลูกค้า
      orderNo,                           // C - รหัสคำสั่ง
      totalAmount,                       // D - ยอดเงิน
      'ค้างชำระ',                        // E - สถานะ
      dueDateStr,                        // F - วันครบกำหนด (YYYY-MM-DD)
      'Auto-created from unpaid order'   // G - หมายเหตุ
    ];
    
    await appendSheetData(CONFIG.SHEET_ID, 'เครดิต!A:G', [row]);
    
    // Update cache
    const newRowIndex = rows.length + 1;
    creditCache.set(orderNo, newRowIndex);
    
    Logger.success(`✅ Credit entry created: #${orderNo} → ${totalAmount}฿ (due: ${dueDateStr})`);
    
    return { 
      success: true,
      orderNo: orderNo,
      amount: totalAmount,
      dueDate: dueDateStr,
      rowIndex: newRowIndex
    };
    
  } catch (error) {
    Logger.error('createCreditEntry failed', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
}

// ============================================================================
// AUTO-UPDATE CREDIT - Mark as Paid
// ============================================================================

async function markCreditAsPaid(orderNo) {
  try {
    Logger.info(`💰 Marking credit as paid for order #${orderNo}...`);
    
    // Check cache first
    await creditCache.ensureFresh();
    
    let rowIndex = creditCache.get(orderNo);
    
    // If not in cache, search sheet
    if (!rowIndex) {
      const rows = await getSheetData(CONFIG.SHEET_ID, 'เครดิต!A:G');
      
      for (let i = 1; i < rows.length; i++) {
        const creditOrderNo = rows[i][2]; // Column C: รหัสคำสั่ง
        const status = rows[i][4];        // Column E: สถานะ
        
        if (String(creditOrderNo) === String(orderNo)) {
          rowIndex = i + 1;
          creditCache.set(orderNo, rowIndex);
          
          // Check if already paid
          if (status === 'ชำระแล้ว') {
            Logger.info(`✓ Credit already marked as paid: #${orderNo}`);
            return { success: true, reason: 'already_paid' };
          }
          
          break;
        }
      }
    }
    
    if (!rowIndex) {
      Logger.warn(`⚠️ No credit entry found for order #${orderNo}`);
      return { 
        success: false, 
        reason: 'not_found' 
      };
    }
    
    // Update status to paid
    await updateSheetData(
      CONFIG.SHEET_ID,
      `เครดิต!E${rowIndex}`,
      [['ชำระแล้ว']]
    );
    
    // Add payment timestamp to notes
    const paidNote = `ชำระเมื่อ ${getThaiDateTimeString()}`;
    await updateSheetData(
      CONFIG.SHEET_ID,
      `เครดิต!G${rowIndex}`,
      [[paidNote]]
    );
    
    Logger.success(`✅ Credit marked as paid: #${orderNo} at row ${rowIndex}`);
    
    return { 
      success: true,
      orderNo: orderNo,
      rowIndex: rowIndex
    };
    
  } catch (error) {
    Logger.error('markCreditAsPaid failed', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
}

// ============================================================================
// GET CREDIT SUMMARY WITH ALERTS
// ============================================================================

async function getCreditSummaryWithAlerts() {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'เครดิต!A:G');
    
    if (rows.length <= 1) {
      return {
        totalUnpaid: 0,
        overdueCount: 0,
        dueSoonCount: 0,
        customers: []
      };
    }
    
    let totalUnpaid = 0;
    let overdueCount = 0;
    let dueSoonCount = 0;
    const now = new Date();
    const customerMap = new Map();
    
    for (let i = 1; i < rows.length; i++) {
      const status = (rows[i][4] || '').trim();
      
      // Skip paid entries
      if (status === 'ชำระแล้ว') continue;
      
      const customer = rows[i][1];
      const orderNo = rows[i][2];
      const amount = parseFloat(rows[i][3] || 0);
      const dueDateStr = rows[i][5];
      
      let dueDate = null;
      if (dueDateStr) {
        try {
          dueDate = new Date(dueDateStr);
        } catch (e) {
          Logger.warn(`Invalid due date for order #${orderNo}: ${dueDateStr}`);
        }
      }
      
      totalUnpaid += amount;
      
      // Check if overdue
      if (dueDate && dueDate < now) {
        overdueCount++;
      }
      
      // Check if due soon (within 7 days)
      const daysUntilDue = dueDate 
        ? Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24)) 
        : 999;
      
      if (daysUntilDue > 0 && daysUntilDue <= 7) {
        dueSoonCount++;
      }
      
      // Group by customer
      if (!customerMap.has(customer)) {
        customerMap.set(customer, {
          name: customer,
          totalAmount: 0,
          orders: []
        });
      }
      
      const customerData = customerMap.get(customer);
      customerData.totalAmount += amount;
      customerData.orders.push({
        orderNo,
        amount,
        dueDate,
        daysUntilDue,
        isOverdue: dueDate && dueDate < now
      });
    }
    
    return {
      totalUnpaid,
      overdueCount,
      dueSoonCount,
      customers: Array.from(customerMap.values())
    };
    
  } catch (error) {
    Logger.error('getCreditSummaryWithAlerts failed', error);
    return {
      totalUnpaid: 0,
      overdueCount: 0,
      dueSoonCount: 0,
      customers: [],
      error: error.message
    };
  }
}

// ============================================================================
// GENERATE ENHANCED CREDIT REPORT
// ============================================================================

async function generateEnhancedCreditReport() {
  try {
    const summary = await getCreditSummaryWithAlerts();
    
    if (summary.customers.length === 0) {
      return '✅ ไม่มีเครดิตค้างชำระ\n\nยอดเยี่ยม! ทุกคนจ่ายเงินหมดแล้ว 🎉';
    }
    
    let report = `💳 รายงานเครดิต\n${'='.repeat(40)}\n\n`;
    
    // Overall summary
    report += `📊 สรุปภาพรวม:\n`;
    report += `• ยอดรวมค้างชำระ: ${summary.totalUnpaid.toLocaleString()}฿\n`;
    
    if (summary.overdueCount > 0) {
      report += `• 🔴 เกินกำหนด: ${summary.overdueCount} รายการ\n`;
    }
    
    if (summary.dueSoonCount > 0) {
      report += `• 🟡 ครบกำหนดเร็วๆ นี้: ${summary.dueSoonCount} รายการ\n`;
    }
    
    report += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    // Sort customers by total amount (highest first)
    const sortedCustomers = summary.customers.sort((a, b) => b.totalAmount - a.totalAmount);
    
    sortedCustomers.forEach((customer, idx) => {
      const hasOverdue = customer.orders.some(o => o.isOverdue);
      const icon = hasOverdue ? '🔴' : '💳';
      
      report += `${icon} ${idx + 1}. ${customer.name}\n`;
      report += `   ยอดรวม: ${customer.totalAmount.toLocaleString()}฿\n`;
      report += `   จำนวนออเดอร์: ${customer.orders.length} รายการ\n\n`;
      
      // Show orders (max 5)
      customer.orders.slice(0, 5).forEach(order => {
        let status = '';
        
        if (order.isOverdue) {
          const daysOverdue = Math.abs(order.daysUntilDue);
          status = `⚠️ เกิน ${daysOverdue} วัน`;
        } else if (order.daysUntilDue <= 7 && order.daysUntilDue > 0) {
          status = `⏰ เหลือ ${order.daysUntilDue} วัน`;
        }
        
        report += `   • #${order.orderNo}: ${order.amount.toLocaleString()}฿`;
        if (status) report += ` ${status}`;
        report += '\n';
      });
      
      if (customer.orders.length > 5) {
        report += `   ... และอีก ${customer.orders.length - 5} รายการ\n`;
      }
      
      report += `\n`;
    });
    
    return report;
    
  } catch (error) {
    Logger.error('generateEnhancedCreditReport failed', error);
    return `❌ ไม่สามารถสร้างรายงานได้: ${error.message}`;
  }
}

// ============================================================================
// DAILY CREDIT ALERTS (For scheduler)
// ============================================================================

async function generateCreditAlerts() {
  try {
    const summary = await getCreditSummaryWithAlerts();
    
    if (summary.overdueCount === 0 && summary.dueSoonCount === 0) {
      return null; // No alerts needed
    }
    
    let alert = `🔔 แจ้งเตือนเครดิต\n${'='.repeat(40)}\n\n`;
    
    if (summary.overdueCount > 0) {
      alert += `🔴 เกินกำหนด: ${summary.overdueCount} รายการ\n\n`;
      
      const overdueCustomers = summary.customers.filter(c => 
        c.orders.some(o => o.isOverdue)
      );
      
      overdueCustomers.slice(0, 5).forEach(c => {
        const overdueOrders = c.orders.filter(o => o.isOverdue);
        const totalOverdue = overdueOrders.reduce((sum, o) => sum + o.amount, 0);
        
        alert += `  • ${c.name}: ${totalOverdue.toLocaleString()}฿\n`;
      });
      
      if (overdueCustomers.length > 5) {
        alert += `  ... และอีก ${overdueCustomers.length - 5} ราย\n`;
      }
      
      alert += `\n`;
    }
    
    if (summary.dueSoonCount > 0) {
      alert += `🟡 ครบกำหนดใน 7 วัน: ${summary.dueSoonCount} รายการ\n`;
    }
    
    return alert;
    
  } catch (error) {
    Logger.error('generateCreditAlerts failed', error);
    return null;
  }
}

// ============================================================================
// REFRESH CACHE (Manual trigger)
// ============================================================================

async function refreshCreditCache() {
  await creditCache.refresh();
  return { 
    success: true, 
    entries: creditCache.cache.size 
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  createCreditEntry,
  markCreditAsPaid,
  getCreditSummaryWithAlerts,
  generateEnhancedCreditReport,
  generateCreditAlerts,
  refreshCreditCache,
  creditCache // Export for monitoring
};