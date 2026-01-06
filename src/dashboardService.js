// dashboardService.js - MERGED: Summary + Dashboard + All Features
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateString } = require('./utils');
const { getSheetData, appendSheetData } = require('./googleServices');

// ============================================================================
// DAILY METRICS CALCULATION (from orders)
// ============================================================================

async function calculateDailyMetrics(targetDate = null) {
  try {
    const date = targetDate || getThaiDateString();
    Logger.info(`📊 Calculating metrics for ${date}...`);

    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    
    if (orderRows.length <= 1) {
      Logger.warn('No orders found');
      return null;
    }

    const todayOrders = orderRows.slice(1).filter(row => {
      const orderDate = (row[1] || '').split(' ')[0];
      return orderDate === date;
    });

    if (todayOrders.length === 0) {
      Logger.info(`No orders on ${date}`);
      return {
        date,
        orderCount: 0,
        totalCost: 0,
        totalSales: 0,
        totalProfit: 0,
        topProducts: []
      };
    }

    let totalSales = 0;
    let totalCost = 0;
    const productSales = {};

    // Parse line items from JSON column (Column H)
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
      .map(([name, qty]) => `${name}(${qty})`);

    const metrics = {
      date,
      orderCount: todayOrders.length,
      totalCost,
      totalSales,
      totalProfit,
      topProducts
    };

    Logger.success(`✅ Metrics: ${todayOrders.length} orders, ${totalSales.toLocaleString()}฿`);
    return metrics;

  } catch (error) {
    Logger.error('calculateDailyMetrics failed', error);
    throw error;
  }
}

// ============================================================================
// PERSIST TO DASHBOARD SHEET
// ============================================================================

async function persistDashboardMetrics(metrics) {
  try {
    if (!metrics) {
      Logger.warn('No metrics to persist');
      return false;
    }

    Logger.info(`💾 Persisting metrics to Dashboard...`);

    const existingRows = await getSheetData(CONFIG.SHEET_ID, 'Dashboard!A:F');
    const alreadyExists = existingRows.slice(1).some(row => row[0] === metrics.date);
    
    if (alreadyExists) {
      Logger.warn(`⚠️ Dashboard entry for ${metrics.date} exists - skipping`);
      return false;
    }

    const row = [
      metrics.date,
      metrics.orderCount,
      metrics.totalCost,
      metrics.totalSales,
      metrics.totalProfit,
      metrics.topProducts.join(', ')
    ];

    await appendSheetData(CONFIG.SHEET_ID, 'Dashboard!A:F', [row]);
    Logger.success(`✅ Dashboard saved: ${metrics.date}`);
    return true;

  } catch (error) {
    Logger.error('persistDashboardMetrics failed', error);
    throw error;
  }
}

// ============================================================================
// FORMAT DAILY SUMMARY (Human-readable)
// ============================================================================

function formatDailySummary(metrics) {
  let msg = `📊 สรุปยอดขายประจำวัน\n${'='.repeat(40)}\n\n`;
  msg += `📅 วันที่: ${metrics.date}\n\n`;
  msg += `📦 จำนวนออเดอร์: ${metrics.orderCount} รายการ\n\n`;
  msg += `💰 ต้นทุน: ${metrics.totalCost.toLocaleString()}฿\n`;
  msg += `💵 ยอดขาย: ${metrics.totalSales.toLocaleString()}฿\n`;
  msg += `📈 กำไร: ${metrics.totalProfit.toLocaleString()}฿\n\n`;
  
  if (metrics.topProducts.length > 0) {
    msg += `🏆 สินค้าขายดี Top ${metrics.topProducts.length}:\n`;
    metrics.topProducts.forEach((p, i) => msg += `${i + 1}. ${p}\n`);
  }

  return msg;
}

// ============================================================================
// GENERATE AND SAVE DAILY SUMMARY (Main Function)
// ============================================================================

async function generateAndSaveDailySummary(targetDate = null) {
  try {
    const metrics = await calculateDailyMetrics(targetDate);
    
    if (!metrics) {
      const date = targetDate || getThaiDateString();
      return `📊 สรุปยอดขาย ${date}\n\n❌ ไม่มีข้อมูลออเดอร์`;
    }

    if (metrics.orderCount === 0) {
      return `📊 สรุปยอดขาย ${metrics.date}\n\n❌ ไม่มีออเดอร์วันนี้`;
    }

    // Save to Dashboard sheet
    try {
      await persistDashboardMetrics(metrics);
    } catch (dashError) {
      Logger.error('Failed to save to Dashboard', dashError);
      // Continue even if save fails
    }

    return formatDailySummary(metrics);

  } catch (error) {
    Logger.error('generateAndSaveDailySummary failed', error);
    return `❌ ไม่สามารถสร้างรายงานได้: ${error.message}`;
  }
}

// ============================================================================
// INBOX SUMMARY
// ============================================================================

async function generateInboxSummary(limit = 15) {
  try {
    Logger.info(`📝 Generating inbox summary (last ${limit})...`);

    const rows = await getSheetData(CONFIG.SHEET_ID, 'Inbox!A:B');
    
    if (rows.length <= 1) {
      return '📝 Inbox ว่างเปล่า\n\nยังไม่มีข้อความในระบบ';
    }

    const messages = rows.slice(1)
      .slice(-limit)
      .reverse();

    let msg = `📝 Inbox (${messages.length} ข้อความล่าสุด)\n${'='.repeat(40)}\n\n`;
    
    messages.forEach((row, idx) => {
      const timestamp = row[0] || '';
      const text = row[1] || '';
      
      const time = timestamp.split(' ')[1] || timestamp;
      
      let icon = '📝';
      if (text.includes('🎤')) icon = '🎤';
      if (text.includes('✅')) icon = '✅';
      
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
// SCHEDULED DAILY SUMMARY (Auto-run at 23:59 BKK)
// ============================================================================

function scheduleDailySummary(pushToAdminFn) {
  const runDailySummary = async () => {
    const now = new Date();
    const bangkokTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const hour = bangkokTime.getHours();
    const minute = bangkokTime.getMinutes();

    // Send summary at 23:59 BKK time
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

// ============================================================================
// MANUAL DASHBOARD UPDATE (for testing/manual trigger)
// ============================================================================

async function triggerManualDashboardUpdate(date = null) {
  try {
    Logger.info('🔧 Manual dashboard update');
    const summary = await generateAndSaveDailySummary(date);
    return summary;
  } catch (error) {
    Logger.error('Manual update failed', error);
    return `❌ Update failed: ${error.message}`;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Main functions
  generateAndSaveDailySummary,
  generateInboxSummary,
  
  // Individual components (for testing)
  calculateDailyMetrics,
  persistDashboardMetrics,
  formatDailySummary,
  
  // Scheduler
  scheduleDailySummary,
  triggerManualDashboardUpdate
};