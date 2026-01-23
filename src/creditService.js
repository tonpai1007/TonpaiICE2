// src/creditService.js - NEW FILE: Automatic Credit Management

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString, extractGregorianDate } = require('./utils');
const { getSheetData, appendSheetData, updateSheetData } = require('./googleServices');

// ============================================================================
// AUTO-CREATE CREDIT ENTRY (When order is unpaid)
// ============================================================================

async function createCreditEntry(orderResult) {
  try {
    const { orderNo, customer, totalAmount } = orderResult;
    
    // Calculate due date (30 days from now)
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30);
    const dueDateStr = dueDate.toISOString().split('T')[0];
    
    const row = [
      getThaiDateTimeString(),           // วันที่
      customer,                          // ลูกค้า
      orderNo,                           // รหัสคำสั่ง
      totalAmount,                       // ยอดเงิน
      'ค้างชำระ',                        // สถานะ
      dueDateStr,                        // วันครบกำหนด
      'Auto-created from unpaid order'   // หมายเหตุ
    ];
    
    await appendSheetData(CONFIG.SHEET_ID, 'เครดิต!A:G', [row]);
    Logger.success(`💳 Credit entry created for order #${orderNo}: ${totalAmount}฿`);
    
    return { success: true };
  } catch (error) {
    Logger.error('createCreditEntry failed', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// AUTO-UPDATE CREDIT (When payment is made)
// ============================================================================

async function markCreditAsPaid(orderNo) {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'เครดิต!A:G');
    
    for (let i = 1; i < rows.length; i++) {
      const creditOrderNo = rows[i][2]; // Column C: รหัสคำสั่ง
      const status = rows[i][4];        // Column E: สถานะ
      
      if (creditOrderNo == orderNo && status !== 'ชำระแล้ว') {
        // Update status to paid
        await updateSheetData(
          CONFIG.SHEET_ID,
          `เครดิต!E${i + 1}`,
          [['ชำระแล้ว']]
        );
        
        // Add payment timestamp to notes
        const paidNote = `ชำระเมื่อ ${getThaiDateTimeString()}`;
        await updateSheetData(
          CONFIG.SHEET_ID,
          `เครดิต!G${i + 1}`,
          [[paidNote]]
        );
        
        Logger.success(`✅ Credit marked as paid: #${orderNo}`);
        return { success: true };
      }
    }
    
    Logger.info(`No credit entry found for order #${orderNo}`);
    return { success: false, reason: 'not_found' };
  } catch (error) {
    Logger.error('markCreditAsPaid failed', error);
    return { success: false, error: error.message };
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
      if (status === 'ชำระแล้ว') continue;
      
      const customer = rows[i][1];
      const orderNo = rows[i][2];
      const amount = parseFloat(rows[i][3] || 0);
      const dueDate = rows[i][5] ? new Date(rows[i][5]) : null;
      
      totalUnpaid += amount;
      
      // Check if overdue
      if (dueDate && dueDate < now) {
        overdueCount++;
      }
      
      // Check if due soon (within 7 days)
      const daysUntilDue = dueDate ? Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24)) : 999;
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
      
      // Show orders
      customer.orders.forEach(order => {
        let status = '';
        
        if (order.isOverdue) {
          status = `⚠️ เกิน ${Math.abs(order.daysUntilDue)} วัน`;
        } else if (order.daysUntilDue <= 7) {
          status = `⏰ เหลือ ${order.daysUntilDue} วัน`;
        }
        
        report += `   • #${order.orderNo}: ${order.amount.toLocaleString()}฿ ${status}\n`;
      });
      
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
      alert += `🔴 เกินกำหนด: ${summary.overdueCount} รายการ\n`;
      
      const overdueCustomers = summary.customers.filter(c => 
        c.orders.some(o => o.isOverdue)
      );
      
      overdueCustomers.slice(0, 5).forEach(c => {
        const overdueOrders = c.orders.filter(o => o.isOverdue);
        const totalOverdue = overdueOrders.reduce((sum, o) => sum + o.amount, 0);
        
        alert += `  • ${c.name}: ${totalOverdue.toLocaleString()}฿\n`;
      });
      
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
// EXPORTS
// ============================================================================

module.exports = {
  createCreditEntry,
  markCreditAsPaid,
  getCreditSummaryWithAlerts,
  generateEnhancedCreditReport,
  generateCreditAlerts
};