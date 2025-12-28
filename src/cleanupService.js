// src/cleanupService.js
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getSheetData, batchUpdateSheet } = require('./googleServices');
const { convertThaiDateToGregorian } = require('./utils');

async function cleanupPaidOrders() {
  try {
    Logger.info('🧹 Starting cleanup of paid orders...');

    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:J');
    
    if (rows.length <= 1) {
      Logger.info('No orders to clean');
      return { deleted: 0 };
    }

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
    
    const rowsToKeep = [rows[0]];
    let deletedCount = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const dateStr = (row[1] || '').trim();
      const paymentStatus = (row[8] || '').trim();
      
      if (paymentStatus !== 'จ่ายแล้ว') {
        rowsToKeep.push(row);
        continue;
      }

      let orderDate = null;
      
      if (dateStr.includes('/')) {
        const converted = convertThaiDateToGregorian(dateStr);
        if (converted) {
          orderDate = new Date(converted);
        }
      } else {
        orderDate = new Date(dateStr.split(' ')[0]);
      }

      if (!orderDate || isNaN(orderDate.getTime())) {
        rowsToKeep.push(row);
        Logger.warn(`Could not parse date: ${dateStr} for order #${row[0]}`);
        continue;
      }

      if (orderDate < thirtyDaysAgo) {
        deletedCount++;
        Logger.info(`Deleting paid order #${row[0]} from ${dateStr}`);
      } else {
        rowsToKeep.push(row);
      }
    }

    if (deletedCount === 0) {
      Logger.success('No paid orders older than 30 days');
      return { deleted: 0 };
    }

    await batchUpdateSheet(CONFIG.SHEET_ID, [
      {
        range: 'คำสั่งซื้อ!A:J',
        values: rowsToKeep
      }
    ]);

    Logger.success(`✅ Deleted ${deletedCount} paid orders older than 30 days`);
    
    return {
      deleted: deletedCount,
      remaining: rowsToKeep.length - 1
    };

  } catch (error) {
    Logger.error('Cleanup failed', error);
    throw error;
  }
}

function scheduleCleanup() {
  const runCleanup = async () => {
    const now = new Date();
    const bangkokTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const hour = bangkokTime.getHours();
    const minute = bangkokTime.getMinutes();
    
    if (hour === 3 && minute === 0) {
      Logger.info('⏰ Running scheduled cleanup...');
      try {
        const result = await cleanupPaidOrders();
        
        if (result.deleted > 0) {
          const { notifyAdmin } = require('./app');
          await notifyAdmin(
            `🧹 Auto-Cleanup Complete\n\n` +
            `✅ ลบคำสั่งซื้อที่จ่ายแล้ว: ${result.deleted} รายการ\n` +
            `📋 คำสั่งซื้อคงเหลือ: ${result.remaining} รายการ`
          );
        }
      } catch (error) {
        Logger.error('Scheduled cleanup failed', error);
      }
    }
  };

  setInterval(runCleanup, 60 * 1000);
  Logger.success('✅ Cleanup scheduler initialized');
}

async function manualCleanup() {
  Logger.info('🔧 Manual cleanup triggered');
  const result = await cleanupPaidOrders();
  return `✅ Manual Cleanup Complete\n\nDeleted: ${result.deleted} orders\nRemaining: ${result.remaining} orders`;
}

module.exports = {
  cleanupPaidOrders,
  scheduleCleanup,
  manualCleanup
};
