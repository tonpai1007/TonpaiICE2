const express = require('express');

// ⚠️  CRITICAL: Validate config BEFORE importing any other modules
const { CONFIG, validateConfig, configManager } = require('./config');
const { Logger } = require('./logger');

// Validate config IMMEDIATELY to prevent ReferenceErrors during module loading
try {
  validateConfig(); 
  Logger.success('✅ Configuration validated');
} catch (e) {
  Logger.error('❌ Config Validation Failed', e);
  console.error('\n🔴 CRITICAL ERROR: Invalid configuration');
  console.error('Please check your .env file and ensure all required variables are set.\n');
  process.exit(1);
}

// NOW it's safe to import other modules that depend on CONFIG
const { initializeGoogleServices } = require('./googleServices');
const { initializeAIServices } = require('./aiServices');
const { loadStockCache, loadCustomerCache } = require('./cacheManager');
const { getThaiDateTimeString, getThaiDateString } = require('./utils');
const { parseOrder } = require('./orderParser');
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
// INITIALIZATION - Provider Pattern
// ============================================================================

async function initializeApp() {
  try {
    Logger.info('🚀 Starting LINE Order Bot...');
    
    // Config already validated above
    Logger.success('Configuration: OK');
    
    // Initialize services in correct order
    Logger.info('Initializing Google Services...');
    initializeGoogleServices();
    
    Logger.info('Initializing AI Services...');
    initializeAIServices();
    
    // Initialize sheets
    Logger.info('Initializing Google Sheets...');
    await initializeSheets();
    
    // Load caches (this triggers RAG vector store building)
    Logger.info('Loading stock cache...');
    await loadStockCache(true);
    
    Logger.info('Loading customer cache...');
    await loadCustomerCache(true);
    
    // Log admin configuration
    const admins = configManager.get('ADMIN_USER_IDS', []);
    if (admins.length > 0) {
      Logger.success(`✅ ${admins.length} admin user(s) configured`);
    } else {
      Logger.warn('⚠️  No admin users configured - some features will be limited');
    }
    
    Logger.success('✅ System initialized - Ready to process orders! 🎯');
    Logger.info(`📱 Webhook ready at: http://localhost:${process.env.PORT || 3000}/webhook`);
    
  } catch (error) {
    Logger.error('❌ Initialization failed', error);
    console.error('\n🔴 FATAL: System initialization failed');
    console.error('Error:', error.message);
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

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function notifyAdmin(message) {
  const admins = configManager.get('ADMIN_USER_IDS', []);
  
  if (admins.length === 0) {
    Logger.warn('No admin users configured - cannot send notification');
    return;
  }

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
  
  if (admins.length === 0) {
    Logger.warn('No admin users configured, skipping low stock alert');
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
    
    for (const adminId of admins) {
      await pushToLine(adminId, message);
    }
    
    Logger.success('Low stock alert sent to admins');
  } catch (error) {
    Logger.error('Failed to send low stock alert', error);
  }
}

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, async () => {
  console.log('\n' + '='.repeat(50));
  console.log('🚀 LINE Order Bot - Multi-Item System');
  console.log('='.repeat(50));
  console.log(`📍 Port: ${PORT}`);
  console.log(`⏰ Bangkok time: ${getThaiDateTimeString()}`);
  console.log('='.repeat(50) + '\n');
  
  await initializeApp();
});

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
  } 
  if (lower.includes('จ่ายแล้ว') && /\d+/.test(text)) {
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
  } 
  if ((lower.includes('ส่งแล้ว') || lower.includes('ส่งเสร็จ')) && /\d+/.test(text)) {
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
    
    // Parse order using REVOLUTIONARY multi-item parser
    const parsed = await parseOrder(text);

    if (!parsed.success) {
      return parsed.error + (parsed.warning ? '\n\n' + parsed.warning : '');
    }

    // Handle add stock action (single item)
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

    // ============================================================================
    // PROCESS MULTI-ITEM ORDER
    // ============================================================================
    
    Logger.info(`Processing ${parsed.items.length} items for ${parsed.customer}`);
    
    const isCredit = parsed.paymentStatus === 'credit';
    const orderResults = [];
    let totalAmount = 0;
    let hasStockError = false;
    let stockErrors = [];

    // Step 1: Validate ALL items have sufficient stock
    for (const { stockItem, quantity } of parsed.items) {
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
        return `❌ จำนวนมากเกินไป!\n\nสั่งได้สูงสุด ${CONFIG.MAX_ORDER_QUANTITY} ${stockItem.unit}`;
      }
    }

    // If any stock error, report ALL problems
    if (hasStockError) {
      let errorMsg = `⚠️ สต็อกไม่เพียงพอ!\n\n`;
      stockErrors.forEach(err => {
        errorMsg += `📦 ${err.item}\n`;
        errorMsg += `   ❌ ต้องการ: ${err.requested} ${err.unit}\n`;
        errorMsg += `   ✅ มีอยู่: ${err.available} ${err.unit}\n\n`;
      });
      
      if (!isAdmin) {
        await notifyAdmin(`⚠️ สต็อกไม่พอ\n${parsed.customer} ต้องการ:\n${stockErrors.map(e => `${e.item} ${e.requested} ${e.unit}`).join('\n')}`);
      }
      
      return errorMsg;
    }

    // Step 2: Create orders for ALL items
    for (const { stockItem, quantity } of parsed.items) {
      const itemTotal = quantity * stockItem.price;
      totalAmount += itemTotal;

      const result = await createOrder({
        customer: parsed.customer,
        item: stockItem.item,
        quantity: quantity,
        deliveryPerson: parsed.deliveryPerson || '',
        isCredit: isCredit,
        totalAmount: itemTotal
      });

      // Update stock immediately after order creation
      const newStock = stockItem.stock - quantity;
      const stockUpdated = await updateStock(stockItem.item, stockItem.unit, newStock);
      
      if (!stockUpdated) {
        await notifyAdmin(`❌ CRITICAL: Order #${result.orderNo} created but stock update FAILED!\nItem: ${stockItem.item}`);
      }

      orderResults.push({
        orderNo: result.orderNo,
        item: stockItem.item,
        quantity: quantity,
        unit: stockItem.unit,
        price: stockItem.price,
        total: itemTotal,
        newStock: newStock
      });

      Logger.success(`Order created: #${result.orderNo} - ${stockItem.item} x${quantity}`);
    }

    // Step 3: Reload cache after all stock updates
    await loadStockCache(true);

    // Step 4: Build comprehensive response
    let response = isAdmin 
      ? `✅ บันทึกคำสั่งซื้อสำเร็จ! (${parsed.items.length} รายการ)\n`
      : `✅ รับคำสั่งซื้อเรียบร้อยค่ะ!\n`;

    response += `${'='.repeat(30)}\n\n`;
    response += `👤 ลูกค้า: ${parsed.customer}\n`;
    
    if (parsed.deliveryPerson) {
      response += `🚚 ผู้ส่ง: ${parsed.deliveryPerson}\n`;
    }
    
    response += `\n📦 รายการสินค้า:\n\n`;

    // List all items
    orderResults.forEach((order, idx) => {
      response += `${idx + 1}. ${order.item}\n`;
      response += `   📋 คำสั่งซื้อ: #${order.orderNo}\n`;
      response += `   📢 จำนวน: ${order.quantity} ${order.unit}\n`;
      response += `   💰 ราคา: ${order.price.toLocaleString()}฿/${order.unit}\n`;
      response += `   💵 รวม: ${order.total.toLocaleString()}฿\n`;
      
      if (isAdmin) {
        response += `   📊 สต็อกคงเหลือ: ${order.newStock} ${order.unit}`;
        if (order.newStock < CONFIG.LOW_STOCK_THRESHOLD) {
          response += ` ⚠️`;
        }
      }
      response += `\n\n`;
    });

    response += `${'='.repeat(30)}\n`;
    response += `💵 ยอดรวมทั้งหมด: ${totalAmount.toLocaleString()}฿\n`;

    // Show payment status clearly
    if (isCredit) {
      response += `📖 สถานะ: เครดิต (ค้างชำระ)\n`;
    } else {
      response += `⏳ สถานะ: ยังไม่จ่าย\n`;
      if (isAdmin) {
        const firstOrderNo = orderResults[0].orderNo;
        response += `💡 พิมพ์ "จ่ายแล้ว ${firstOrderNo}" เมื่อได้รับเงิน\n`;
      }
    }

    if (!isAdmin) {
      response += `\n🙏 ขอบคุณที่สั่งซื้อค่ะ`;
    }

    if (parsed.warning) {
      response += `\n\n${parsed.warning}`;
    }

    // Step 5: Notify admin with ALL items
    await notifyAdminMultiItemOrder({
      customer: parsed.customer,
      items: orderResults,
      deliveryPerson: parsed.deliveryPerson,
      totalAmount: totalAmount,
      isCredit: isCredit,
      userId: isAdmin ? `${userId.substring(0, 12)}... (ADMIN)` : userId.substring(0, 12) + '...'
    });

    // Step 6: Check for low stock alerts
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
  
  if (!CONFIG.ADMIN_USER_IDS || CONFIG.ADMIN_USER_IDS.length === 0) {
    Logger.warn('No admin users configured');
    return;
  }

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
    message += `   📊 สต็อกคงเหลือ: ${item.newStock} ${item.unit}`;
    if (item.newStock < CONFIG.LOW_STOCK_THRESHOLD) {
      message += ` ⚠️ เหลือน้อย!`;
    }
    message += `\n`;
  });
  
  message += `\n${'='.repeat(30)}\n`;
  message += `💰 ยอดเงินรวม: ${totalAmount.toLocaleString()}฿\n`;
  message += `${isCredit ? '📖 การชำระ: เครดิต' : '✅ การชำระ: จ่ายแล้ว'}\n`;
  message += `👤 สั่งโดย: ${userId}`;

  for (const adminId of CONFIG.ADMIN_USER_IDS) {
    await pushToLine(adminId, message);
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
    
    // Build combined response
    let finalResponse = `🎤 ได้ยิน: "${voiceResult.text}"\n\n`;
    
    try {
      const orderResult = await handleTextMessage(voiceResult.text, userId);
      finalResponse += orderResult;
      
      // Send combined response (only once using replyToken)
      await replyToLine(replyToken, finalResponse);
      
      // Notify admin if successful
      if (orderResult.includes('✅')) {
        await notifyAdmin(`🎤 คำสั่งซื้อจากเสียง\nUser: ${userId}\nข้อความ: "${voiceResult.text}"\n\n${orderResult}`);
      }
    } catch (orderError) {
      Logger.error('Order processing error after voice', orderError);
      finalResponse += '❌ เกิดข้อผิดพลาดในการบันทึกคำสั่งซื้อ\nกรุณาลองใหม่หรือพิมพ์แทนค่ะ';
      await replyToLine(replyToken, finalResponse);
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
      errorMsg += 'ลองพิมพ์แทนหรือลองใหม่นะคะ';
    }
    
    try {
      await replyToLine(replyToken, errorMsg);
    } catch (replyError) {
      Logger.error('Failed to send error reply', replyError);
    }
    
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