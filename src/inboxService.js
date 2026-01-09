// inboxService.js - ENHANCED: More readable inbox with better formatting

const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { appendSheetData, getSheetData, updateSheetData } = require('./googleServices');
const { loadStockCache } = require('./cacheManager');

// ============================================================================
// ENHANCED INBOX: Better categorization and formatting
// ============================================================================

async function saveToInbox(userId, text, type = 'text', metadata = {}) {
  try {
    let displayText = text;
    let category = '📝';
    
    // Enhanced categorization
    switch (type) {
      case 'voice_raw':
        category = '🎤';
        displayText = `[Voice Input]`;
        break;
        
      case 'voice_transcribed':
        category = '🎤';
        displayText = `"${text}"`;
        break;
        
      case 'order_success':
      case 'order_auto_success':
        category = '✅';
        displayText = `Order: ${text}`;
        break;
        
      case 'order_attempt':
        category = '📦';
        displayText = `Attempting: "${text}"`;
        break;
        
      case 'insufficient_stock':
        category = '⚠️';
        displayText = `Stock issue: ${text}`;
        break;
        
      case 'parse_failed':
        category = '❌';
        displayText = `Parse failed: "${text}"`;
        break;
        
      case 'stock_adjustment':
        category = '🔧';
        displayText = `Stock: ${text}`;
        break;
        
      case 'payment_update':
        category = '💰';
        displayText = `Payment: ${text}`;
        break;
        
      case 'delivery_update':
        category = '🚚';
        displayText = `Delivery: ${text}`;
        break;
        
      case 'cancel':
        category = '❌';
        displayText = `Cancelled: ${text}`;
        break;
        
      case 'pending_review':
        category = '⏳';
        displayText = `Pending: "${text}"`;
        break;
        
      case 'error':
        category = '🔴';
        displayText = `Error: ${text}`;
        break;
        
      default:
        category = '📝';
        displayText = text;
    }

    const row = [
      getThaiDateTimeString(),
      `${category} ${displayText}`
    ];

    await appendSheetData(CONFIG.SHEET_ID, 'Inbox!A:B', [row]);
    Logger.success(`📥 Saved to Inbox: ${type}`);
    return true;
  } catch (error) {
    Logger.error('saveToInbox failed', error);
    return false;
  }
}

// ============================================================================
// ENHANCED CANCEL ORDER: Better stock restoration tracking
// ============================================================================

async function cancelOrder(orderNo) {
  try {
    Logger.info(`🔄 Cancelling order #${orderNo}...`);

    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    const orderItems = [];
    let customer = '';

    // Collect all items from this order
    for (let i = 1; i < orderRows.length; i++) {
      if (orderRows[i][0] == orderNo) {
        customer = orderRows[i][2];
        orderItems.push({
          rowIndex: i + 1,
          product: orderRows[i][3],
          quantity: parseInt(orderRows[i][4] || 0)
        });
      }
    }

    if (orderItems.length === 0) {
      return { success: false, error: `ไม่พบออเดอร์ #${orderNo}` };
    }

    // Restore stock for each item
    const stockRestored = [];
    const stockRows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');

    for (const orderItem of orderItems) {
      const productName = orderItem.product.toLowerCase().trim();

      for (let i = 1; i < stockRows.length; i++) {
        const stockName = (stockRows[i][0] || '').toLowerCase().trim();
        
        if (stockName === productName) {
          const currentStock = parseInt(stockRows[i][4] || 0);
          const newStock = currentStock + orderItem.quantity;
          const unit = stockRows[i][3] || 'ชิ้น';
          
          // Update stock
          await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${i + 1}`, [[newStock]]);
          
          stockRestored.push({ 
            item: orderItem.product, 
            restored: orderItem.quantity, 
            newStock,
            unit
          });
          
          Logger.success(`✅ Restored: ${orderItem.product} +${orderItem.quantity} → ${newStock}`);
          break;
        }
      }
    }

    // Mark order as cancelled by updating notes (Column F)
    for (const orderItem of orderItems) {
      await updateSheetData(
        CONFIG.SHEET_ID, 
        `คำสั่งซื้อ!F${orderItem.rowIndex}`, 
        [['[ยกเลิกแล้ว]']]
      );
    }

    // Reload cache
    await loadStockCache(true);

    // Save to inbox
    await saveToInbox(
      'system', 
      `Order #${orderNo} cancelled: ${customer}`, 
      'cancel'
    );

    Logger.success(`✅ Cancelled order #${orderNo}, restored ${stockRestored.length} items`);

    return {
      success: true,
      orderNo,
      customer,
      stockRestored
    };

  } catch (error) {
    Logger.error('cancelOrder failed', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// ENHANCED INBOX SUMMARY: More readable with better grouping
// ============================================================================

async function generateInboxSummary(limit = 20) {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'Inbox!A:B');
    
    if (rows.length <= 1) {
      return '📝 Inbox ว่างเปล่า\n\n' +
             '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
             '💡 ยังไม่มีกิจกรรมในระบบ\n' +
             'ประวัติคำสั่งจะแสดงที่นี่';
    }

    const messages = rows.slice(1)
      .slice(-limit)
      .reverse();

    // Group messages by type for better readability
    const categorized = {
      orders: [],
      stock: [],
      payments: [],
      delivery: [],
      errors: [],
      other: []
    };

    messages.forEach(row => {
      const timestamp = row[0] || '';
      const text = row[1] || '';
      
      const entry = { timestamp, text, time: timestamp.split(' ')[1] || timestamp };
      
      if (text.includes('✅') && text.includes('Order')) {
        categorized.orders.push(entry);
      } else if (text.includes('🔧') || text.includes('Stock')) {
        categorized.stock.push(entry);
      } else if (text.includes('💰') || text.includes('Payment')) {
        categorized.payments.push(entry);
      } else if (text.includes('🚚') || text.includes('Delivery')) {
        categorized.delivery.push(entry);
      } else if (text.includes('❌') || text.includes('🔴') || text.includes('⚠️')) {
        categorized.errors.push(entry);
      } else {
        categorized.other.push(entry);
      }
    });

    let msg = `📝 Inbox - กิจกรรมล่าสุด\n`;
    msg += `${'='.repeat(40)}\n`;
    msg += `แสดง ${messages.length} รายการ (จาก ${rows.length - 1} ทั้งหมด)\n\n`;

    // Show successful orders first
    if (categorized.orders.length > 0) {
      msg += `✅ ออเดอร์สำเร็จ (${categorized.orders.length}):\n`;
      msg += `${'─'.repeat(40)}\n`;
      categorized.orders.slice(0, 5).forEach(entry => {
        const shortText = entry.text.substring(0, 50);
        msg += `[${entry.time}] ${shortText}\n`;
        if (entry.text.length > 50) msg += `           ...\n`;
      });
      if (categorized.orders.length > 5) {
        msg += `           ... และอีก ${categorized.orders.length - 5} รายการ\n`;
      }
      msg += `\n`;
    }

    // Show stock adjustments
    if (categorized.stock.length > 0) {
      msg += `🔧 ปรับสต็อก (${categorized.stock.length}):\n`;
      msg += `${'─'.repeat(40)}\n`;
      categorized.stock.slice(0, 3).forEach(entry => {
        const shortText = entry.text.substring(0, 50);
        msg += `[${entry.time}] ${shortText}\n`;
      });
      if (categorized.stock.length > 3) {
        msg += `           ... และอีก ${categorized.stock.length - 3} รายการ\n`;
      }
      msg += `\n`;
    }

    // Show payments
    if (categorized.payments.length > 0) {
      msg += `💰 การชำระเงิน (${categorized.payments.length}):\n`;
      msg += `${'─'.repeat(40)}\n`;
      categorized.payments.slice(0, 3).forEach(entry => {
        const shortText = entry.text.substring(0, 50);
        msg += `[${entry.time}] ${shortText}\n`;
      });
      if (categorized.payments.length > 3) {
        msg += `           ... และอีก ${categorized.payments.length - 3} รายการ\n`;
      }
      msg += `\n`;
    }

    // Show deliveries
    if (categorized.delivery.length > 0) {
      msg += `🚚 การจัดส่ง (${categorized.delivery.length}):\n`;
      msg += `${'─'.repeat(40)}\n`;
      categorized.delivery.slice(0, 3).forEach(entry => {
        const shortText = entry.text.substring(0, 50);
        msg += `[${entry.time}] ${shortText}\n`;
      });
      if (categorized.delivery.length > 3) {
        msg += `           ... และอีก ${categorized.delivery.length - 3} รายการ\n`;
      }
      msg += `\n`;
    }

    // Show errors/warnings
    if (categorized.errors.length > 0) {
      msg += `⚠️ ข้อผิดพลาด/แจ้งเตือน (${categorized.errors.length}):\n`;
      msg += `${'─'.repeat(40)}\n`;
      categorized.errors.forEach(entry => {
        const shortText = entry.text.substring(0, 50);
        msg += `[${entry.time}] ${shortText}\n`;
        if (entry.text.length > 50) msg += `           ...\n`;
      });
      msg += `\n`;
    }

    // Show other activities
    if (categorized.other.length > 0 && categorized.other.length <= 5) {
      msg += `📋 กิจกรรมอื่นๆ (${categorized.other.length}):\n`;
      msg += `${'─'.repeat(40)}\n`;
      categorized.other.forEach(entry => {
        const shortText = entry.text.substring(0, 50);
        msg += `[${entry.time}] ${shortText}\n`;
        if (entry.text.length > 50) msg += `           ...\n`;
      });
      msg += `\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 สรุป:\n`;
    msg += `   ✅ ออเดอร์: ${categorized.orders.length}\n`;
    msg += `   🔧 ปรับสต็อก: ${categorized.stock.length}\n`;
    msg += `   💰 ชำระเงิน: ${categorized.payments.length}\n`;
    msg += `   🚚 จัดส่ง: ${categorized.delivery.length}\n`;
    if (categorized.errors.length > 0) {
      msg += `   ⚠️ ข้อผิดพลาด: ${categorized.errors.length}\n`;
    }

    return msg;

  } catch (error) {
    Logger.error('generateInboxSummary failed', error);
    return `❌ ไม่สามารถดู Inbox ได้\n\n${error.message}`;
  }
}

module.exports = {
  saveToInbox,
  cancelOrder,
  generateInboxSummary
};
