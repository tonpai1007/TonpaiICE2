// app.js - Main application entry point


const express = require('express');
const { CONFIG, validateConfig } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { initializeGoogleServices } = require('./googleServices');
const { initializeAIServices } = require('./aiServices');
const { loadStockCache, loadCustomerCache } = require('./cacheManager');
const { parseOrder } = require('./orderParser');
const { createOrder, updateOrderPaymentStatus, updateOrderDeliveryStatus, updateStock } = require('./orderService');
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
  if (!CONFIG.ADMIN_LINE_ID) {
    Logger.warn('ADMIN_LINE_ID not configured');
    return;
  }

  try {
    await pushToLine(CONFIG.ADMIN_LINE_ID, message);
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
  const lower = text.toLowerCase().replace(/\s+/g, '');
  const isAdmin = AccessControl.isAdmin(userId);

  // ============================================================================
  // USER MANAGEMENT COMMANDS (ADMIN ONLY)
  // ============================================================================
  
  // View user info
  if (lower === 'ข้อมูลของฉัน' || lower === 'myinfo' || lower === 'whoami') {
    return AccessControl.getUserInfoText(userId);
  }

  // List all users (ADMIN ONLY)
  if (lower === 'ผู้ใช้ทั้งหมด' || lower === 'listusers') {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.MANAGE_USERS)) {
      AccessControl.logAccess(userId, PERMISSIONS.MANAGE_USERS, false);
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.MANAGE_USERS);
    }
    
    AccessControl.logAccess(userId, PERMISSIONS.MANAGE_USERS, true);
    const users = AccessControl.getAllUsers();
    
    let message = `👥 รายชื่อผู้ใช้ (${users.length} คน)\n${'='.repeat(30)}\n\n`;
    users.forEach(user => {
      const roleIcon = user.role === 'admin' ? '👑' : '👤';
      message += `${roleIcon} ${user.name}\n`;
      message += `   ID: ${user.userId.substring(0, 12)}...\n`;
      message += `   บทบาท: ${user.role}\n\n`;
    });
    
    return message;
  }

  // System stats (ADMIN ONLY)
  if (lower.includes('สถิติ') || lower === 'stats' || lower === 'systemstats') {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.VIEW_DASHBOARD)) {
      AccessControl.logAccess(userId, PERMISSIONS.VIEW_DASHBOARD, false);
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.VIEW_DASHBOARD);
    }
    
    AccessControl.logAccess(userId, PERMISSIONS.VIEW_DASHBOARD, true);
    return AccessControl.getSystemStats();
  }

  // ============================================================================
  // ADMIN-ONLY COMMANDS
  // ============================================================================
  
  // Refresh cache (ADMIN ONLY)
  if (lower === 'รีเฟรช' || lower === 'โหลดใหม่' || lower === 'refresh') {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.REFRESH_CACHE)) {
      AccessControl.logAccess(userId, PERMISSIONS.REFRESH_CACHE, false);
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.REFRESH_CACHE);
    }
    
    AccessControl.logAccess(userId, PERMISSIONS.REFRESH_CACHE, true);
    await loadStockCache(true);
    await loadCustomerCache(true);
    return '✅ รีเฟรชข้อมูลเรียบร้อย\n\n📊 สถานะระบบพร้อมใช้งาน';
  }

  // View orders (ADMIN ONLY)
  if (lower.includes('ดูคำสั่งซื้อ') || lower.includes('orders') || lower.includes('คำสั่ง')) {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.VIEW_ORDERS)) {
      AccessControl.logAccess(userId, PERMISSIONS.VIEW_ORDERS, false);
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.VIEW_ORDERS);
    }
    
    AccessControl.logAccess(userId, PERMISSIONS.VIEW_ORDERS, true);
    const orders = await getOrders({ date: getThaiDateString() });
    
    if (orders.length === 0) {
      return '📋 ไม่มีคำสั่งซื้อวันนี้';
    }
    
    let message = `📋 คำสั่งซื้อวันนี้ (${orders.length} รายการ)\n${'='.repeat(30)}\n\n`;
    
    let totalSales = 0;
    let totalProfit = 0;
    
    orders.forEach(order => {
      message += `#${order.orderNo} - ${order.customer}\n`;
      message += `📦 ${order.item} x${order.qty}\n`;
      message += `💰 ${order.total.toLocaleString()}฿ | ${order.paid}\n\n`;
      totalSales += order.total;
      totalProfit += (order.total - order.cost);
    });
    
    message += `${'='.repeat(30)}\n`;
    message += `💵 ยอดขายรวม: ${totalSales.toLocaleString()}฿\n`;
    message += `💎 กำไรรวม: ${totalProfit.toLocaleString()}฿`;
    
    return message;
  }

  // Dashboard (ADMIN ONLY)
  if (lower.includes('dashboard') || lower.includes('สรุป') || lower.includes('รายงาน')) {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.VIEW_DASHBOARD)) {
      AccessControl.logAccess(userId, PERMISSIONS.VIEW_DASHBOARD, false);
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.VIEW_DASHBOARD);
    }
    
    AccessControl.logAccess(userId, PERMISSIONS.VIEW_DASHBOARD, true);
    return await generateDashboard();
  }

  // Update payment status (ADMIN ONLY)
  if (lower.includes('จ่ายแล้ว') && /\d+/.test(text)) {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.UPDATE_PAYMENT)) {
      AccessControl.logAccess(userId, PERMISSIONS.UPDATE_PAYMENT, false);
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.UPDATE_PAYMENT);
    }
    
    AccessControl.logAccess(userId, PERMISSIONS.UPDATE_PAYMENT, true);
    const orderNo = text.match(/\d+/)[0];
    const result = await updateOrderPaymentStatus(orderNo);
    
    if (!result.success) {
      return result.error;
    }
    
    return `✅ อัปเดตการชำระเงินสำเร็จ!\n\n` +
      `คำสั่งซื้อ #${result.orderNo}\n` +
      `ลูกค้า: ${result.customer}\n` +
      `สินค้า: ${result.item}\n` +
      `ยอดเงิน: ${result.total}฿\n` +
      `สถานะ: จ่ายแล้ว ✅`;
  }

  // Help command
  if (lower === 'help' || lower === 'ช่วยเหลือ' || lower === '?') {
    return getHelpMessage(isAdmin);
  }

  // ============================================================================
  // ORDER PLACEMENT (ALL USERS - with permission check)
  // ============================================================================

  if (!AccessControl.canPerformAction(userId, PERMISSIONS.PLACE_ORDER)) {
    AccessControl.logAccess(userId, PERMISSIONS.PLACE_ORDER, false);
    return AccessControl.getAccessDeniedMessage(PERMISSIONS.PLACE_ORDER);
  }

  // Default = Order parsing
  await loadStockCache();
  const parsed = await parseOrder(text);

  if (!parsed.success) {
    return parsed.error + (parsed.suggestion ? '\n\n' + parsed.suggestion : '');
  }

  // Handle add stock (ADMIN ONLY)
  if (parsed.action === 'add_stock') {
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.ADD_STOCK)) {
      AccessControl.logAccess(userId, PERMISSIONS.ADD_STOCK, false);
      return AccessControl.getAccessDeniedMessage(PERMISSIONS.ADD_STOCK);
    }
    
    AccessControl.logAccess(userId, PERMISSIONS.ADD_STOCK, true);
    const newStock = parsed.stockItem.stock + parsed.quantity;
    const updated = await updateStock(parsed.stockItem.item, parsed.stockItem.unit, newStock);
    
    if (!updated) {
      return '❌ ไม่สามารถเพิ่มสต็อกได้ กรุณาลองใหม่';
    }
    
    await loadStockCache(true);
    
    const response = `✅ เพิ่มสต็อกสำเร็จ!\n` +
      `${'='.repeat(30)}\n\n` +
      `📦 สินค้า: ${parsed.stockItem.item}\n` +
      `➕ เพิ่ม: ${parsed.quantity} ${parsed.stockItem.unit}\n` +
      `📊 สต็อกเดิม: ${parsed.stockItem.stock}\n` +
      `📊 สต็อกใหม่: ${newStock} ${parsed.stockItem.unit}`;
    
    await notifyAdmin(`📦 เพิ่มสต็อก\n${parsed.stockItem.item}: ${parsed.stockItem.stock} → ${newStock}`);
    
    return response;
  }

  // Validate stock before order
  if (parsed.action === 'order' && parsed.quantity > parsed.stockItem.stock) {
    const errorMsg = `⚠️ สต็อกไม่เพียงพอ!\n\n` +
      `📦 สินค้า: ${parsed.stockItem.item}\n` +
      `❌ ต้องการ: ${parsed.quantity} ${parsed.stockItem.unit}\n` +
      `✅ มีอยู่: ${parsed.stockItem.stock} ${parsed.stockItem.unit}`;
    
    // Only notify admin if user tried to order
    if (!isAdmin) {
      await notifyAdmin(`⚠️ สต็อกไม่เพียงพอ\nสินค้า: ${parsed.stockItem.item}\nลูกค้าต้องการ: ${parsed.quantity}, มี: ${parsed.stockItem.stock}`);
    }
    
    return errorMsg;
  }

  // Validate quantity
  if (parsed.quantity > CONFIG.MAX_ORDER_QUANTITY) {
    return `❌ จำนวนมากเกินไป!\n\nสั่งได้สูงสุด ${CONFIG.MAX_ORDER_QUANTITY} ${parsed.stockItem.unit}`;
  }

  // Create order
  try {
    AccessControl.logAccess(userId, PERMISSIONS.PLACE_ORDER, true);
    
    const isCredit = lower.includes('เครดิต') || lower.includes('ค้าง') || lower.includes('ไว้ก่อน');
    const totalAmount = parsed.quantity * parsed.stockItem.price;

    let deliveryPerson = '';
    const deliveryMatch = text.match(/ส่ง(?:โดย|ให้)?\s*([ก-๙]+)/i);
    if (deliveryMatch) {
      deliveryPerson = deliveryMatch[1];
    }

    const result = await createOrder({
      customer: parsed.customer,
      item: parsed.stockItem.item,
      quantity: parsed.quantity,
      deliveryPerson,
      isCredit,
      totalAmount
    });

    const newStock = parsed.stockItem.stock - parsed.quantity;
    const stockUpdated = await updateStock(parsed.stockItem.item, parsed.stockItem.unit, newStock);
    
    if (!stockUpdated) {
      await notifyAdmin(`❌ CRITICAL: Order #${result.orderNo} created but stock update FAILED!\nItem: ${parsed.stockItem.item}`);
      return `⚠️ คำสั่งซื้อสำเร็จ แต่อัปเดตสต็อกล้มเหลว\nกรุณาแจ้งแอดมินตรวจสอบคำสั่งซื้อ #${result.orderNo}`;
    }
    
    await loadStockCache(true);

    // Different response for admin vs user
    let response = isAdmin 
      ? `✅ บันทึกคำสั่งซื้อสำเร็จ! (Admin)\n`
      : `✅ รับคำสั่งซื้อเรียบร้อยค่ะ!\n`;
    
    response += `${'='.repeat(30)}\n\n` +
      `📋 คำสั่งซื้อ: #${result.orderNo}\n` +
      `👤 ลูกค้า: ${parsed.customer}\n` +
      `📦 สินค้า: ${parsed.stockItem.item}\n` +
      `🔢 จำนวน: ${parsed.quantity} ${parsed.stockItem.unit}\n` +
      `💰 ราคา: ${parsed.stockItem.price.toLocaleString()}฿/${parsed.stockItem.unit}\n` +
      `💵 ยอดรวม: ${totalAmount.toLocaleString()}฿\n` +
      `${isCredit ? '📖 การชำระ: เครดิต (ค้างชำระ)' : '✅ การชำระ: จ่ายแล้ว'}\n`;
    
    if (deliveryPerson) {
      response += `🚚 ผู้ส่ง: ${deliveryPerson}\n`;
    }
    
    // Show stock only to admin
    if (isAdmin) {
      response += `\n📊 สต็อกคงเหลือ: ${newStock} ${parsed.stockItem.unit}`;
      
      if (newStock < CONFIG.LOW_STOCK_THRESHOLD) {
        response += `\n⚠️ แจ้งเตือน: สต็อกเหลือน้อย!`;
      }
    } else {
      response += `\n\n🙏 ขอบคุณที่สั่งซื้อค่ะ`;
    }

    if (parsed.confidence === 'low') {
      response += `\n\n⚠️ ระบบไม่แน่ใจ กรุณาตรวจสอบอีกครั้ง`;
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
      deliveryPerson,
      newStock,
      userId: isAdmin ? `${userId} (ADMIN)` : userId
    });

    return response;

  } catch (error) {
    Logger.error('Order creation error', error);
    await notifyAdmin(`❌ Order Error\nUser: ${userId}\n${error.message}\nInput: ${text}`);
    return '❌ เกิดข้อผิดพลาดในการบันทึกคำสั่งซื้อ ลองใหม่นะคะ';
  }
}
async function handleTextMessageWithRetry(text, replyToken, attempt = 1) {
  const MAX_ATTEMPTS = 2;
  
  try {
    const reply = await handleTextMessage(text);
    await replyToLine(replyToken, reply);
    
  } catch (error) {
    if (attempt < MAX_ATTEMPTS && isRetryableError(error)) {
      Logger.warn(`Retry attempt ${attempt + 1} for text message`);
      await sleep(1000 * attempt);
      return handleTextMessageWithRetry(text, replyToken, attempt + 1);
    }
    
    throw error;
  }
}


async function handleVoiceMessage(messageId, replyToken, userId) {
  try {
    // Check if user can place orders
    if (!AccessControl.canPerformAction(userId, 'place_order')) {
      AccessControl.logAccess(userId, 'place_order', false);
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

    Logger.success(`✅ Transcript: "${voiceResult.text}"`);
    
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
async function handleVoiceMessageWithRetry(messageId, replyToken, attempt = 1) {
  const MAX_ATTEMPTS = 2;
  
  try {
    await handleVoiceMessage(messageId, replyToken);
    
  } catch (error) {
    if (attempt < MAX_ATTEMPTS && isRetryableError(error)) {
      Logger.warn(`Retry attempt ${attempt + 1} for voice message`);
      await sleep(2000 * attempt);
      return handleVoiceMessageWithRetry(messageId, replyToken, attempt + 1);
    }
    
    await sendErrorReply(replyToken, error);
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
function isRetryableError(error) {
  const retryable = [
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    '429',
    'quota',
    'rate limit'
  ];
  
  const errorMsg = error.message?.toLowerCase() || '';
  return retryable.some(keyword => errorMsg.includes(keyword.toLowerCase()));
}

// User-friendly error messages
async function sendErrorReply(replyToken, error) {
  let message = '❌ เกิดข้อผิดพลาด\n\n';
  
  if (error.message?.includes('quota') || error.message?.includes('429')) {
    message += '⏳ ระบบยุ่งมาก กรุณารอ 1-2 นาทีแล้วลองใหม่';
  } else if (error.message?.includes('transcribe')) {
    message += '🎤 ระบบแปลงเสียงมีปัญหา\nลองพิมพ์แทนได้เลยค่ะ';
  } else if (error.message?.includes('Sheets')) {
    message += '📊 ไม่สามารถเชื่อมต่อ Google Sheets\nแจ้งแอดมินด่วนค่ะ';
  } else {
    message += 'ลองใหม่อีกครั้งนะคะ\nหรือติดต่อแอดมินถ้าปัญหายังคงอยู่';
  }
  
  await replyToLine(replyToken, message);
}
async function pushLowStockAlert(itemName, currentStock, unit) {
  if (!CONFIG.ADMIN_LINE_ID) {
    Logger.warn('ADMIN_LINE_ID not configured, skipping low stock alert');
    return;
  }

  try {
    const stockCache = require('./cacheManager').getStockCache();
    const allLowStock = stockCache.filter(item => item.stock < CONFIG.LOW_STOCK_THRESHOLD);
    
    let message = `⚠️ แจ้งเตือนสต็อกเหลือน้อย!\n${'='.repeat(30)}\n\n`;
    message += `🔴 เพิ่งหมด:\n`;
    message += `• ${itemName}: ${currentStock} ${unit}\n\n`;
    
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
    
    await pushToLine(CONFIG.ADMIN_LINE_ID, message);
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
      `• "dashboard" - ดูสรุปยอดขาย\n\n` +
      `🔧 จัดการ:\n` +
      `• "รีเฟรช" - โหลดข้อมูลใหม่\n` +
      `• "เพิ่มสต็อก [สินค้า] [จำนวน]"\n` +
      `• "จ่ายแล้ว [เลขคำสั่ง]" - อัปเดตชำระเงิน\n\n` +
      `📦 สั่งซื้อ:\n` +
      `• พิมพ์: "คุณสมชาย สั่งน้ำแข็งหลอดใหญ่ 2 ถุง"\n` +
      `• เสียง: กดไมค์แล้วพูด\n\n` +
      `ℹ️ สต็อกจะแจ้งเตือนอัตโนมัติเมื่อเหลือน้อย`;
  } else {
    return `🛒 วิธีสั่งซื้อ\n${'='.repeat(30)}\n\n` +
      `📝 พิมพ์ข้อความ:\n` +
      `"[ชื่อลูกค้า] สั่ง [สินค้า] [จำนวน]"\n\n` +
      `ตัวอย่าง:\n` +
      `• "คุณสมชาย สั่งน้ำแข็งหลอดใหญ่ 2 ถุง"\n` +
      `• "พี่ใหญ่ เอาเบียร์ช้าง 5 กระป๋อง"\n\n` +
      `🎤 หรือส่งข้อความเสียง:\n` +
      `กดไมค์แล้วพูดตามตัวอย่างข้างบน\n\n` +
      `💳 การชำระเงิน:\n` +
      `• เพิ่ม "เครดิต" หรือ "ค้าง" = ค้างชำระ\n` +
      `• ไม่ระบุ = จ่ายเงินแล้ว`;
  }
}

async function generateDashboard() {
  const orders = await getOrders({ date: getThaiDateString() });
  const stockCache = require('./cacheManager').getStockCache();
  
  let totalSales = 0;
  let totalProfit = 0;
  let totalOrders = orders.length;
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
  message += `📈 ยอดขาย\n`;
  message += `• คำสั่งซื้อ: ${totalOrders} รายการ\n`;
  message += `• ยอดขายรวม: ${totalSales.toLocaleString()}฿\n`;
  message += `• กำไรรวม: ${totalProfit.toLocaleString()}฿\n\n`;
  
  message += `💳 เครดิต\n`;
  message += `• ค้างชำระ: ${creditOrders} รายการ\n`;
  message += `• ยอดเงิน: ${creditAmount.toLocaleString()}฿\n\n`;
  
  message += `📦 สต็อก\n`;
  message += `• สินค้าทั้งหมด: ${stockCache.length} รายการ\n`;
  message += `• ⚠️ สต็อกเหลือน้อย: ${lowStockItems.length} รายการ\n`;
  
  if (lowStockItems.length > 0) {
    message += `\n${'='.repeat(30)}\n⚠️ รายการสต็อกเหลือน้อย:\n`;
    lowStockItems.forEach(item => {
      message += `• ${item.item}: ${item.stock} ${item.unit}\n`;
    });
  }
  
  return message;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
