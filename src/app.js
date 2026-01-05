// app.js - FULLY INTEGRATED with UX Enhancements
const express = require('express');
const axios = require('axios');

const { configManager, validateConfig } = require('./config');
const { Logger } = require('./logger');

validateConfig();

const { initializeGoogleServices } = require('./googleServices');
const { initializeAIServices, transcribeAudio } = require('./aiServices');
const { initializeSheets } = require('./sheetInitializer');
const { loadStockCache, loadCustomerCache } = require('./cacheManager');
const { parseOrder } = require('./orderParser');
const { createOrderTransaction, updateOrderPaymentStatus } = require('./orderService');
const { saveToInbox, cancelOrder } = require('./inboxService');
const { adjustStock, parseAdjustmentCommand, generateVarianceReport, viewCurrentStock } = require('./stockadjustment');
const { shouldAutoProcess, applySmartCorrection, monitor } = require('./aggressiveAutoConfig');
const { autoAddCustomer } = require('./customerService');

// ✨ UX ENHANCEMENTS - Inline Implementation
// No external module needed

const app = express();
app.use(express.json());

// ============================================================================
// INBOX: บันทึกทุก Input ที่เข้ามา (FIXED: Simple 2-column format)
// ============================================================================



// 1. Stock Monitor
function checkStockWarnings(items) {
  const warnings = [];
  const criticalItems = [];
  
  items.forEach(item => {
    const remaining = item.stockItem.stock - item.quantity;
    
    if (remaining < 0) {
      warnings.push({
        level: 'critical',
        icon: '🔴',
        message: `⚠️ สต็อกไม่พอ!\n${item.stockItem.item}: มี ${item.stockItem.stock} เหลือ (สั่ง ${item.quantity})`,
        canProceed: false,
        item: item.stockItem.item
      });
      criticalItems.push(item.stockItem.item);
    } else if (remaining <= 3) {
      warnings.push({
        level: 'critical',
        icon: '🔴',
        message: `⚠️ สต็อกเหลือน้อยมาก!\n${item.stockItem.item}: จะเหลือ ${remaining} ${item.stockItem.unit}`,
        canProceed: true
      });
    } else if (remaining <= 10) {
      warnings.push({
        level: 'warning',
        icon: '🟡',
        message: `💡 สต็อกใกล้หมด\n${item.stockItem.item}: จะเหลือ ${remaining} ${item.stockItem.unit}`,
        canProceed: true
      });
    }
  });
  
  return {
    hasWarnings: warnings.length > 0,
    hasCritical: criticalItems.length > 0,
    warnings,
    criticalItems
  };
}

function formatStockWarnings(checkResult) {
  if (!checkResult.hasWarnings) return null;
  
  if (checkResult.hasCritical) {
    return '🔴 สต็อกไม่พอ!\n\n' + 
           checkResult.warnings
             .filter(w => !w.canProceed)
             .map(w => w.message)
             .join('\n\n') +
           '\n\n❌ ไม่สามารถสร้างออเดอร์ได้';
  }
  
  return checkResult.warnings.map(w => w.message).join('\n');
}

// 2. Quick Actions Formatter
function formatOrderSuccess(orderNo, customer, items, totalAmount, confidence) {
  const summary = items.map(i => {
    const itemName = i.productName || i.stockItem?.item || 'สินค้า';
    const newStock = i.newStock !== undefined ? i.newStock : 0;
    
    let stockIcon = '✅';
    if (newStock <= 3) stockIcon = '🔴';
    else if (newStock <= 10) stockIcon = '🟡';
    
    return `${stockIcon} ${itemName} x${i.quantity} (${newStock} เหลือ)`;
  }).join('\n');
  
  return `✅ บันทึกออเดอร์สำเร็จ!\n\n` +
         `📋 คำสั่งซื้อ #${orderNo}\n` +
         `👤 ${customer}\n\n` +
         `${summary}\n\n` +
         `💰 รวม: ${totalAmount.toLocaleString()}฿\n` +
         `🎯 ความมั่นใจ: ${confidence}\n\n` +
         `━━━━━━━━━━━━━━━━━━━━\n` +
         `⚡ Quick Actions:\n` +
         `• "จ่าย #${orderNo}" - จ่ายเงิน\n` +
         `• "ส่ง #${orderNo}" - อัปเดตการจัดส่ง\n` +
         `• "ยกเลิก #${orderNo}" - ยกเลิกออเดอร์`;
}

function formatPaymentSuccess(orderNo, customer, totalAmount) {
  return `✅ อัปเดตการชำระเงินสำเร็จ\n\n` +
         `📋 #${orderNo} | ${customer}\n` +
         `💰 ${totalAmount.toLocaleString()}฿\n\n` +
         `━━━━━━━━━━━━━━━━━━━━\n` +
         `⚡ Next Actions:\n` +
         `• "ส่ง #${orderNo}" - อัปเดตการจัดส่ง\n` +
         `• "รายงานสต็อก" - ดูสต็อกวันนี้`;
}

function formatCancelSuccess(orderNo, customer, stockRestored) {
  const restoredList = stockRestored
    .map(s => `• ${s.item} +${s.restored} (${s.newStock} เหลือ)`)
    .join('\n');
  
  return `✅ ยกเลิกออเดอร์สำเร็จ\n\n` +
         `📋 #${orderNo} | ${customer}\n\n` +
         `📦 คืนสต็อก:\n${restoredList}\n\n` +
         `━━━━━━━━━━━━━━━━━━━━\n` +
         `💡 สต็อกถูกคืนกลับแล้ว`;
}

// 3. Delivery Tracker
async function updateDeliveryStatus(orderNo, status, deliveryPerson = null) {
  try {
    const validStatuses = {
      'รอดำเนินการ': '⏳',
      'กำลังเตรียม': '📦',
      'กำลังจัดส่ง': '🚚',
      'ส่งเสร็จแล้ว': '✅',
      'ยกเลิก': '❌'
    };
    
    if (!validStatuses[status]) {
      return { success: false, error: 'สถานะไม่ถูกต้อง' };
    }
    
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    let rowIndex = -1;
    let orderData = null;
    
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] == orderNo) {
        rowIndex = i + 1;
        orderData = {
          customer: rows[i][2],
          items: rows[i][3],
          currentStatus: rows[i][4]
        };
        break;
      }
    }
    
    if (!orderData) {
      return { success: false, error: `ไม่พบออเดอร์ #${orderNo}` };
    }
    
    const { updateSheetData } = require('./googleServices');
    
    // Update delivery status
    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!E${rowIndex}`, [[status]]);
    
    // Update delivery person if provided
    if (deliveryPerson) {
      await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!D${rowIndex}`, [[deliveryPerson]]);
    }
    
    const icon = validStatuses[status];
    
    return {
      success: true,
      orderNo,
      customer: orderData.customer,
      oldStatus: orderData.currentStatus,
      newStatus: status,
      icon,
      deliveryPerson
    };
    
  } catch (error) {
    Logger.error('updateDeliveryStatus failed', error);
    return { success: false, error: error.message };
  }
}

function formatDeliveryStatus(result) {
  let msg = `${result.icon} อัปเดตสถานะการจัดส่ง\n\n`;
  msg += `📋 ออเดอร์ #${result.orderNo}\n`;
  msg += `👤 ${result.customer}\n\n`;
  msg += `สถานะ: ${result.oldStatus} → ${result.newStatus}\n`;
  
  if (result.deliveryPerson) {
    msg += `🚚 คนส่ง: ${result.deliveryPerson}\n`;
  }
  
  if (result.newStatus === 'ส่งเสร็จแล้ว') {
    msg += `\n💡 พิมพ์ "จ่าย #${result.orderNo}" เพื่ออัปเดตการชำระเงิน`;
  }
  
  return msg;
}

// 4. Smart Error Messages
function formatError(errorType, details = {}) {
  const errors = {
    'order_not_found': `❌ ไม่พบออเดอร์ #${details.orderNo}\n\n` +
                       `━━━━━━━━━━━━━━━━━━━━\n` +
                       `💡 แก้ไข:\n` +
                       `• ตรวจสอบเลขออเดอร์\n` +
                       `• ออเดอร์อาจถูกยกเลิกไปแล้ว`,
    
    'parse_failed': `❌ ไม่เข้าใจคำสั่ง\n\n` +
                    `"${details.input}"\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `💡 ตัวอย่างที่ถูกต้อง:\n` +
                    `• "น้ำแข็ง 2 ถุง ร้านเจ๊แดง" (สั่งซื้อ)\n` +
                    `• "จ่าย #123" (ชำระเงิน)\n` +
                    `• "เติมน้ำแข็ง 20" (ปรับสต็อก)\n\n` +
                    `พิมพ์ "help" เพื่อดูคำสั่งทั้งหมด`
  };
  
  return errors[errorType] || `❌ เกิดข้อผิดพลาด\n\n${details.message || 'Unknown error'}`;
}

// 5. Contextual Help
function getContextualHelp(context) {
  const helps = {
    'stock_low': `⚠️ สต็อกเหลือน้อย!\n\n` +
                 `📝 ควรทำ:\n` +
                 `• "เติมน้ำแข็ง 50" - เติมสต็อก\n` +
                 `• "สต็อก" - ดูรายการที่เหลือน้อย\n` +
                 `• "รายงานสต็อก" - ดูการใช้วันนี้`
  };
  
  return helps[context] || '';
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initializeApp() {
  try {
    Logger.info('🚀 Starting Enhanced Order Bot...');
    
    initializeGoogleServices();
    initializeAIServices();
    
    await initializeSheets();
    await loadStockCache(true);
    await loadCustomerCache(true);
    
    Logger.success('✅ System Ready with UX Enhancements 🎯');
  } catch (error) {
    Logger.error('❌ Init failed', error);
    process.exit(1);
  }
}

// ============================================================================
// LINE MESSAGING
// ============================================================================

async function replyToLine(replyToken, text) {
  const token = configManager.get('LINE_TOKEN');
  try {
    await axios.post('https://api.line.me/v2/bot/message/reply', {
      replyToken,
      messages: [{ type: 'text', text }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });
  } catch (error) {
    Logger.error('Reply failed', error);
  }
}

async function pushToAdmin(text) {
  const adminIds = configManager.get('ADMIN_USER_IDS');
  const token = configManager.get('LINE_TOKEN');
  
  try {
    for (const adminId of adminIds) {
      await axios.post('https://api.line.me/v2/bot/message/push', {
        to: adminId,
        messages: [{ type: 'text', text }]
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });
    }
    Logger.success('✅ Admin notified');
  } catch (error) {
    Logger.error('pushToAdmin failed', error);
  }
}

async function fetchAudioFromLine(messageId) {
  const token = configManager.get('LINE_TOKEN');
  const response = await axios.get(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { 'Authorization': `Bearer ${token}` },
      responseType: 'arraybuffer'
    }
  );
  return Buffer.from(response.data);
}

// ============================================================================
// TEXT HANDLER - ENHANCED with UX Features
// ============================================================================

async function handleTextMessage(text, replyToken, userId) {
  try {
    const lower = text.toLowerCase().trim();

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 💰 PAYMENT COMMAND: "จ่าย #123"
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const paymentMatch = text.match(/(?:จ่าย(?:เงิน|ตัง|แล้ว)?)\s*#?(\d+)/i);
    if (paymentMatch) {
      const orderNo = paymentMatch[1];
      const result = await updateOrderPaymentStatus(orderNo, 'จ่ายแล้ว');

      if (result.success) {
        const msg = formatPaymentSuccess(
          orderNo,
          result.customer,
          result.totalAmount
        );
        
        await replyToLine(replyToken, msg);
        await saveToInbox(userId, text);
        Logger.success(`✅ Payment updated #${orderNo}`);
      } else {
        const errorMsg = formatError('order_not_found', { orderNo });
        await replyToLine(replyToken, errorMsg);
      }
      return;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 🚚 DELIVERY COMMAND: "ส่ง #123" or "ส่ง #123 พี่แดง"
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const deliveryMatch = text.match(/ส่ง\s*#?(\d+)(?:\s+(.+))?/i);
    if (deliveryMatch) {
      const orderNo = deliveryMatch[1];
      const deliveryPerson = deliveryMatch[2]?.trim() || null;
      
      const result = await updateDeliveryStatus(
        orderNo,
        'กำลังจัดส่ง',
        deliveryPerson
      );

      if (result.success) {
        const msg = formatDeliveryStatus(result);
        await replyToLine(replyToken, msg);
        await saveToInbox(userId, text);
        Logger.success(`✅ Delivery updated #${orderNo}`);
      } else {
        const errorMsg = formatError('order_not_found', { orderNo });
        await replyToLine(replyToken, errorMsg);
      }
      return;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 🚫 CANCEL ORDER: "ยกเลิก #123"
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const cancelMatch = text.match(/ยกเลิก\s*#?(\d+)/i);
    if (cancelMatch) {
      const orderNo = cancelMatch[1];
      const result = await cancelOrder(orderNo);

      if (result.success) {
        const msg = formatCancelSuccess(
          orderNo,
          result.customer,
          result.stockRestored
        );
        
        await replyToLine(replyToken, msg);
        await saveToInbox(userId, text);
        monitor.recordCancellation(orderNo, true);
        Logger.success(`✅ Cancelled order #${orderNo}`);
      } else {
        const errorMsg = formatError('order_not_found', { orderNo });
        await replyToLine(replyToken, errorMsg);
      }
      return;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 🔧 STOCK ADJUSTMENT
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const adjCommand = await parseAdjustmentCommand(text);
    if (adjCommand.isAdjustment) {
      const result = await adjustStock(
        adjCommand.item,
        adjCommand.value,
        adjCommand.operation,
        'text_adjustment'
      );

      if (result.success) {
        const icon = result.difference === 0 ? '➖' : result.difference > 0 ? '📈' : '📉';
        
        let msg = `✅ ปรับสต็อกสำเร็จ\n\n`;
        msg += `📦 ${result.item}\n`;
        msg += `━━━━━━━━━━━━━━\n`;
        msg += `เดิม: ${result.oldStock} ${result.unit}\n`;
        msg += `ใหม่: ${result.newStock} ${result.unit}\n`;
        msg += `${icon} ส่วนต่าง: ${result.difference >= 0 ? '+' : ''}${result.difference}\n\n`;
        msg += `💡 ${result.operationText}`;
        
        // ✨ Add contextual help if stock is low
        if (result.newStock <= 10) {
          msg += '\n\n' + getContextualHelp('stock_low');
        }
        
        await replyToLine(replyToken, msg);
        await saveToInbox(userId, text);
      } else {
        await replyToLine(replyToken, result.error);
      }
      return;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 📊 DAILY SUMMARY: "สรุป" or "สรุปวันนี้"
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (lower === 'สรุป' || lower.includes('สรุปวันนี้') || lower === 'summary') {
      const summary = await generateDailySummary();
      await replyToLine(replyToken, summary);
      return;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 📝 INBOX VIEW: "inbox" or "ดูinbox"
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (lower === 'inbox' || lower.includes('ดูinbox')) {
      const inboxSummary = await generateInboxSummary(15);
      await replyToLine(replyToken, inboxSummary);
      return;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // ❓ HELP
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (lower === 'help' || lower === 'ช่วยเหลือ') {
      await replyToLine(replyToken, 
        `🤖 คำสั่งที่ใช้ได้\n` +
        `${'='.repeat(30)}\n\n` +
        `📦 รับออเดอร์:\n` +
        `• กดไมค์พูดสั่งซื้อ (แนะนำ)\n` +
        `• พิมพ์: "น้ำแข็ง 5 ถุง ร้านเจ๊แดง"\n\n` +
        `💰 จัดการการเงิน:\n` +
        `• "จ่าย #123" - อัปเดตการชำระเงิน\n\n` +
        `🚚 จัดการการส่ง:\n` +
        `• "ส่ง #123" - อัปเดตสถานะจัดส่ง\n` +
        `• "ส่ง #123 พี่แดง" - ระบุคนส่ง\n\n` +
        `🔧 จัดการสต็อก:\n` +
        `• "เติมน้ำแข็ง 20" - เพิ่มสต็อก\n` +
        `• "ลดน้ำแข็ง 10" - ลดสต็อก\n` +
        `• "น้ำแข็งเหลือ 50" - ตั้งค่าเป๊ะ\n` +
        `• "สต็อก" - ดูสต็อกทั้งหมด\n\n` +
        `📊 รายงาน:\n` +
        `• "รายงานสต็อก" - ดูการปรับสต็อก\n` +
        `• "สถิติ" - ดู automation stats\n\n` +
        `⚙️ อื่นๆ:\n` +
        `• "ยกเลิก #123" - ยกเลิกออเดอร์\n` +
        `• "รีเฟรช" - โหลดข้อมูลใหม่\n\n` +
        `💡 Tip: ใช้เสียงจะแม่นและเร็วกว่า!`
      );
      return;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 📦 VIEW STOCK
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (lower.includes('สต็อก') && !lower.includes('รายงาน')) {
      const searchTerm = text.replace(/สต็อก|ดู/gi, '').trim();
      const stockList = await viewCurrentStock(searchTerm || null);
      await replyToLine(replyToken, stockList);
      return;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 📊 VARIANCE REPORT
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (lower.includes('รายงานสต็อก')) {
      const report = await generateVarianceReport('today');
      await replyToLine(replyToken, report);
      return;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 🔄 REFRESH CACHE
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (lower === 'รีเฟรช' || lower === 'refresh') {
      await loadStockCache(true);
      await loadCustomerCache(true);
      await replyToLine(replyToken, '✅ รีเฟรชข้อมูลสำเร็จ\n\nโหลดสต็อกและลูกค้าใหม่แล้ว');
      return;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 📦 TRY TO PARSE AS ORDER (for text input)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // If not a command, try parsing as order
    await saveToInbox(userId, text, 'text_input');
    
    const parsed = await parseOrder(text);
    
    if (parsed.success && parsed.items && parsed.items.length > 0) {
      // Successfully parsed as order
      const corrected = applySmartCorrection(parsed);
      
      // Check stock warnings
      const stockCheck = checkStockWarnings(corrected.items);
      
      if (stockCheck.hasCritical) {
        const warningMsg = formatStockWarnings(stockCheck);
        await replyToLine(replyToken, warningMsg);
        await saveToInbox(userId, text, 'insufficient_stock', { 
          items: stockCheck.criticalItems 
        });
        return;
      }
      
      const orderValue = corrected.items.reduce((sum, item) => 
        sum + (item.quantity * item.stockItem.price), 0
      );
      
      const decision = shouldAutoProcess(corrected, orderValue);
      
      if (decision.shouldAuto) {
        // Auto-add customer
        if (corrected.customer && corrected.customer !== 'ไม่ระบุ') {
          await autoAddCustomer(corrected.customer);
        }
        
        const result = await createOrderTransaction({
          customer: corrected.customer,
          items: corrected.items,
          paymentStatus: corrected.paymentStatus || 'unpaid'
        });
        
        if (result.success) {
          await saveToInbox(userId, text, 'order_auto_success', { 
            orderNo: result.orderNo,
            customer: result.customer,
            totalAmount: result.totalAmount
          });
          
          const msg = formatOrderSuccess(
            result.orderNo,
            result.customer,
            result.items,
            result.totalAmount,
            corrected.confidence
          );
          
          if (stockCheck.hasWarnings) {
            const warnings = stockCheck.warnings.map(w => w.message).join('\n');
            await replyToLine(replyToken, msg + '\n\n━━━━━━━━━━━━━━━━━━━━\n' + warnings);
          } else {
            await replyToLine(replyToken, msg);
          }
          
          monitor.recordDecision(decision, result.orderNo);
          
          if (stockCheck.warnings.some(w => w.level === 'critical')) {
            await pushToAdmin(`⚠️ สต็อกเหลือน้อยมาก!\n\n${formatStockWarnings(stockCheck)}`);
          }
          
          Logger.success(`✅ Text order #${result.orderNo} created`);
        } else {
          await saveToInbox(userId, text, 'order_auto_failed', { 
            error: result.error
          });
          
          await replyToLine(replyToken, 
            `❌ ไม่สามารถสร้างออเดอร์ได้\n\n` +
            `${result.error}\n\n` +
            `💡 พิมพ์ "สต็อก" เพื่อดูสต็อกปัจจุบัน`
          );
          Logger.error(`❌ Text order failed: ${result.error}`);
        }
      } else {
        // Manual review mode
        const guess = corrected.items.map(i => 
          `${i.stockItem.item} x${i.quantity}`
        ).join(', ');
        
        await saveToInbox(userId, text, 'pending_review', { 
          summary: guess,
          customer: corrected.customer,
          blockReason: decision.reason
        });
        
        await replyToLine(replyToken, 
          `📝 รับคำสั่งแล้ว (รอตรวจสอบ)\n\n` +
          `"${text}"\n\n` +
          `🤖 ระบบเดา:\n` +
          `• ลูกค้า: ${corrected.customer}\n` +
          `• สินค้า: ${guess}\n` +
          `• ยอดรวม: ${orderValue.toLocaleString()}฿\n\n` +
          `⚠️ เหตุผล: ${decision.reason}\n` +
          `💡 แอดมินจะตรวจสอบและบันทึกให้`
        );
        
        monitor.recordDecision(decision, 'pending');
        Logger.info(`📥 Text order pending review: "${text}"`);
      }
      return;
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // DEFAULT: Unknown command (parse failed)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    await saveToInbox(userId, text, 'unknown_command');
    
    const errorMsg = formatError('parse_failed', { input: text });
    await replyToLine(replyToken, errorMsg);

  } catch (error) {
    Logger.error('Text handler error', error);
    await saveToInbox(userId, text, 'text_error', { error: error.message });
    await replyToLine(replyToken, '❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้ง');
  }
}

// ============================================================================
// VOICE HANDLER - ENHANCED with Stock Warnings
// ============================================================================

async function handleVoiceMessage(messageId, replyToken, userId) {
  try {
    await saveToInbox(userId, '[🎤 Voice Input]', 'voice_raw', { messageId });

    const audioBuffer = await fetchAudioFromLine(messageId);
    const { success, text } = await transcribeAudio(audioBuffer);
    
    if (!success || !text) {
      await saveToInbox(userId, '[ฟังไม่ออก]', 'voice_error');
      await replyToLine(replyToken, '❌ ฟังไม่ออก ลองใหม่หรือพิมพ์ข้อความมา');
      return;
    }

    Logger.info(`📝 Transcribed: "${text}"`);
    await saveToInbox(userId, text, 'voice_transcribed', { 
      transcription: text,
      timestamp: new Date().toISOString()
    });

    // Check for payment command
    const paymentMatch = text.match(/(?:จ่าย(?:เงิน|ตัง|แล้ว)?)\s*#?(\d+)/i);
    if (paymentMatch) {
      await handleTextMessage(text, replyToken, userId);
      return;
    }

    // Check for stock adjustment
    const adjCommand = await parseAdjustmentCommand(text);
    if (adjCommand.isAdjustment) {
      await handleTextMessage(text, replyToken, userId);
      return;
    }

    // Parse as order
    const parsed = await parseOrder(text);
    parsed.rawInput = text;

    if (!parsed.success || !parsed.items || parsed.items.length === 0) {
      await saveToInbox(userId, text, 'parse_failed', { error: parsed.error });
      const errorMsg = formatError('parse_failed', { input: text });
      await replyToLine(replyToken, errorMsg);
      return;
    }

    const corrected = applySmartCorrection(parsed);
    
    // ✨ CHECK STOCK WARNINGS BEFORE PROCESSING
    const stockCheck = checkStockWarnings(corrected.items);
    
    if (stockCheck.hasCritical) {
      const warningMsg = formatStockWarnings(stockCheck);
      await replyToLine(replyToken, warningMsg);
      await saveToInbox(userId, text, 'insufficient_stock', { 
        items: stockCheck.criticalItems 
      });
      return;
    }

    const orderValue = corrected.items.reduce((sum, item) => 
      sum + (item.quantity * item.stockItem.price), 0
    );

    const decision = shouldAutoProcess(corrected, orderValue);

    if (decision.shouldAuto) {
      // Auto-add customer
      if (corrected.customer && corrected.customer !== 'ไม่ระบุ') {
        await autoAddCustomer(corrected.customer);
      }
      
      const result = await createOrderTransaction({
        customer: corrected.customer,
        items: corrected.items,
        paymentStatus: corrected.paymentStatus || 'unpaid'
      });

      if (result.success) {
        await saveToInbox(userId, text, 'order_auto_success', { 
          orderNo: result.orderNo,
          customer: result.customer,
          totalAmount: result.totalAmount
        });

        // ✨ USE ENHANCED SUCCESS MESSAGE
        const msg = formatOrderSuccess(
          result.orderNo,
          result.customer,
          result.items,
          result.totalAmount,
          corrected.confidence
        );
        
        // ✨ ADD STOCK WARNING IF ANY
        if (stockCheck.hasWarnings) {
          const warnings = stockCheck.warnings
            .map(w => w.message)
            .join('\n');
          await replyToLine(replyToken, msg + '\n\n━━━━━━━━━━━━━━━━━━━━\n' + warnings);
        } else {
          await replyToLine(replyToken, msg);
        }

        monitor.recordDecision(decision, result.orderNo);
        
        // ✨ Notify admin if stock is critical
        if (stockCheck.warnings.some(w => w.level === 'critical')) {
          await pushToAdmin(`⚠️ สต็อกเหลือน้อยมาก!\n\n${formatStockWarnings(stockCheck)}`);
        }
        
      } else {
        await saveToInbox(userId, text, 'order_auto_failed', { 
          error: result.error
        });
        
        await replyToLine(replyToken, 
          `❌ ไม่สามารถสร้างออเดอร์ได้\n\n` +
          `${result.error}\n\n` +
          `💡 พิมพ์ "สต็อก" เพื่อดูสต็อกปัจจุบัน`
        );
      }
    } else {
      // Manual review mode
      const guess = corrected.items.map(i => 
        `${i.stockItem.item} x${i.quantity}`
      ).join(', ');

      await saveToInbox(userId, text, 'pending_review', { 
        summary: guess,
        customer: corrected.customer,
        blockReason: decision.reason
      });

      await replyToLine(replyToken, 
        `📝 รับคำสั่งแล้ว (รอตรวจสอบ)\n\n` +
        `"${text}"\n\n` +
        `🤖 ระบบเดา:\n` +
        `• ลูกค้า: ${corrected.customer}\n` +
        `• สินค้า: ${guess}\n` +
        `• ยอดรวม: ${orderValue.toLocaleString()}฿\n\n` +
        `⚠️ เหตุผล: ${decision.reason}\n` +
        `💡 แอดมินจะตรวจสอบและบันทึกให้`
      );

      monitor.recordDecision(decision, 'pending');
    }

  } catch (error) {
    Logger.error('Voice handler error', error);
    await saveToInbox(userId, '[System Error]', 'voice_error', { error: error.message });
    await replyToLine(replyToken, '❌ เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง');
  }
}

// ============================================================================
// WEBHOOK
// ============================================================================

app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      if (event.type !== 'message') continue;

      const userId = event.source.userId;
      const replyToken = event.replyToken;

      if (event.message.type === 'audio') {
        await handleVoiceMessage(event.message.id, replyToken, userId);
      } else if (event.message.type === 'text') {
        await handleTextMessage(event.message.text, replyToken, userId);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    Logger.error('Webhook error', error);
    res.sendStatus(500);
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    mode: 'ux-enhanced',
    timestamp: new Date().toISOString() 
  });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  Logger.info(`🚀 Server running on port ${PORT}`);
  await initializeApp();
});

module.exports = { app, pushToAdmin };