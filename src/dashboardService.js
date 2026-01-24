// src/dashboardService.js - FIXED: Proper date matching using standardized utils
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { 
  getThaiDateString, 
  extractGregorianDate, 
  formatDateForDisplay,
  isDateInRange,
  getDateRange 
} = require('./utils'); // ✅ Use standardized date functions
const { getSheetData, appendSheetData } = require('./googleServices');

/**
 * ✅ FIX #3: Generate daily summary with correct date filtering
 * @param {string} targetDate - Optional YYYY-MM-DD format
 */
async function generateDailySummary(targetDate = null) {
  try {
    // Use Gregorian format for comparison: "2026-01-24"
    const date = targetDate || getThaiDateString();
    Logger.info(`📊 Generating summary for ${date}...`);

    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    
    if (orderRows.length <= 1) {
      return `📊 สรุปยอดขาย ${formatDateForDisplay(date)}\n\n❌ ไม่มีออเดอร์`;
    }

    // ✅ FIX #3: Filter orders using standardized date comparison
    const todayOrders = orderRows.slice(1).filter(row => {
      const orderDateTime = row[1] || ''; // "24/01/2026 14:30:00" or "2026-01-24 14:30:00"
      const orderDate = extractGregorianDate(orderDateTime); // → "2026-01-24"
      return orderDate === date;
    });

    if (todayOrders.length === 0) {
      return `📊 สรุปยอดขาย ${formatDateForDisplay(date)}\n\n❌ ไม่มีออเดอร์วันนี้`;
    }

    let totalSales = 0;
    let totalCost = 0;
    const productCount = {};
    const customerOrders = {};

    for (const order of todayOrders) {
      const customer = order[2] || 'ไม่ระบุ';
      const product = order[3] || '';
      const quantity = parseInt(order[4] || 0);
      const amount = parseFloat(order[8] || 0);
      
      customerOrders[customer] = (customerOrders[customer] || 0) + 1;
      
      totalSales += amount;
      
      // Calculate cost (you might need to look this up from stock)
      // For now, estimate cost as 60% of sale price
      totalCost += (amount * 0.6);
      
      productCount[product] = (productCount[product] || 0) + quantity;
    }
    
    const totalProfit = totalSales - totalCost;
    const profitMargin = totalSales > 0 ? ((totalProfit / totalSales) * 100).toFixed(1) : 0;

    // Top products
    const topProducts = Object.entries(productCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, qty]) => `${name} (${qty})`);

    // Top customers
    const topCustomers = Object.entries(customerOrders)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => `${name} (${count} ออเดอร์)`);

    let msg = `📊 สรุปยอดขายประจำวัน\n${'='.repeat(40)}\n\n`;
    msg += `📅 วันที่: ${formatDateForDisplay(date)}\n\n`;
    msg += `📦 จำนวนออเดอร์: ${todayOrders.length} รายการ\n\n`;
    msg += `💰 การเงิน:\n`;
    msg += `   • ต้นทุน: ${totalCost.toLocaleString()}฿\n`;
    msg += `   • ยอดขาย: ${totalSales.toLocaleString()}฿\n`;
    msg += `   • กำไร: ${totalProfit.toLocaleString()}฿\n`;
    msg += `   • กำไรสุทธิ: ${profitMargin}%\n\n`;
    
    if (topProducts.length > 0) {
      msg += `🏆 สินค้าขายดี Top ${topProducts.length}:\n`;
      topProducts.forEach((p, i) => msg += `   ${i + 1}. ${p}\n`);
      msg += `\n`;
    }

    if (topCustomers.length > 0) {
      msg += `👑 ลูกค้าประจำ:\n`;
      topCustomers.forEach((c, i) => msg += `   ${i + 1}. ${c}\n`);
    }

    // Save to Dashboard
    try {
      const dashRows = await getSheetData(CONFIG.SHEET_ID, 'Dashboard!A:F');
      const exists = dashRows.slice(1).some(row => row[0] === date);
      
      if (!exists) {
        const row = [
          date,
          todayOrders.length,
          totalCost,
          totalSales,
          totalProfit,
          topProducts.join(', ')
        ];
        await appendSheetData(CONFIG.SHEET_ID, 'Dashboard!A:F', [row]);
        Logger.success(`✅ Saved to Dashboard: ${date}`);
      }
    } catch (dashError) {
      Logger.warn('Could not save to Dashboard', dashError);
    }

    return msg;

  } catch (error) {
    Logger.error('generateDailySummary failed', error);
    return `❌ ไม่สามารถสร้างรายงานได้: ${error.message}`;
  }
}

/**
 * ✅ FIX #3: Generate summary for date range
 */
async function generateRangeSummary(period = 'week') {
  try {
    const { startDate, endDate } = getDateRange(period);
    Logger.info(`📊 Generating ${period} summary: ${startDate} to ${endDate}`);

    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    
    if (orderRows.length <= 1) {
      return `📊 สรุปยอดขาย (${period})\n\n❌ ไม่มีออเดอร์`;
    }

    const periodOrders = orderRows.slice(1).filter(row => {
      const orderDateTime = row[1] || '';
      const orderDate = extractGregorianDate(orderDateTime);
      return isDateInRange(orderDate, startDate, endDate);
    });

    if (periodOrders.length === 0) {
      return `📊 สรุปยอดขาย (${period})\n\n❌ ไม่มีออเดอร์ในช่วงนี้`;
    }

    let totalSales = 0;
    const dailyOrders = {};

    for (const order of periodOrders) {
      const orderDate = extractGregorianDate(order[1]);
      const amount = parseFloat(order[8] || 0);
      
      totalSales += amount;
      
      if (!dailyOrders[orderDate]) {
        dailyOrders[orderDate] = { count: 0, sales: 0 };
      }
      
      dailyOrders[orderDate].count++;
      dailyOrders[orderDate].sales += amount;
    }

    const avgDailySales = totalSales / Object.keys(dailyOrders).length;

    let msg = `📊 สรุปยอดขาย (${period})\n${'='.repeat(40)}\n\n`;
    msg += `📅 ช่วงเวลา: ${formatDateForDisplay(startDate)} - ${formatDateForDisplay(endDate)}\n\n`;
    msg += `📦 จำนวนออเดอร์: ${periodOrders.length} รายการ\n`;
    msg += `💰 ยอดขายรวม: ${totalSales.toLocaleString()}฿\n`;
    msg += `📈 เฉลี่ยต่อวัน: ${Math.round(avgDailySales).toLocaleString()}฿\n\n`;
    
    msg += `📆 รายวัน:\n`;
    Object.entries(dailyOrders)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 7)
      .forEach(([date, data]) => {
        msg += `  ${formatDateForDisplay(date)}: ${data.count} ออเดอร์, ${data.sales.toLocaleString()}฿\n`;
      });

    return msg;

  } catch (error) {
    Logger.error('generateRangeSummary failed', error);
    return `❌ ไม่สามารถสร้างรายงานได้: ${error.message}`;
  }
}

async function generateInboxSummary(limit = 15) {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'Inbox!A:B');
    
    if (rows.length <= 1) {
      return '📝 Inbox ว่างเปล่า\n\nยังไม่มีข้อความในระบบ';
    }

    const messages = rows.slice(1).slice(-limit).reverse();

    let msg = `📝 Inbox (${messages.length} ข้อความล่าสุด)\n${'='.repeat(40)}\n\n`;
    
    messages.forEach((row, idx) => {
      const timestamp = row[0] || '';
      const text = row[1] || '';
      const time = timestamp.split(' ')[1] || timestamp;
      
      msg += `${idx + 1}. [${time}] ${text.substring(0, 60)}\n`;
      if (text.length > 60) msg += `   ...\n`;
      msg += `\n`;
    });

    return msg;

  } catch (error) {
    Logger.error('generateInboxSummary failed', error);
    return `❌ ไม่สามารถดู Inbox ได้: ${error.message}`;
  }
}

module.exports = {
  generateDailySummary,
  generateRangeSummary, // NEW
  generateInboxSummary
};