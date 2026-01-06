// summaryService.js - Simple Daily Summary that ACTUALLY WORKS
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateString } = require('./utils');
const { getSheetData, appendSheetData } = require('./googleServices');

// ============================================================================
// GENERATE AND SAVE DAILY SUMMARY TO DASHBOARD
// ============================================================================

async function generateAndSaveDailySummary(targetDate = null) {
  try {
    const date = targetDate || getThaiDateString();
    Logger.info(`📊 Generating daily summary for ${date}...`);

    // Get today's orders
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    
    if (orderRows.length <= 1) {
      return '📊 ไม่มีข้อมูลออเดอร์';
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
    const productSales = {};

    // Calculate from line items
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
          if (!productSales[productName]) {
            productSales[productName] = 0;
          }
          productSales[productName] += quantity;
        });
        
      } catch (parseError) {
        Logger.error(`Failed to parse order #${order[0]}`, parseError);
      }
    }
    
    const totalProfit = totalSales - totalCost;

    const topProducts = Object.entries(productSales)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, qty]) => `${name}(${qty})`)
      .join(', ');

    // Save to Dashboard sheet
    try {
      const dashboardRows = await getSheetData(CONFIG.SHEET_ID, 'Dashboard!A:F');
      const exists = dashboardRows.slice(1).some(row => row[0] === date);
      
      if (!exists) {
        const row = [
          date,
          todayOrders.length,
          totalCost,
          totalSales,
          totalProfit,
          topProducts
        ];
        
        await appendSheetData(CONFIG.SHEET_ID, 'Dashboard!A:F', [row]);
        Logger.success(`✅ Saved to Dashboard: ${date}`);
      }
    } catch (dashError) {
      Logger.error('Failed to save to Dashboard', dashError);
    }

    // Format summary message
    let msg = `📊 สรุปยอดขาย\n${'='.repeat(40)}\n\n`;
    msg += `📅 วันที่: ${date}\n\n`;
    msg += `📦 จำนวนออเดอร์: ${todayOrders.length} รายการ\n\n`;
    msg += `💰 ต้นทุน: ${totalCost.toLocaleString()}฿\n`;
    msg += `💵 ยอดขาย: ${totalSales.toLocaleString()}฿\n`;
    msg += `📈 กำไร: ${totalProfit.toLocaleString()}฿\n\n`;
    
    if (topProducts) {
      msg += `🏆 สินค้าขายดี:\n${topProducts}`;
    }

    return msg;

  } catch (error) {
    Logger.error('generateAndSaveDailySummary failed', error);
    return `❌ ไม่สามารถสร้างรายงานได้: ${error.message}`;
  }
}

// ============================================================================
// INBOX SUMMARY - Last N messages
// ============================================================================

async function generateInboxSummary(limit = 15) {
  try {
    Logger.info(`📝 Generating inbox summary (last ${limit})...`);

    const rows = await getSheetData(CONFIG.SHEET_ID, 'Inbox!A:G');
    
    if (rows.length <= 1) {
      return '📝 Inbox ว่างเปล่า\n\nยังไม่มีข้อความในระบบ';
    }

    const messages = rows.slice(1)
      .slice(-limit)
      .reverse();

    let msg = `📝 Inbox (${messages.length} ข้อความล่าสุด)\n${'='.repeat(40)}\n\n`;
    
    messages.forEach((row, idx) => {
      const timestamp = row[0] || '';
      const type = row[2] || '';
      const text = row[3] || '';
      
      const time = timestamp.split(' ')[1] || timestamp;
      
      let icon = '📝';
      if (type === 'voice_transcribed') icon = '🎤';
      if (type === 'order_auto_success') icon = '✅';
      if (type === 'text_input') icon = '⌨️';
      
      msg += `${idx + 1}. [${time}] ${icon} ${text.substring(0, 40)}\n`;
      if (text.length > 40) msg += `   ...\n`;
    });

    return msg;

  } catch (error) {
    Logger.error('generateInboxSummary failed', error);
    return `❌ ไม่สามารถดู Inbox ได้: ${error.message}`;
  }
}

// ============================================================================
// AUTO DAILY SUMMARY (ส่งทุกวันเที่ยงคืน)
// ============================================================================

function scheduleDailySummary(pushToAdminFn) {
  const runDailySummary = async () => {
    const now = new Date();
    const bangkokTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const hour = bangkokTime.getHours();
    const minute = bangkokTime.getMinutes();

    // ส่งสรุปทุกวันเวลา 23:59 น.
    if (hour === 23 && minute === 59) {
      Logger.info('⏰ Auto-sending daily summary...');
      try {
        const summary = await generateAndSaveDailySummary();
        await pushToAdminFn(summary);
        Logger.success('✅ Daily summary sent to admin');
      } catch (error) {
        Logger.error('Failed to send daily summary', error);
      }
    }
  };

  // Check every minute
  setInterval(runDailySummary, 60 * 1000);
  Logger.success('✅ Daily summary scheduler initialized (23:59 BKK)');
}

module.exports = {
  generateAndSaveDailySummary,
  generateInboxSummary,
  scheduleDailySummary
};