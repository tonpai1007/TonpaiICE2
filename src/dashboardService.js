// dashboardService.js - FIXED: Simplified and working
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateString } = require('./utils');
const { getSheetData, appendSheetData } = require('./googleServices');

async function generateDailySummary(targetDate = null) {
  try {
    const date = targetDate || getThaiDateString();
    Logger.info(`📊 Generating summary for ${date}...`);

    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    
    if (orderRows.length <= 1) {
      return `📊 สรุปยอดขาย ${date}\n\n❌ ไม่มีออเดอร์`;
    }

    const todayOrders = orderRows.slice(1).filter(row => {
      const orderDate = (row[1] || '').split(' ')[0];
      return orderDate === date;
    });

    if (todayOrders.length === 0) {
      return `📊 สรุปยอดขาย ${date}\n\n❌ ไม่มีออเดอร์วันนี้`;
    }

    let totalSales = 0;
    let totalCost = 0;
    const productCount = {};

    for (const order of todayOrders) {
      const lineItemsJson = order[7] || '[]';
      
      try {
        const lineItems = JSON.parse(lineItemsJson);
        
        lineItems.forEach(line => {
          const quantity = parseInt(line.quantity || 0);
          const price = parseFloat(line.price || 0);
          const cost = parseFloat(line.cost || 0);
          
          totalSales += (quantity * price);
          totalCost += (quantity * cost);
          
          const productName = line.item;
          productCount[productName] = (productCount[productName] || 0) + quantity;
        });
        
      } catch (parseError) {
        Logger.error(`Failed to parse order #${order[0]}`, parseError);
      }
    }
    
    const totalProfit = totalSales - totalCost;

    const topProducts = Object.entries(productCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, qty]) => `${name} (${qty})`);

    let msg = `📊 สรุปยอดขายประจำวัน\n${'='.repeat(40)}\n\n`;
    msg += `📅 วันที่: ${date}\n\n`;
    msg += `📦 จำนวนออเดอร์: ${todayOrders.length} รายการ\n\n`;
    msg += `💰 ต้นทุน: ${totalCost.toLocaleString()}฿\n`;
    msg += `💵 ยอดขาย: ${totalSales.toLocaleString()}฿\n`;
    msg += `📈 กำไร: ${totalProfit.toLocaleString()}฿\n\n`;
    
    if (topProducts.length > 0) {
      msg += `🏆 สินค้าขายดี Top ${topProducts.length}:\n`;
      topProducts.forEach((p, i) => msg += `${i + 1}. ${p}\n`);
    }

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
  generateInboxSummary
};
