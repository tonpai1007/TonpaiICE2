// dashboardService.js - FIXED: Correct schema mapping
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateString } = require('./utils');
const { getSheetData, appendSheetData } = require('./googleServices');

async function calculateDailyMetrics(targetDate = null) {
  try {
    const date = targetDate || getThaiDateString();
    Logger.info(`📊 Calculating dashboard metrics for ${date}...`);

    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:H');
    
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

    const lineItemRows = await getSheetData(CONFIG.SHEET_ID, 'รายละเอียดคำสั่งซื้อ!A:G');
    const orderNumbers = todayOrders.map(order => order[0]);
    const todayLineItems = lineItemRows.slice(1).filter(row => orderNumbers.includes(row[0]));

    const orderCount = todayOrders.length;
    let totalSales = 0;
    let totalCost = 0;
    
    todayLineItems.forEach(line => {
      const quantity = parseInt(line[2] || 0);
      const unitPrice = parseFloat(line[4] || 0);
      const unitCost = parseFloat(line[5] || 0);
      
      totalSales += (quantity * unitPrice);
      totalCost += (quantity * unitCost);
    });
    
    const totalProfit = totalSales - totalCost;

    const productSales = {};
    todayLineItems.forEach(line => {
      const productName = line[1];
      const quantity = parseInt(line[2] || 0);
      
      if (!productSales[productName]) {
        productSales[productName] = 0;
      }
      productSales[productName] += quantity;
    });
    
    const topProducts = Object.entries(productSales)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, qty]) => `${name}(${qty})`);

    const metrics = {
      date,
      orderCount,
      totalCost,
      totalSales,
      totalProfit,
      topProducts
    };

    Logger.success(`✅ Metrics: ${orderCount} orders, ${totalSales.toLocaleString()}฿ sales`);
    return metrics;

  } catch (error) {
    Logger.error('calculateDailyMetrics failed', error);
    throw error;
  }
}

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

    // FIXED: Match new schema (วันที่, จำนวนออเดอร์, ต้นทุน, ยอดขาย, กำไร, Top5)
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

async function runDailySummaryJob() {
  try {
    Logger.info('🔄 Running daily summary job...');
    const metrics = await calculateDailyMetrics();
    
    if (!metrics) {
      Logger.info('No data to summarize');
      return null;
    }

    await persistDashboardMetrics(metrics);
    const summary = formatDailySummary(metrics);

    return { success: true, metrics, summary };
  } catch (error) {
    Logger.error('runDailySummaryJob failed', error);
    return { success: false, error: error.message };
  }
}

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

function scheduleDailyDashboard() {
  const runScheduledJob = async () => {
    const now = new Date();
    const bangkokTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const hour = bangkokTime.getHours();
    const minute = bangkokTime.getMinutes();

    if (hour === 23 && minute === 59) {
      Logger.info('⏰ Scheduled dashboard job triggered');
      try {
        const result = await runDailySummaryJob();
        if (result.success) {
          const { notifyAdmin } = require('./app');
          await notifyAdmin(result.summary);
        }
      } catch (error) {
        Logger.error('Scheduled job failed', error);
      }
    }
  };

  setInterval(runScheduledJob, 60 * 1000);
  Logger.success('✅ Daily dashboard scheduler initialized (23:59 BKK)');
}

async function triggerManualDashboardUpdate(date = null) {
  try {
    Logger.info('🔧 Manual dashboard update');
    const metrics = await calculateDailyMetrics(date);
    
    if (!metrics) {
      return '⚠️ No data found';
    }

    await persistDashboardMetrics(metrics);
    return `✅ Dashboard Updated\n\n${formatDailySummary(metrics)}`;
  } catch (error) {
    Logger.error('Manual update failed', error);
    return `❌ Update failed: ${error.message}`;
  }
}

module.exports = {
  calculateDailyMetrics,
  persistDashboardMetrics,
  runDailySummaryJob,
  scheduleDailyDashboard,
  triggerManualDashboardUpdate,
  formatDailySummary
};