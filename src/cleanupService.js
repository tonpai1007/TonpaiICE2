// src/cleanupService.js - FIXED: Removed circular dependency
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getSheetData, batchUpdateSheet } = require('./googleServices');
const { convertThaiDateToGregorian } = require('./utils');
const axios = require('axios'); // ✅ Direct import instead of requiring app.js

// ============================================================================
// ADMIN NOTIFICATION - ✅ FIXED: No circular dependency
// ============================================================================

async function notifyAdminAboutCleanup(message) {
  try {
    const adminIds = CONFIG.ADMIN_USER_IDS || [];
    
    if (adminIds.length === 0) {
      Logger.warn('No admin users configured for notifications');
      return;
    }
    
    const results = [];
    
    for (const adminId of adminIds) {
      try {
        await axios.post('https://api.line.me/v2/bot/message/push', {
          to: adminId,
          messages: [{ type: 'text', text: message }]
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CONFIG.LINE_TOKEN}`
          },
          timeout: 10000
        });
        
        results.push({ adminId, success: true });
        Logger.debug(`Notified admin: ${adminId.substring(0, 8)}...`);
        
      } catch (error) {
        results.push({ adminId, success: false, error: error.message });
        Logger.error(`Failed to notify admin ${adminId.substring(0, 8)}...`, error);
      }
    }
    
    const succeeded = results.filter(r => r.success).length;
    Logger.info(`📤 Cleanup notification sent to ${succeeded}/${adminIds.length} admins`);
    
  } catch (error) {
    Logger.error('Failed to notify admins about cleanup', error);
  }
}

// ============================================================================
// CLEANUP PAID ORDERS
// ============================================================================

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
    
    const rowsToKeep = [rows[0]]; // Keep header
    let deletedCount = 0;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const dateStr = (row[1] || '').trim();
      const paymentStatus = (row[8] || '').trim();
      
      // Keep unpaid orders
      if (paymentStatus !== 'จ่ายแล้ว') {
        rowsToKeep.push(row);
        continue;
      }

      let orderDate = null;
      
      // Parse date
      if (dateStr.includes('/')) {
        const converted = convertThaiDateToGregorian(dateStr);
        if (converted) {
          orderDate = new Date(converted);
        }
      } else {
        orderDate = new Date(dateStr.split(' ')[0]);
      }

      // Validate date
      if (!orderDate || isNaN(orderDate.getTime())) {
        rowsToKeep.push(row);
        Logger.warn(`Could not parse date: ${dateStr} for order #${row[0]}`);
        continue;
      }

      // Delete if older than 30 days
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

    // Update sheet
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

// ============================================================================
// SCHEDULE CLEANUP
// ============================================================================

function scheduleCleanup() {
  const runCleanup = async () => {
    const now = new Date();
    const bangkokTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const hour = bangkokTime.getHours();
    const minute = bangkokTime.getMinutes();
    
    // Run at 3:00 AM Bangkok time
    if (hour === 3 && minute === 0) {
      Logger.info('⏰ Running scheduled cleanup...');
      
      try {
        const result = await cleanupPaidOrders();
        
        if (result.deleted > 0) {
          // ✅ FIXED: Use local notification function
          await notifyAdminAboutCleanup(
            `🧹 Auto-Cleanup Complete\n\n` +
            `✅ ลบคำสั่งซื้อที่จ่ายแล้ว: ${result.deleted} รายการ\n` +
            `📋 คำสั่งซื้อคงเหลือ: ${result.remaining} รายการ`
          );
        }
        
      } catch (error) {
        Logger.error('Scheduled cleanup failed', error);
        
        // Notify admin about error
        await notifyAdminAboutCleanup(
          `❌ Auto-Cleanup Failed\n\n` +
          `Error: ${error.message}\n\n` +
          `Please check the logs.`
        );
      }
    }
  };

  // Check every minute
  setInterval(runCleanup, 60 * 1000);
  Logger.success('✅ Cleanup scheduler initialized (runs daily at 3:00 AM)');
}

// ============================================================================
// MANUAL CLEANUP
// ============================================================================

async function manualCleanup() {
  Logger.info('🔧 Manual cleanup triggered');
  
  try {
    const result = await cleanupPaidOrders();
    
    let message = `✅ Manual Cleanup Complete\n\n`;
    message += `Deleted: ${result.deleted} orders\n`;
    
    if (result.remaining !== undefined) {
      message += `Remaining: ${result.remaining} orders`;
    }
    
    return message;
    
  } catch (error) {
    Logger.error('Manual cleanup failed', error);
    return `❌ Cleanup Failed: ${error.message}`;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  cleanupPaidOrders,
  scheduleCleanup,
  manualCleanup,
  notifyAdminAboutCleanup // ✅ Export for testing
};