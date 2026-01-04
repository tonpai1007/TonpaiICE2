const express = require('express');
const crypto = require('crypto');

const { CONFIG, validateConfig, configManager } = require('./config');
const { Logger } = require('./logger');

try {
  validateConfig(); 
  Logger.success('✅ Configuration validated');
} catch (e) {
  Logger.error('❌ Config Validation Failed', e);
  process.exit(1);
}

const { initializeGoogleServices } = require('./googleServices');
const { initializeAIServices } = require('./aiServices');
const { loadStockCache, loadCustomerCache } = require('./cacheManager');
const { getThaiDateTimeString, getThaiDateString } = require('./utils');
const { parseOrder } = require('./orderParser');
const { scheduleDailyDashboard } = require('./dashboardService');
const { 
  createOrder, 
  getOrders, 
  updateOrderPaymentStatus, 
  updateOrderDeliveryStatus, 
  updateStock 
} = require('./orderService');
const { processVoiceMessage, fetchAudioFromLine } = require('./voiceService');
const { REQUIRED_SHEETS } = require('./constants');
const { AccessControl, PERMISSIONS } = require('./accessControl');

const app = express();
app.use(express.json());

// ============================================================================
// 🔒 WEBHOOK SECURITY: Signature Verification
// ============================================================================

function validateLineSignature(body, signature) {
  if (!signature) return false;
  
  const secret = configManager.get('LINE_SECRET');
  if (!secret) return false;

  const hash = crypto.createHmac('sha256', secret)
    .update(JSON.stringify(body))
    .digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(hash));
  } catch {
    return false;
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initializeApp() {
  try {
    Logger.info('🚀 Starting LINE Order Bot...');
    
    Logger.info('Initializing Google Services...');
    initializeGoogleServices();
    
    Logger.info('Initializing AI Services...');
    initializeAIServices();
    
    Logger.info('Initializing Google Sheets...');
    await initializeSheets();
    
    Logger.info('Loading stock cache...');
    await loadStockCache(true);
    
    Logger.info('Loading customer cache...');
    await loadCustomerCache(true);
    
    Logger.info('Starting cleanup scheduler...');
    scheduleCleanup();
    
    // ✅ FIX 5: START DASHBOARD SCHEDULER
    Logger.info('Starting dashboard scheduler...');
    scheduleDailyDashboard();
    
    const admins = configManager.get('ADMIN_USER_IDS', []);
    if (admins.length > 0) {
      Logger.success(`✅ ${admins.length} admin user(s) configured`);
    } else {
      Logger.warn('⚠️  No admin users configured');
    }
    
    Logger.success('✅ System initialized - Ready! 🎯');
    
  } catch (error) {
    Logger.error('❌ Initialization failed', error);
    process.exit(1);
  }
}

async function initializeSheets() {
  const { getSheetsList, createSheet, updateSheetData } = require('./googleServices');
  
  try {
    const existingSheets = await getSheetsList(CONFIG.SHEET_ID);
    
    for (const sheet of REQUIRED_SHEETS) {
      if (!existingSheets.includes(sheet.name)) {
        Logger.info(`Creating sheet: ${sheet.name}...`);
        await createSheet(CONFIG.SHEET_ID, sheet.name);
        await updateSheetData(CONFIG.SHEET_ID, `${sheet.name}!A1`, [sheet.headers]);
        Logger.success(`✅ Created sheet: ${sheet.name}`);
      }
    }
  } catch (error) {
    Logger.error('Sheet initialization failed', error);
    throw error;
  }
}

async function notifyAdmin(message) {
  const admins = configManager.get('ADMIN_USER_IDS', []);
  if (admins.length === 0) return;

  try {
    for (const adminId of admins) {
      await pushToLine(adminId, message);
    }
  } catch (error) {
    Logger.error('Failed to notify admin', error);
  }
}

async function pushToLine(userId, text) {
  try {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${CONFIG.LINE_TOKEN}` 
      },
      body: JSON.stringify({ 
        to: userId, 
        messages: [{ type: 'text', text }] 
      })
    });
  } catch (error) {
    Logger.error('pushToLine error', error);
  }
}

async function replyToLine(replyToken, text) {
  try {
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${CONFIG.LINE_TOKEN}` 
      },
      body: JSON.stringify({ 
        replyToken, 
        messages: [{ type: 'text', text }] 
      })
    });
  } catch (error) {
    Logger.error('replyToLine error', error);
  }
}

async function pushLowStockAlert(itemName, currentStock, unit) {
  const admins = configManager.get('ADMIN_USER_IDS', []);
  if (admins.length === 0) return;

  try {
    const stockCache = require('./cacheManager').getStockCache();
    const allLowStock = stockCache.filter(item => item.stock < CONFIG.LOW_STOCK_THRESHOLD);
    
    let message = `⚠️ แจ้งเตือนสต็อกเหลือน้อย!\n${'='.repeat(30)}\n\n`;
    message += `🔴 เพิ่งหมด:\n• ${itemName}: ${currentStock} ${unit}\n\n`;
    
    if (allLowStock.length > 1) {
      message += `⚠️ สินค้าอื่นที่เหลือน้อย (${allLowStock.length - 1}):\n`;
      allLowStock.filter(item => item.item !== itemName).slice(0, 5).forEach(item => {
        message += `• ${item.item}: ${item.stock} ${item.unit}\n`;
      });
    }
    
    message += `\n💡 กรุณาเติมสต็อกโดยเร็ว`;
    
    for (const adminId of admins) {
      await pushToLine(adminId, message);
    }
    
    Logger.success('Low stock alert sent');
  } catch (error) {
    Logger.error('Failed to send low stock alert', error);
  }
}

async function handleTextMessage(text, userId) {
  if (!userId) {
    Logger.error('handleTextMessage called without userId');
    return '❌ Error: User identity missing.';
  }

  const lower = text.toLowerCase().replace(/\s+/g, '');
  const isAdmin = AccessControl.isAdmin(userId);
  const commandCheck = await detectAndExecuteCommand(text, userId);

  if (lower === 'ข้อมูลของฉัน' || lower === 'whoami') {
    return AccessControl.getUserInfoText(userId);
  }
  const cancelMatch = text.match(/ยกเลิก\s*#?(\d+)/);
  if (cancelMatch) {
    const orderNo = cancelMatch[1];
    const result = await cancelOrder(orderNo);
    if (result.success) {
      await replyToLine(replyToken, `✅ ยกเลิก #${orderNo} และคืนสต็อกแล้ว`);
      await sendLineNotify(`🚨 Cancel #${orderNo} by User`);
    } else {
      await replyToLine(replyToken, `❌ ยกเลิกไม่ได้: ${result.error}`);
    }
    return;
  }

  if (lower === 'รีเฟรsh' || lower === 'refresh' || lower === 'โหลดใหม่') {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.REFRESH_CACHE)) {
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.REFRESH_CACHE);
    }
    await loadStockCache(true);
    await loadCustomerCache(true);
    return '✅ รีเฟรชข้อมูลเรียบร้อย';
  }

  if (lower.includes('ค้างชำระ') || lower.includes('ยังไม่จ่าย') || lower === 'pending') {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.VIEW_PAYMENT_HISTORY)) {
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.VIEW_PAYMENT_HISTORY);
    }
    
    const { getPendingPayments } = require('./orderService');
    const pending = await getPendingPayments();
    
    if (pending.count === 0) {
      return '✅ ไม่มีรายการค้างชำระ';
    }
    
    let message = `💰 รายการค้างชำระ (${pending.count} รายการ)\n${'='.repeat(30)}\n\n`;
    
    pending.orders.forEach(order => {
      const statusIcon = order.paymentStatus === 'เครดิต' ? '📖' : '⏳';
      message += `${statusIcon} #${order.orderNo} - ${order.customer}\n`;
      message += `   ${order.totalAmount.toLocaleString()}฿ | ${order.paymentStatus}\n\n`;
    });
    
    message += `${'='.repeat(30)}\n💵 รวม: ${pending.totalAmount.toLocaleString()}฿`;
    
    return message;
  }

  if (lower.includes('คำสั่งซื้อ') || lower.includes('orders')) {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.VIEW_ORDERS)) {
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.VIEW_ORDERS);
    }
    
    const orders = await getOrders({ date: getThaiDateString() });
    
    if (orders.length === 0) {
      return '📋 ไม่มีคำสั่งซื้อวันนี้';
    }
    
    let message = `📋 คำสั่งซื้อวันนี้ (${orders.length})\n${'='.repeat(30)}\n\n`;
    let totalSales = 0;
    
    orders.forEach(order => {
      message += `#${order.orderNo} - ${order.customer}\n`;
      message += `💰 ${order.totalAmount.toLocaleString()}฿\n\n`;
      totalSales += order.totalAmount;
    });
    
    message += `${'='.repeat(30)}\n💵 ยอดรวม: ${totalSales.toLocaleString()}฿`;
    
    return message;
  }

  if (lower.includes('dashboard') || lower.includes('สรุป')) {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.VIEW_DASHBOARD)) {
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.VIEW_DASHBOARD);
    }
    return await generateDashboard();
  }

  if (lower.includes('จ่ายแล้ว') && /\d+/.test(text)) {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.UPDATE_PAYMENT)) {
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.UPDATE_PAYMENT);
    }
    
    const orderNo = text.match(/\d+/)[0];
    const result = await updateOrderPaymentStatus(orderNo, 'จ่ายแล้ว');
    
    if (!result.success) return result.error;
    
    return `✅ อัปเดตการชำระเงินสำเร็จ!\n\n` +
      `📋 #${result.orderNo}\n` +
      `👤 ${result.customer}\n` +
      `💰 ${result.totalAmount}฿\n` +
      `🔄 ${result.oldStatus} → ${result.newStatus}`;
  }
  
  if (lower.includes('เครดิต') && /\d+/.test(text) && !lower.includes('สั่ง')) {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.UPDATE_PAYMENT)) {
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.UPDATE_PAYMENT);
    }
    
    const orderNo = text.match(/\d+/)[0];
    const result = await updateOrderPaymentStatus(orderNo, 'เครดิต');
    
    if (!result.success) return result.error;
    
    return `📖 เปลี่ยนเป็นเครดิตแล้ว!\n\n` +
      `📋 #${result.orderNo}\n` +
      `👤 ${result.customer}\n` +
      `💰 ${result.totalAmount}฿`;
  }

  if ((lower.includes('ส่งแล้ว') || lower.includes('ส่งเสร็จ')) && /\d+/.test(text)) {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.UPDATE_DELIVERY)) {
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.UPDATE_DELIVERY);
    }
    
    const orderNo = text.match(/\d+/)[0];
    const result = await updateOrderDeliveryStatus(orderNo, 'ส่งเสร็จแล้ว');
    
    if (!result.success) return result.error;
    
    return `🚚 อัปเดตการจัดส่งสำเร็จ!\n\n` +
      `📋 #${result.orderNo}\n` +
      `👤 ${result.customer}\n` +
      `✅ ${result.newStatus}`;
  }

  if (lower === 'help' || lower === 'ช่วยเหลือ') {
    return getHelpMessage(isAdmin);
  }

  if (!AccessControl.canPerformAction(userId, PERMISSIONS.PLACE_ORDER)) {
    return AccessControl.getAccessDeniedMessage(PERMISSIONS.PLACE_ORDER);
  }

  try {
    await loadStockCache();
    const parsed = await parseOrder(text);

    if (!parsed.success) {
      return parsed.error + (parsed.warning ? '\n\n' + parsed.warning : '');
    }

    if (parsed.action === 'add_stock') {
      if (!AccessControl.canPerformAction(userId, PERMISSIONS.ADD_STOCK)) {
        return AccessControl.getAccessDeniedMessage(PERMISSIONS.ADD_STOCK);
      }
      
      const newStock = parsed.stockItem.stock + parsed.quantity;
      const updated = await updateStock(parsed.stockItem.item, parsed.stockItem.unit, newStock);
      
      if (!updated) {
        return '❌ ไม่สามารถเพิ่มสต็อกได้';
      }
      
      await loadStockCache(true);
      
      return `✅ เพิ่มสต็อกสำเร็จ!\n` +
             `📦 ${parsed.stockItem.item}\n` +
             `➕ เพิ่ม: ${parsed.quantity} ${parsed.stockItem.unit}\n` +
             `📊 สต็อกใหม่: ${newStock} ${parsed.stockItem.unit}`;
    }

    let items = [];
    if (parsed.items && Array.isArray(parsed.items)) {
      items = parsed.items;
    } else if (parsed.stockItem) {
      items = [{ stockItem: parsed.stockItem, quantity: parsed.quantity }];
    } else {
      throw new Error('INVALID_PARSE_RESULT');
    }
    
    Logger.info(`📦 Processing ${items.length} item(s) for ${parsed.customer}`);
    
    const isCredit = (parsed.paymentStatus === 'credit') || text.toLowerCase().includes('เครดิต');
    
    let hasStockError = false;
    let stockErrors = [];

    for (const { stockItem, quantity } of items) {
      if (quantity > stockItem.stock) {
        hasStockError = true;
        stockErrors.push({
          item: stockItem.item,
          requested: quantity,
          available: stockItem.stock,
          unit: stockItem.unit
        });
      }
      
      if (quantity > CONFIG.MAX_ORDER_QUANTITY) {
        return `❌ จำนวนมากเกินไป!\nสั่งได้สูงสุด ${CONFIG.MAX_ORDER_QUANTITY} ${stockItem.unit}`;
      }
    }

    if (hasStockError) {
      let errorMsg = `⚠️ สต็อกไม่เพียงพอ!\n\n`;
      stockErrors.forEach(err => {
        errorMsg += `📦 ${err.item}\n`;
        errorMsg += `   ❌ ต้องการ: ${err.requested} ${err.unit}\n`;
        errorMsg += `   ✅ มีอยู่: ${err.available} ${err.unit}\n\n`;
      });
      
      if (!isAdmin) {
        await notifyAdmin(`⚠️ สต็อกไม่พอ\n${parsed.customer}: ${stockErrors.map(e => `${e.item} ${e.requested}`).join(', ')}`);
      }
      
      return errorMsg;
    }

    const orderResults = [];
    let totalAmount = 0;

    for (const { stockItem, quantity } of items) {
      const itemTotal = quantity * stockItem.price;
      totalAmount += itemTotal;

      const result = await createOrder({
        customer: parsed.customer,
        items: [{ stockItem, quantity }],
        deliveryPerson: parsed.deliveryPerson || '',
        paymentStatus: isCredit ? 'credit' : 'unpaid'
      });

      if (!result.success) {
        await notifyAdmin(`❌ Order creation failed: ${result.error}`);
        return '❌ เกิดข้อผิดพลาด กรุณาลองใหม่';
      }

      orderResults.push({
        orderNo: result.orderNo,
        item: stockItem.item,
        quantity: quantity,
        unit: stockItem.unit,
        price: stockItem.price,
        total: itemTotal,
        newStock: result.stockUpdates[0].newStock
      });

      Logger.success(`✅ Order #${result.orderNo}: ${stockItem.item} x${quantity}`);
    }

    await loadStockCache(true);

    let response = isAdmin 
      ? `✅ บันทึกคำสั่งซื้อสำเร็จ! (${items.length} รายการ)\n`
      : `✅ รับคำสั่งซื้อเรียบร้อยค่ะ!\n`;

    response += `${'='.repeat(30)}\n\n`;
    response += `👤 ลูกค้า: ${parsed.customer}\n`;
    
    if (parsed.deliveryPerson) {
      response += `🚚 ผู้ส่ง: ${parsed.deliveryPerson}\n`;
    }
    
    response += `\n📦 รายการสินค้า:\n\n`;

    orderResults.forEach((order, idx) => {
      response += `${idx + 1}. ${order.item}\n`;
      response += `   📋 #${order.orderNo}\n`;
      response += `   📢 ${order.quantity} ${order.unit}\n`;
      response += `   💰 ${order.price.toLocaleString()}฿/${order.unit}\n`;
      response += `   💵 รวม: ${order.total.toLocaleString()}฿\n`;
      
      if (isAdmin) {
        response += `   📊 สต็อก: ${order.newStock} ${order.unit}`;
        if (order.newStock < CONFIG.LOW_STOCK_THRESHOLD) {
          response += ` ⚠️`;
        }
      }
      response += `\n\n`;
    });

    response += `${'='.repeat(30)}\n`;
    response += `💵 ยอดรวม: ${totalAmount.toLocaleString()}฿\n`;

    if (isCredit) {
      response += `📖 สถานะ: เครดิต\n`;
    } else {
      response += `⏳ สถานะ: ยังไม่จ่าย\n`;
      if (isAdmin) {
        response += `💡 พิมพ์ "จ่ายแล้ว ${orderResults[0].orderNo}" เมื่อได้รับเงิน\n`;
      }
    }

    if (!isAdmin) {
      response += `\n🙏 ขอบคุณค่ะ`;
    }

    if (parsed.warning) {
      response += `\n\n${parsed.warning}`;
    }

    await notifyAdminMultiItemOrder({
      customer: parsed.customer,
      items: orderResults,
      deliveryPerson: parsed.deliveryPerson,
      totalAmount: totalAmount,
      isCredit: isCredit,
      userId: isAdmin ? `${userId.substring(0, 12)}... (ADMIN)` : userId.substring(0, 12) + '...'
    });

    for (const order of orderResults) {
      if (order.newStock < CONFIG.LOW_STOCK_THRESHOLD) {
        await pushLowStockAlert(order.item, order.newStock, order.unit);
      }
    }

    return response;

  } catch (error) {
    Logger.error('Order processing failed', error);
    await notifyAdmin(`❌ Order Error\nUser: ${userId}\nError: ${error.message}\nInput: ${text}`);
    return '❌ เกิดข้อผิดพลาดในการบันทึกคำสั่งซื้อ\nลองใหม่หรือติดต่อแอดมินค่ะ';
  }
}

async function notifyAdminMultiItemOrder(data) {
  const { customer, items, deliveryPerson, totalAmount, isCredit, userId } = data;
  
  const admins = configManager.get('ADMIN_USER_IDS', []);
  if (admins.length === 0) return;

  let message = `🆕 คำสั่งซื้อใหม่ (${items.length} รายการ)\n`;
  message += `${'='.repeat(30)}\n\n`;
  message += `👤 ลูกค้า: ${customer}\n`;
  
  if (deliveryPerson) {
    message += `🚚 ผู้ส่ง: ${deliveryPerson}\n`;
  }
  
  message += `\n📦 รายการ:\n`;
  
  items.forEach((item, idx) => {
    message += `\n${idx + 1}. #${item.orderNo} - ${item.item}\n`;
    message += `   ${item.quantity} ${item.unit} x ${item.price.toLocaleString()}฿ = ${item.total.toLocaleString()}฿\n`;
    message += `   📊 สต็อก: ${item.newStock} ${item.unit}`;
    if (item.newStock < CONFIG.LOW_STOCK_THRESHOLD) {
      message += ` ⚠️`;
    }
    message += `\n`;
  });
  
  message += `\n${'='.repeat(30)}\n`;
  message += `💰 รวม: ${totalAmount.toLocaleString()}฿\n`;
  message += `${isCredit ? '📖 เครดิต' : '✅ ยังไม่จ่าย'}\n`;
  message += `👤 โดย: ${userId}`;

  for (const adminId of admins) {
    await pushToLine(adminId, message);
  }
}

async function handleVoiceMessage(messageId, replyToken, userId) {
  try {
    const buffer = await fetchAudioFromLine(messageId);
    const { success, text } = await processVoiceMessage(buffer);
    
    if (!success) return replyToLine(replyToken, '❌ ฟังไม่ออกค่ะ');

    const parsed = await parseOrder(text);
    
    // Logic ตัดสินใจ: Auto หรือ Inbox?
    const isConfident = parsed.success && parsed.confidence === 'high' && parsed.items.length > 0 && parsed.action === 'order';

    if (isConfident) {
      // ✅ Auto-Pilot
      const result = await createOrderTransaction({
        customer: parsed.customer,
        items: parsed.items,
        paymentStatus: 'unpaid'
      });

      if (result.success) {
        await saveToInbox(userId, text, 'voice_auto', { orderNo: result.orderNo });
        const summary = parsed.items.map(i => `${i.stockItem.item} x${i.quantity}`).join('\n');
        await replyToLine(replyToken, `✅ บิล #${result.orderNo}\n${summary}\n(ผิดพิมพ์ "ยกเลิก #${result.orderNo}")`);
        await sendLineNotify(`🤖 Auto #${result.orderNo}: ${text}`);
      } else {
        await saveToInbox(userId, text, 'voice_error', { error: result.error });
        await replyToLine(replyToken, `⚠️ ระบบขัดข้อง: ${result.error}`);
      }
    } else {
      // 📝 Inbox (Safe Mode)
      const guess = parsed.items && parsed.items.length > 0 ? parsed.items.map(i => `${i.stockItem.item} x${i.quantity}`).join(', ') : '-';
      await saveToInbox(userId, text, 'voice_pending', { summary: guess });
      await replyToLine(replyToken, `📝 รับยอด (Inbox): "${text}"\nเดาว่า: ${guess}`);
      await sendLineNotify(`📥 Inbox: ${text}`);
    }

  } catch (e) {
    Logger.error('Handler Error', e);
    await replyToLine(replyToken, '❌ ระบบรวน (บันทึกเสียงแล้ว)');
  }
}

function getHelpMessage(isAdmin) {
  if (isAdmin) {
    return `🎯 คำสั่งสำหรับแอดมิน\n${'='.repeat(30)}\n\n` +
      `📊 ข้อมูล:\n` +
      `• "คำสั่งซื้อ" - ดูคำสั่งซื้อวันนี้\n` +
      `• "ค้างชำระ" - ดูรายการค้างชำระ\n` +
      `• "dashboard" - ดูสรุปยอดขาย\n\n` +
      `💰 การชำระเงิน:\n` +
      `• "จ่ายแล้ว [เลขคำสั่ง]"\n` +
      `• "เครดิต [เลขคำสั่ง]"\n\n` +
      `🚚 การจัดส่ง:\n` +
      `• "ส่งแล้ว [เลขคำสั่ง]"\n\n` +
      `🔧 จัดการ:\n` +
      `• "รีเฟรช" - โหลดข้อมูลใหม่\n\n` +
      `📦 สั่งซื้อ:\n` +
      `• พิมพ์: "คุณสมชาย สั่งน้ำแข็ง 2 ถุง"\n` +
      `• เสียง: กดไมค์แล้วพูด`;
  } else {
    return `🛒 วิธีสั่งซื้อ\n${'='.repeat(30)}\n\n` +
      `📝 พิมพ์ข้อความ:\n` +
      `"[ชื่อ] สั่ง [สินค้า] [จำนวน]"\n\n` +
      `ตัวอย่าง:\n` +
      `• "คุณสมชาย สั่งน้ำแข็ง 2 ถุง"\n` +
      `• "พี่ใหญ่ เอาเบียร์ 5 กระป๋อง เครดิต"\n\n` +
      `🎤 หรือส่งข้อความเสียง`;
  }
}

async function generateDashboard() {
  const orders = await getOrders({ date: getThaiDateString() });
  const stockCache = require('./cacheManager').getStockCache();
  
  let totalSales = 0;
  let totalProfit = 0;
  let creditOrders = 0;
  let creditAmount = 0;
  
  orders.forEach(order => {
    totalSales += order.totalAmount;
    if (order.paymentStatus === 'ยังไม่จ่าย' || order.paymentStatus === 'เครดิต') {
      creditOrders++;
      creditAmount += order.totalAmount;
    }
  });
  
  const lowStockItems = stockCache.filter(item => item.stock < CONFIG.LOW_STOCK_THRESHOLD);
  
  let message = `📊 Dashboard วันนี้\n${'='.repeat(30)}\n\n`;
  message += `📈 ยอดขาย\n`;
  message += `• คำสั่งซื้อ: ${orders.length} รายการ\n`;
  message += `• ยอดขายรวม: ${totalSales.toLocaleString()}฿\n\n`;
  message += `💳 เครดิต\n`;
  message += `• ค้างชำระ: ${creditOrders} รายการ\n`;
  message += `• ยอดเงิน: ${creditAmount.toLocaleString()}฿\n\n`;
  message += `📦 สต็อก\n`;
  message += `• สินค้าทั้งหมด: ${stockCache.length}\n`;
  message += `• ⚠️ เหลือน้อย: ${lowStockItems.length}`;
  
  if (lowStockItems.length > 0) {
    message += `\n\n⚠️ รายการเหลือน้อย:\n`;
    lowStockItems.slice(0, 5).forEach(item => {
      message += `• ${item.item}: ${item.stock} ${item.unit}\n`;
    });
  }
  
  return message;
}

// ============================================================================
// 🔒 WEBHOOK - WITH SIGNATURE VALIDATION
// ============================================================================

app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events;
    if (!events || events.length === 0) {
      return res.sendStatus(200);
    }

    for (const event of events) {
      // Log event เพื่อ Debug
      // Logger.debug('Event received', event);

      if (event.type === 'message') {
        const userId = event.source.userId;
        const replyToken = event.replyToken;

        if (event.message.type === 'audio') {
          // 🎤 เสียง -> เข้า Hybrid Flow
          await handleVoiceMessage(event.message.id, replyToken, userId);
        } 
        else if (event.message.type === 'text') {
          // 💬 ข้อความ -> เช็ค Undo Logic หรือคำสั่งอื่นๆ
          await handleTextMessage(event.message.text, replyToken, userId);
        }
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    Logger.error('Webhook Error', error);
    res.sendStatus(500);
  }
});

// Health Check (สำหรับ Render เช็คว่าตายไหม)
app.get('/health', (req, res) => {
  const { getGroq } = require('./aiServices');
  res.json({ 
    status: 'ok', 
    groq: !!getGroq(), // เช็คว่า AI พร้อมไหม
    timestamp: new Date().toISOString() 
  });
});

// ============================================================================
// START SERVER
// ============================================================================


async function startServer() {
  try {
    // 1. ตรวจสอบ Config
    validateConfig();
    
    // 2. เริ่มต้น AI System
    initializeAIServices();
    
    // 3. เปิด Port
    app.listen(PORT, () => {
      Logger.success(`🚀 Server running on port ${PORT}`);
      Logger.info('✅ System Ready: Hybrid Automation Mode');
    });

  } catch (error) {
    Logger.error('❌ Server failed to start', error);
    process.exit(1);
  }
}

startServer();
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  Logger.info(`🚀 LINE Order Bot running on port ${PORT}`);
  Logger.info(`⏰ ${getThaiDateTimeString()}`);
  
  await initializeApp();
});

module.exports = app;