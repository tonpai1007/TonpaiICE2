
const express = require('express');
const { CONFIG, validateConfig } = require('./config');
const { Logger } = require('./logger');

// Validate config early
try {
  validateConfig(); 
} catch (e) {
  Logger.error('Config Validation Failed', e);
  process.exit(1);
}

const { initializeGoogleServices } = require('./googleServices');
const { initializeAIServices } = require('./aiServices');
const { loadStockCache, loadCustomerCache } = require('./cacheManager');
const { getThaiDateTimeString, getThaiDateString } = require('./utils');
const { parseOrder } = require('./orderParser'); // FIX: Add this import
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
// INITIALIZATION
// ============================================================================

async function initializeApp() {
  try {
    Logger.info('🚀 Starting LINE Order Bot...');
    
    // Validate configuration
    validateConfig();
    Logger.success('Configuration validated');
    
    // Initialize services
    initializeGoogleServices();
    initializeAIServices();
    
    // Initialize sheets
    await initializeSheets();
    
    // Load caches
    await loadStockCache(true);
    await loadCustomerCache(true);
    
    Logger.success('✅ System initialized - Ready to process orders! 🎯');
    
  } catch (error) {
    Logger.error('❌ Initialization failed', error);
    process.exit(1);
  }
}

async function initializeSheets() {
  const { getSheetsList, createSheet, updateSheetData } = require('./googleServices');
  
  const existingSheets = await getSheetsList(CONFIG.SHEET_ID);
  
  for (const sheet of REQUIRED_SHEETS) {
    if (!existingSheets.includes(sheet.name)) {
      await createSheet(CONFIG.SHEET_ID, sheet.name);
      await updateSheetData(CONFIG.SHEET_ID, `${sheet.name}!A1`, [sheet.headers]);
      Logger.success(`Created sheet: ${sheet.name}`);
    }
  }
}

// ============================================================================
// MESSAGE HANDLERS
// ============================================================================

async function notifyAdmin(message) {
  if (!CONFIG.ADMIN_USER_ID) {
    Logger.warn('ADMIN_USER_ID not configured - cannot send admin notification');
    return;
  }

  try {
    await pushToLine(CONFIG.ADMIN_USER_ID, message);
  } catch (error) {
    Logger.error('Failed to notify admin', error);
  }
}

async function notifyAdminNewOrder(orderData) {
  const message = `🆕 คำสั่งซื้อใหม่ #${orderData.orderNo}\n` +
    `${'='.repeat(30)}\n\n` +
    `👤 ลูกค้า: ${orderData.customer}\n` +
    `📦 สินค้า: ${orderData.item}\n` +
    `🔢 จำนวน: ${orderData.quantity} ${orderData.unit}\n` +
    `💰 ยอดเงิน: ${orderData.total.toLocaleString()}฿\n` +
    `${orderData.isCredit ? '📖 การชำระ: เครดิต' : '✅ การชำระ: จ่ายแล้ว'}\n` +
    `${orderData.deliveryPerson ? `🚚 ผู้ส่ง: ${orderData.deliveryPerson}\n` : ''}` +
    `📊 สต็อกคงเหลือ: ${orderData.newStock} ${orderData.unit}\n` +
    `👤 สั่งโดย: ${orderData.userId}`;

  await notifyAdmin(message);

  // Check low stock
  if (orderData.newStock < CONFIG.LOW_STOCK_THRESHOLD) {
    await pushLowStockAlert(orderData.item, orderData.newStock, orderData.unit);
  }
}

async function notifyAdminWithVoiceOrder(transcribed, original, result, userId) {
  const message = `🎤 คำสั่งซื้อจากเสียง\n` +
    `${'='.repeat(30)}\n\n` +
    `👤 ผู้ส่ง: ${userId}\n` +
    `🎙️ ข้อความต้นฉบับ: "${original}"\n` +
    `📝 แปลเป็น: "${transcribed}"\n\n` +
    `${result}`;

  await notifyAdmin(message);
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

async function handleTextMessage(text, userId) {
  
  if (!userId) {
    Logger.error('handleTextMessage called without userId');
    return '❌ Error: User identity missing.';
  }

  const lower = text.toLowerCase().replace(/\s+/g, '');
  const isAdmin = AccessControl.isAdmin(userId);

  // ============================================================================
  // 1. USER INFO & SYSTEM COMMANDS
  // ============================================================================
  
  if (lower === 'ข้อมูลของฉัน' || lower === 'whoami' || lower === 'myinfo') {
    return AccessControl.getUserInfoText(userId);
  }

  if (lower === 'รีเฟรช' || lower === 'refresh' || lower === 'โหลดใหม่') {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.REFRESH_CACHE)) {
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.REFRESH_CACHE);
    }
    await loadStockCache(true);
    await loadCustomerCache(true);
    return '✅ รีเฟรชข้อมูลเรียบร้อย\n\n📊 สถานะระบบพร้อมใช้งาน';
  }
  if (lower.includes('ค้างชำระ') || lower.includes('ยังไม่จ่าย') || lower === 'pending') {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.VIEW_PAYMENT_HISTORY)) {
      AccessControl.logAccess(userId, PERMISSIONS.VIEW_PAYMENT_HISTORY, false);
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.VIEW_PAYMENT_HISTORY);
    }
    
    AccessControl.logAccess(userId, PERMISSIONS.VIEW_PAYMENT_HISTORY, true);
    const { getPendingPayments } = require('./orderService');
    const pending = await getPendingPayments();
    
    if (pending.count === 0) {
      return '✅ ไม่มีรายการค้างชำระ';
    }
    
    let message = `💰 รายการค้างชำระ (${pending.count} รายการ)\n${'='.repeat(30)}\n\n`;
    
    pending.orders.forEach(order => {
      const statusIcon = order.paymentStatus === 'เครดิต' ? '📖' : '⏳';
      message += `${statusIcon} #${order.orderNo} - ${order.customer}\n`;
      message += `   ${order.item} x${order.qty}\n`;
      message += `   ${order.total.toLocaleString()}฿ | ${order.paymentStatus}\n\n`;
    });
    
    message += `${'='.repeat(30)}\n`;
    message += `💵 รวมค้างชำระ: ${pending.totalAmount.toLocaleString()}฿\n\n`;
    message += `💡 พิมพ์ "จ่ายแล้ว [เลขคำสั่ง]" เพื่ออัปเดต`;
    
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
    
    let message = `📋 คำสั่งซื้อวันนี้ (${orders.length} รายการ)\n${'='.repeat(30)}\n\n`;
    let totalSales = 0;
    
    orders.forEach(order => {
      message += `#${order.orderNo} - ${order.customer}\n`;
      message += `📦 ${order.item} x${order.qty}\n`;
      message += `💰 ${order.total.toLocaleString()}฿\n\n`;
      totalSales += order.total;
    });
    
    message += `${'='.repeat(30)}\n💵 ยอดขายรวม: ${totalSales.toLocaleString()}฿`;
    
    return message;
  }

  if (lower.includes('dashboard') || lower.includes('สรุป')) {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.VIEW_DASHBOARD)) {
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.VIEW_DASHBOARD);
    }
    return await generateDashboard();
  } if (lower.includes('จ่ายแล้ว') && /\d+/.test(text)) {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.UPDATE_PAYMENT)) {
      AccessControl.logAccess(userId, PERMISSIONS.UPDATE_PAYMENT, false);
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.UPDATE_PAYMENT);
    }
    
    AccessControl.logAccess(userId, PERMISSIONS.UPDATE_PAYMENT, true);
    const orderNo = text.match(/\d+/)[0];
    const result = await updateOrderPaymentStatus(orderNo, 'จ่ายแล้ว');
    
    if (!result.success) {
      return result.error;
    }
    
    return `✅ อัปเดตการชำระเงินสำเร็จ!\n\n` +
      `📋 คำสั่งซื้อ #${result.orderNo}\n` +
      `👤 ลูกค้า: ${result.customer}\n` +
      `📦 สินค้า: ${result.item}\n` +
      `💰 ยอดเงิน: ${result.total}฿\n` +
      `🔄 ${result.oldStatus} → ${result.newStatus}`;
  }
  
  // Mark as credit: "เครดิต 123"
  if (lower.includes('เครดิต') && /\d+/.test(text) && !lower.includes('สั่ง')) {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.UPDATE_PAYMENT)) {
      AccessControl.logAccess(userId, PERMISSIONS.UPDATE_PAYMENT, false);
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.UPDATE_PAYMENT);
    }
    
    AccessControl.logAccess(userId, PERMISSIONS.UPDATE_PAYMENT, true);
    const orderNo = text.match(/\d+/)[0];
    const result = await updateOrderPaymentStatus(orderNo, 'เครดิต');
    
    if (!result.success) {
      return result.error;
    }
    
    return `📖 เปลี่ยนเป็นเครดิตแล้ว!\n\n` +
      `📋 คำสั่งซื้อ #${result.orderNo}\n` +
      `👤 ลูกค้า: ${result.customer}\n` +
      `💰 ยอดเงิน: ${result.total}฿\n` +
      `🔄 ${result.oldStatus} → เครดิต`;
  }
  
  // Mark as unpaid: "ยังไม่จ่าย 123"
  if (lower.includes('ยังไม่จ่าย') && /\d+/.test(text)) {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.UPDATE_PAYMENT)) {
      AccessControl.logAccess(userId, PERMISSIONS.UPDATE_PAYMENT, false);
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.UPDATE_PAYMENT);
    }
    
    AccessControl.logAccess(userId, PERMISSIONS.UPDATE_PAYMENT, true);
    const orderNo = text.match(/\d+/)[0];
    const result = await updateOrderPaymentStatus(orderNo, 'ยังไม่จ่าย');
    
    if (!result.success) {
      return result.error;
    }
    
    return `⏳ เปลี่ยนสถานะแล้ว!\n\n` +
      `📋 คำสั่งซื้อ #${result.orderNo}\n` +
      `👤 ลูกค้า: ${result.customer}\n` +
      `🔄 ${result.oldStatus} → ยังไม่จ่าย`;
  } if ((lower.includes('ส่งแล้ว') || lower.includes('ส่งเสร็จ')) && /\d+/.test(text)) {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.UPDATE_DELIVERY)) {
      AccessControl.logAccess(userId, PERMISSIONS.UPDATE_DELIVERY, false);
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.UPDATE_DELIVERY);
    }
    
    AccessControl.logAccess(userId, PERMISSIONS.UPDATE_DELIVERY, true);
    const orderNo = text.match(/\d+/)[0];
    const result = await updateOrderDeliveryStatus(orderNo, 'ส่งเสร็จแล้ว');
    
    if (!result.success) {
      return result.error;
    }
    
    return `🚚 อัปเดตการจัดส่งสำเร็จ!\n\n` +
      `📋 คำสั่งซื้อ #${result.orderNo}\n` +
      `👤 ลูกค้า: ${result.customer}\n` +
      `📦 สินค้า: ${result.item}\n` +
      `✅ สถานะ: ${result.newStatus}`;
  }

  if (lower === 'help' || lower === 'ช่วยเหลือ' || lower === '?') {
    return getHelpMessage(isAdmin);
  }

  // ============================================================================
  // 2. ORDER PROCESSING
  // ============================================================================
  
  if (!AccessControl.canPerformAction(userId, PERMISSIONS.PLACE_ORDER)) {
    return AccessControl.getAccessDeniedMessage(PERMISSIONS.PLACE_ORDER);
  }

  try {
    // Load cache to ensure RAG has data
    await loadStockCache();
    
    // Parse order using orderParser
    const parsed = await parseOrder(text);

    if (!parsed.success) {
      return parsed.error + (parsed.warning ? '\n\n' + parsed.warning : '');
    }

    // Handle add stock action
    if (parsed.action === 'add_stock') {
      if (!AccessControl.canPerformAction(userId, PERMISSIONS.ADD_STOCK)) {
        return AccessControl.getAccessDeniedMessage(PERMISSIONS.ADD_STOCK);
      }
      
      const newStock = parsed.stockItem.stock + parsed.quantity;
      const updated = await updateStock(parsed.stockItem.item, parsed.stockItem.unit, newStock);
      
      if (!updated) {
        return '❌ ไม่สามารถเพิ่มสต็อกได้ กรุณาลองใหม่';
      }
      
      await loadStockCache(true);
      
      return `✅ เพิ่มสต็อกสำเร็จ!\n` +
             `📦 สินค้า: ${parsed.stockItem.item}\n` +
             `➕ เพิ่ม: ${parsed.quantity} ${parsed.stockItem.unit}\n` +
             `📊 สต็อกใหม่: ${newStock} ${parsed.stockItem.unit}`;
    }

    // Validate stock availability
    if (parsed.quantity > parsed.stockItem.stock) {
      const errorMsg = `⚠️ สต็อกไม่เพียงพอ!\n\n` +
        `📦 สินค้า: ${parsed.stockItem.item}\n` +
        `❌ ต้องการ: ${parsed.quantity} ${parsed.stockItem.unit}\n` +
        `✅ มีอยู่: ${parsed.stockItem.stock} ${parsed.stockItem.unit}`;
      
      if (!isAdmin) {
        await notifyAdmin(`⚠️ สต็อกไม่พอ\n${parsed.customer} ต้องการ ${parsed.stockItem.item} ${parsed.quantity}`);
      }
      
      return errorMsg;
    }

    // Check max quantity
    if (parsed.quantity > CONFIG.MAX_ORDER_QUANTITY) {
      return `❌ จำนวนมากเกินไป!\n\nสั่งได้สูงสุด ${CONFIG.MAX_ORDER_QUANTITY} ${parsed.stockItem.unit}`;
    }

    // Create order
    const isCredit = lower.includes('เครดิต') || lower.includes('ค้าง') || lower.includes('ไว้ก่อน');
    const totalAmount = parsed.quantity * parsed.stockItem.price;

    const result = await createOrder({
      customer: parsed.customer,
      item: parsed.stockItem.item,
      quantity: parsed.quantity,
      deliveryPerson: '',
      isCredit,
      totalAmount
    });

    // Update stock
    const newStock = parsed.stockItem.stock - parsed.quantity;
    const stockUpdated = await updateStock(parsed.stockItem.item, parsed.stockItem.unit, newStock);
    
    if (!stockUpdated) {
      await notifyAdmin(`❌ CRITICAL: Order #${result.orderNo} created but stock update FAILED!\nItem: ${parsed.stockItem.item}`);
      return `⚠️ คำสั่งซื้อสำเร็จ แต่อัปเดตสต็อกล้มเหลว\nกรุณาแจ้งแอดมินตรวจสอบคำสั่งซื้อ #${result.orderNo}`;
    }
    
    await loadStockCache(true);

    // Build response
    let response = isAdmin 
      ? `✅ บันทึกคำสั่งซื้อสำเร็จ!\n`
      : `✅ รับคำสั่งซื้อเรียบร้อยค่ะ!\n`;

    response += `${'='.repeat(30)}\n\n` +
      `📋 คำสั่งซื้อ: #${result.orderNo}\n` +
      `👤 ลูกค้า: ${parsed.customer}\n` +
      `📦 สินค้า: ${parsed.stockItem.item}\n` +
      `🔢 จำนวน: ${parsed.quantity} ${parsed.stockItem.unit}\n` +
      `💰 ราคา: ${parsed.stockItem.price.toLocaleString()}฿/${parsed.stockItem.unit}\n` +
      `💵 ยอดรวม: ${totalAmount.toLocaleString()}฿\n`;

    // Show payment status clearly
    if (isCredit) {
      response += `📖 สถานะ: เครดิต (ค้างชำระ)\n`;
    } else {
      response += `⏳ สถานะ: ยังไม่จ่าย\n`;
      if (isAdmin) {
        response += `💡 พิมพ์ "จ่ายแล้ว ${result.orderNo}" เมื่อได้รับเงิน\n`;
      }
    }
    if (isAdmin) {
      response += `\n📊 สต็อกคงเหลือ: ${newStock} ${parsed.stockItem.unit}`;
      if (newStock < CONFIG.LOW_STOCK_THRESHOLD) {
        response += `\n⚠️ แจ้งเตือน: สต็อกเหลือน้อย!`;
      }
    } else {
      response += `\n\n🙏 ขอบคุณที่สั่งซื้อค่ะ`;
    }

    if (parsed.warning) {
      response += `\n\n${parsed.warning}`;
    }

    // Notify admin
    await notifyAdminNewOrder({
      orderNo: result.orderNo,
      customer: parsed.customer,
      item: parsed.stockItem.item,
      quantity: parsed.quantity,
      unit: parsed.stockItem.unit,
      total: totalAmount,
      isCredit,
      deliveryPerson: '',
      newStock,
      userId: isAdmin ? `${userId.substring(0, 12)}... (ADMIN)` : userId.substring(0, 12) + '...'
    });

    return response;

  } catch (error) {
    Logger.error('Order processing failed', error);
    await notifyAdmin(`❌ Order Error\nUser: ${userId}\nError: ${error.message}\nInput: ${text}`);
    return '❌ เกิดข้อผิดพลาดในการบันทึกคำสั่งซื้อ\nลองใหม่หรือติดต่อแอดมินค่ะ';
  }
}

async function handleVoiceMessage(messageId, replyToken, userId) {
  try {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.PLACE_ORDER)) {
      await replyToLine(replyToken, '🔒 ระบบปิดการรับคำสั่งซื้อชั่วคราว');
      return;
    }
    
    Logger.info('🎤 Processing voice message:', messageId);
    
    const audioBuffer = await fetchAudioFromLine(messageId);
    Logger.info(`📦 Audio size: ${(audioBuffer.length / 1024).toFixed(1)}KB`);

    const voiceResult = await processVoiceMessage(audioBuffer);
    
    if (!voiceResult.success) {
      await replyToLine(replyToken, voiceResult.error);
      await notifyAdmin(`⚠️ Voice transcription failed\nUser: ${userId}\nError: ${voiceResult.error}`);
      return;
    }

    Logger.success(`✅ Voice transcript: "${voiceResult.text}"`);
    
    await replyToLine(replyToken, `🎤 ได้ยิน: "${voiceResult.text}"\n\n⏳ กำลังประมวลผล...`);
    
    const orderResult = await handleTextMessage(voiceResult.text, userId);
    await pushToLine(userId, orderResult);
    
    if (orderResult.includes('✅')) {
      await notifyAdminWithVoiceOrder(voiceResult.text, voiceResult.original, orderResult, userId);
    }

    Logger.success('✅ Voice processing complete');

  } catch (error) {
    Logger.error('❌ handleVoiceMessage error', error);
    
    let errorMsg = '❌ เกิดข้อผิดพลาดค่ะ ';
    
    if (error.message.includes('LINE audio')) {
      errorMsg += 'ไม่สามารถโหลดไฟล์เสียงได้';
    } else if (error.message.includes('quota') || error.message.includes('429')) {
      errorMsg += 'ระบบยุ่ง รอสักครู่แล้วลองใหม่นะคะ';
    } else {
      errorMsg += 'ลองพูดใหม่หรือพิมพ์แทนนะคะ';
    }
    
    await replyToLine(replyToken, errorMsg);
    await notifyAdmin(`❌ Voice Error\nUser: ${userId}\nError: ${error.message}`);
  }
}

// ============================================================================
// LINE API
// ============================================================================

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
  if (!CONFIG.ADMIN_USER_ID) {
    Logger.warn('ADMIN_USER_ID not configured, skipping low stock alert');
    return;
  }

  try {
    const stockCache = require('./cacheManager').getStockCache();
    const allLowStock = stockCache.filter(item => item.stock < CONFIG.LOW_STOCK_THRESHOLD);
    
    let message = `⚠️ แจ้งเตือนสต็อกเหลือน้อย!\n${'='.repeat(30)}\n\n`;
    message += `🔴 เพิ่งหมด:\n• ${itemName}: ${currentStock} ${unit}\n\n`;
    
    if (allLowStock.length > 1) {
      message += `⚠️ สินค้าอื่นที่เหลือน้อย (${allLowStock.length - 1}):\n`;
      allLowStock
        .filter(item => item.item !== itemName)
        .slice(0, 5)
        .forEach(item => {
          message += `• ${item.item}: ${item.stock} ${item.unit}\n`;
        });
    }
    
    message += `\n💡 กรุณาเติมสต็อกโดยเร็ว`;
    
    await pushToLine(CONFIG.ADMIN_USER_ID, message);
    Logger.success('Low stock alert sent to admin');
  } catch (error) {
    Logger.error('Failed to send low stock alert', error);
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
      `• "จ่ายแล้ว [เลขคำสั่ง]" - อัปเดตว่าจ่ายแล้ว\n` +
      `• "เครดิต [เลขคำสั่ง]" - เปลี่ยนเป็นเครดิต\n` +
      `• "ยังไม่จ่าย [เลขคำสั่ง]" - เปลี่ยนเป็นยังไม่จ่าย\n\n` +
      `🚚 การจัดส่ง:\n` +
      `• "ส่งแล้ว [เลขคำสั่ง]" - อัปเดตส่งเสร็จแล้ว\n` +
      `• "กำลังส่ง [เลขคำสั่ง]" - อัปเดตกำลังจัดส่ง\n\n` +
      `🔧 จัดการ:\n` +
      `• "รีเฟรช" - โหลดข้อมูลใหม่\n` +
      `• "เพิ่มสต็อก [สินค้า] [จำนวน]"\n\n` +
      `📦 สั่งซื้อ:\n` +
      `• พิมพ์: "คุณสมชาย สั่งน้ำแข็ง 2 ถุง"\n` +
      `• เสียง: กดไมค์แล้วพูด\n` +
      `• เพิ่ม "เครดิต" สำหรับเครดิต`;
  } else {
    return `🛒 วิธีสั่งซื้อ\n${'='.repeat(30)}\n\n` +
      `📝 พิมพ์ข้อความ:\n` +
      `"[ชื่อลูกค้า] สั่ง [สินค้า] [จำนวน]"\n\n` +
      `ตัวอย่าง:\n` +
      `• "คุณสมชาย สั่งน้ำแข็ง 2 ถุง"\n` +
      `• "พี่ใหญ่ เอาเบียร์ 5 กระป๋อง เครดิต"\n\n` +
      `🎤 หรือส่งข้อความเสียง:\n` +
      `กดไมค์แล้วพูดตามตัวอย่าง\n\n` +
      `💳 การชำระเงิน:\n` +
      `• ปกติ = ยังไม่จ่าย (จ่ายทีหลัง)\n` +
      `• เพิ่ม "เครดิต" = เครดิต`;
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
    totalSales += order.total;
    totalProfit += (order.total - order.cost);
    if (order.paid === 'ยังไม่จ่าย') {
      creditOrders++;
      creditAmount += order.total;
    }
  });
  
  const lowStockItems = stockCache.filter(item => item.stock < CONFIG.LOW_STOCK_THRESHOLD);
  
  let message = `📊 Dashboard วันนี้\n${'='.repeat(30)}\n\n`;
  message += `📈 ยอดขาย\n• คำสั่งซื้อ: ${orders.length} รายการ\n`;
  message += `• ยอดขายรวม: ${totalSales.toLocaleString()}฿\n`;
  message += `• กำไรรวม: ${totalProfit.toLocaleString()}฿\n\n`;
  message += `💳 เครดิต\n• ค้างชำระ: ${creditOrders} รายการ\n`;
  message += `• ยอดเงิน: ${creditAmount.toLocaleString()}฿\n\n`;
  message += `📦 สต็อก\n• สินค้าทั้งหมด: ${stockCache.length} รายการ\n`;
  message += `• ⚠️ สต็อกเหลือน้อย: ${lowStockItems.length} รายการ`;
  
  if (lowStockItems.length > 0) {
    message += `\n\n⚠️ รายการสต็อกเหลือน้อย:\n`;
    lowStockItems.forEach(item => {
      message += `• ${item.item}: ${item.stock} ${item.unit}\n`;
    });
  }
  
  return message;
}

// ============================================================================
// WEBHOOK
// ============================================================================

app.post('/webhook', async (req, res) => {
  try {
    res.status(200).send('OK');
    
    const events = req.body.events || [];
    
    for (const event of events) {
      try {
        if (event.type === 'message') {
          const userId = event.source.userId;
          
          if (event.message.type === 'text') {
            const reply = await handleTextMessage(event.message.text, userId);
            await replyToLine(event.replyToken, reply);
            
          } else if (event.message.type === 'audio') {
            await handleVoiceMessage(event.message.id, event.replyToken, userId);
          }
        }
      } catch (eventError) {
        Logger.error('❌ Event processing error', eventError);
        try {
          await replyToLine(event.replyToken, '❌ เกิดข้อผิดพลาด กรุณาลองใหม่นะคะ');
          await notifyAdmin(`❌ Webhook Error\n${eventError.message}`);
        } catch (replyError) {
          Logger.error('❌ Failed to send error reply', replyError);
        }
      }
    }
    
  } catch (webhookError) {
    Logger.error('❌ Webhook error', webhookError);
    res.status(200).send('OK');
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/health', (req, res) => {
  const { stockVectorStore, customerVectorStore } = require('./vectorStore');
  const { getStockCache, getCustomerCache } = require('./cacheManager');
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    caches: {
      stock: {
        size: getStockCache().length,
        ragVectors: stockVectorStore.size()
      },
      customer: {
        size: getCustomerCache().length,
        ragVectors: customerVectorStore.size()
      }
    },
    services: {
      gemini: !!require('./aiServices').getGemini(),
      assemblyAI: !!require('./aiServices').getAssembly(),
      googleSheets: true
    }
  });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  Logger.info(`🚀 LINE Order Bot running on port ${PORT}`);
  Logger.info(`⏰ Current Bangkok time: ${getThaiDateTimeString()}`);
  
  await initializeApp();
});

module.exports = app;