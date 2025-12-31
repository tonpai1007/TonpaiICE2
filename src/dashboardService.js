// dashboardService.js - AUTOMATED DAILY DASHBOARD CALCULATION & PERSISTENCE
// ============================================================================
// 🎯 PURPOSE: Calculate daily metrics and persist to "Dashboard" sheet
// 📊 Metrics: Date | Customer Count | Order Count | Cost | Sales | Profit | Top 5 Products
// ⏰ Trigger: Daily at 23:59 Bangkok Time (automated scheduler)
// ============================================================================

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateString } = require('./utils');
const { getSheetData, appendSheetData } = require('./googleServices');

// ============================================================================
// CORE: CALCULATE DAILY DASHBOARD METRICS
// ============================================================================

async function calculateDailyMetrics(targetDate = null) {
  try {
    const date = targetDate || getThaiDateString();
    Logger.info(`📊 Calculating dashboard metrics for ${date}...`);

    // ========================================================================
    // STEP 1: Fetch Order Headers (คำสั่งซื้อ)
    // ========================================================================
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:H');
    
    if (orderRows.length <= 1) {
      Logger.warn('No orders found for today');
      return null;
    }

    // Filter orders for target date
    const todayOrders = orderRows.slice(1).filter(row => {
      const orderDate = (row[1] || '').split(' ')[0]; // Extract date part
      return orderDate === date;
    });

    if (todayOrders.length === 0) {
      Logger.info(`No orders on ${date}`);
      return {
        date,
        customerCount: 0,
        orderCount: 0,
        totalCost: 0,
        totalSales: 0,
        totalProfit: 0,
        topProducts: []
      };
    }

    // ========================================================================
    // STEP 2: Fetch Line Items (รายการสินค้า)
    // ========================================================================
    const lineItemRows = await getSheetData(CONFIG.SHEET_ID, 'รายการสินค้า!A:G');
    
    const orderNumbers = todayOrders.map(order => order[0]);
    const todayLineItems = lineItemRows.slice(1).filter(row => {
      return orderNumbers.includes(row[0]);
    });

    // ========================================================================
    // STEP 3: Calculate Aggregated Metrics
    // ========================================================================
    
    // Unique customers
    const uniqueCustomers = new Set(todayOrders.map(order => order[2]));
    const customerCount = uniqueCustomers.size;
    
    // Total orders
    const orderCount = todayOrders.length;
    
    // Sales and Cost
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

    // ========================================================================
    // STEP 4: Calculate Top 5 Best-Selling Products
    // ========================================================================
    const productSales = {};
    
    todayLineItems.forEach(line => {
      const productName = line[1];
      const quantity = parseInt(line[2] || 0);
      
      if (!productSales[productName]) {
        productSales[productName] = 0;
      }
      productSales[productName] += quantity;
    });
    
    // Sort by quantity descending
    const topProducts = Object.entries(productSales)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, qty]) => `${name} (${qty})`);

    // ========================================================================
    // STEP 5: Return Structured Metrics
    // ========================================================================
    const metrics = {
      date,
      customerCount,
      orderCount,
      totalCost,
      totalSales,
      totalProfit,
      topProducts
    };

    Logger.success(`✅ Metrics calculated: ${orderCount} orders, ${totalSales.toLocaleString()}฿ sales`);
    
    return metrics;

  } catch (error) {
    Logger.error('calculateDailyMetrics failed', error);
    throw error;
  }
}

// ============================================================================
// PERSISTENCE: WRITE TO DASHBOARD SHEET
// ============================================================================

async function persistDashboardMetrics(metrics) {
  try {
    if (!metrics) {
      Logger.warn('No metrics to persist');
      return false;
    }

    Logger.info(`💾 Persisting metrics to Dashboard sheet...`);

    // ========================================================================
    // Check if entry already exists
    // ========================================================================
    const existingRows = await getSheetData(CONFIG.SHEET_ID, 'Dashboard!A:G');
    
    const alreadyExists = existingRows.slice(1).some(row => row[0] === metrics.date);
    
    if (alreadyExists) {
      Logger.warn(`⚠️ Dashboard entry for ${metrics.date} already exists - skipping`);
      return false;
    }

    // ========================================================================
    // Format row data
    // ========================================================================
    const row = [
      metrics.date,
      metrics.customerCount,
      metrics.orderCount,
      metrics.totalCost,
      metrics.totalSales,
      metrics.totalProfit,
      metrics.topProducts.join(', ')
    ];

    // ========================================================================
    // Append to sheet
    // ========================================================================
    await appendSheetData(CONFIG.SHEET_ID, 'Dashboard!A:G', [row]);

    Logger.success(`✅ Dashboard metrics saved for ${metrics.date}`);
    Logger.info(`   📊 ${metrics.orderCount} orders | ${metrics.totalSales.toLocaleString()}฿ sales | ${metrics.totalProfit.toLocaleString()}฿ profit`);

    return true;

  } catch (error) {
    Logger.error('persistDashboardMetrics failed', error);
    throw error;
  }
}

// ============================================================================
// AUTOMATION: DAILY SUMMARY JOB
// ============================================================================

async function runDailySummaryJob() {
  try {
    Logger.info('🔄 Running daily summary job...');

    const metrics = await calculateDailyMetrics();
    
    if (!metrics) {
      Logger.info('No data to summarize today');
      return null;
    }

    await persistDashboardMetrics(metrics);

    // ========================================================================
    // Generate summary message for admin
    // ========================================================================
    const summary = formatDailySummary(metrics);

    return {
      success: true,
      metrics,
      summary
    };

  } catch (error) {
    Logger.error('runDailySummaryJob failed', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// ============================================================================
// FORMATTING: ADMIN NOTIFICATION MESSAGE
// ============================================================================

function formatDailySummary(metrics) {
  let message = `📊 สรุปยอดขายประจำวัน\n`;
  message += `${'='.repeat(40)}\n\n`;
  message += `📅 วันที่: ${metrics.date}\n\n`;
  message += `👥 ลูกค้า: ${metrics.customerCount} คน\n`;
  message += `📦 คำสั่งซื้อ: ${metrics.orderCount} รายการ\n\n`;
  message += `💰 ต้นทุน: ${metrics.totalCost.toLocaleString()}฿\n`;
  message += `💵 ยอดขาย: ${metrics.totalSales.toLocaleString()}฿\n`;
  message += `📈 กำไร: ${metrics.totalProfit.toLocaleString()}฿\n\n`;
  
  if (metrics.topProducts.length > 0) {
    message += `🏆 สินค้าขายดี Top ${metrics.topProducts.length}:\n`;
    metrics.topProducts.forEach((product, idx) => {
      message += `${idx + 1}. ${product}\n`;
    });
  }

  return message;
}

// ============================================================================
// SCHEDULER: DAILY CRON-LIKE AUTOMATION
// ============================================================================

function scheduleDailyDashboard() {
  const runScheduledJob = async () => {
    const now = new Date();
    const bangkokTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    
    const hour = bangkokTime.getHours();
    const minute = bangkokTime.getMinutes();

    // Run at 23:59 Bangkok time
    if (hour === 23 && minute === 59) {
      Logger.info('⏰ Scheduled dashboard job triggered');

      try {
        const result = await runDailySummaryJob();

        if (result.success) {
          // Notify admin
          const { notifyAdmin } = require('./app');
          await notifyAdmin(result.summary);
        }

      } catch (error) {
        Logger.error('Scheduled dashboard job failed', error);
      }
    }
  };

  // Check every 60 seconds
  setInterval(runScheduledJob, 60 * 1000);
  
  Logger.success('✅ Daily dashboard scheduler initialized (23:59 BKK)');
}

// ============================================================================
// MANUAL TRIGGER (For testing or on-demand)
// ============================================================================

async function triggerManualDashboardUpdate(date = null) {
  try {
    Logger.info('🔧 Manual dashboard update triggered');

    const metrics = await calculateDailyMetrics(date);
    
    if (!metrics) {
      return '⚠️ No data found for the specified date';
    }

    await persistDashboardMetrics(metrics);

    const summary = formatDailySummary(metrics);
    
    return `✅ Dashboard Updated\n\n${summary}`;

  } catch (error) {
    Logger.error('Manual dashboard update failed', error);
    return `❌ Update failed: ${error.message}`;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  calculateDailyMetrics,
  persistDashboardMetrics,
  runDailySummaryJob,
  scheduleDailyDashboard,
  triggerManualDashboardUpdate,
  formatDailySummary
};