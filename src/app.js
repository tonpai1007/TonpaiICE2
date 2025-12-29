const express = require('express');

// ⚠️  CRITICAL: Validate config BEFORE importing any other modules
const { CONFIG, validateConfig, configManager } = require('./config');
const { Logger } = require('./logger');

// Validate config IMMEDIATELY
try {
  validateConfig(); 
  Logger.success('✅ Configuration validated');
} catch (e) {
  Logger.error('❌ Config Validation Failed', e);
  console.error('\n🔴 CRITICAL ERROR: Invalid configuration');
  process.exit(1);
}

// NOW safe to import modules
const { initializeGoogleServices } = require('./googleServices');
const { initializeAIServices, generateWithGemini, isGeminiAvailable } = require('./aiServices');
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
// SMART COMMAND DETECTION
// ============================================================================

async function detectAndExecuteCommand(text, userId) {
  const isAdmin = AccessControl.isAdmin(userId);
  
  // Simple keyword detection for common commands
  const lower = text.toLowerCase().replace(/\s+/g, '');
  
  // Check simple commands first
  const simpleCommands = {
    'รีเฟรsh': 'refresh',
    'refresh': 'refresh',
    'โหลดใหม่': 'refresh',
    'คำสั่งซื้อ': 'orders',
    'orders': 'orders',
    'ค้างชำระ': 'pending',
    'pending': 'pending',
    'dashboard': 'dashboard',
    'สรุป': 'dashboard',
    'help': 'help',
    'ช่วยเหลือ': 'help'
  };
  
  if (simpleCommands[lower]) {
    return { isCommand: true, command: simpleCommands[lower] };
  }
  
  // Payment status update patterns
  if (lower.includes('จ่ายแล้ว') && /\d+/.test(text)) {
    return { isCommand: true, command: 'mark_paid' };
  }
  
  if (lower.includes('เครดิต') && /\d+/.test(text) && !lower.includes('สั่ง')) {
    return { isCommand: true, command: 'mark_credit' };
  }
  
  if ((lower.includes('ส่งแล้ว') || lower.includes('ส่งเสร็จ')) && /\d+/.test(text)) {
    return { isCommand: true, command: 'mark_delivered' };
  }
  
  // If Gemini is available, use AI for complex detection
  if (isGeminiAvailable()) {
    try {
      Logger.info('🤖 AI detecting command...');
      
      const schema = {
        type: 'object',
        properties: {
          isCommand: { type: 'boolean' },
          commandType: { 
            type: 'string',
            enum: ['order', 'query', 'update', 'system']
          },
          confidence: { type: 'number' }
        },
        required: ['isCommand', 'commandType', 'confidence']
      };
      
      const prompt = `Analyze this Thai text and determine if it's a command or order:
"${text}"

Return JSON with:
- isCommand: true if it's a system command (not an order)
- commandType: order/query/update/system
- confidence: 0-1`;
      
      const result = await generateWithGemini(prompt, schema, 0.1);
      
      if (result.isCommand && result.confidence > 0.7) {
        return { isCommand: true, command: 'ai_detected', aiResult: result };
      }
    } catch (error) {
      Logger.warn('AI command detection failed, using fallback', error);
    }
  }
  
  return { isCommand: false };
}

// ============================================================================
// MAIN MESSAGE HANDLER
// ============================================================================

async function handleTextMessage(text, userId) {
  if (!userId) {
    Logger.error('handleTextMessage called without userId');
    return '❌ Error: User identity missing.';
  }

  const lower = text.toLowerCase().replace(/\s+/g, '');
  const isAdmin = AccessControl.isAdmin(userId);

  // ============================================================================
  // SYSTEM COMMANDS
  // ============================================================================
  
  if (lower === 'ข้อมูลของฉัน' || lower === 'whoami') {
    return AccessControl.getUserInfoText(userId);
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
      message += `   ${order.item} x${order.qty}\n`;
      message += `   ${order.total.toLocaleString()}฿ | ${order.paymentStatus}\n\n`;
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
      message += `📦 ${order.item} x${order.qty}\n`;
      message += `💰 ${order.total.toLocaleString()}฿\n\n`;
      totalSales += order.total;
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

  // Payment updates
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
      `💰 ${result.total}฿\n` +
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
      `💰 ${result.total}฿`;
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

  // ============================================================================
  // ORDER PROCESSING
  // ============================================================================
  
  if (!AccessControl.canPerformAction(userId, PERMISSIONS.PLACE_ORDER)) {
    return AccessControl.getAccessDeniedMessage(PERMISSIONS.PLACE_ORDER);
  }

  try {
    await loadStockCache();
    
    // Parse order
    const parsed = await parseOrder(text);

    if (!parsed.success) {
      return parsed.error + (parsed.warning ? '\n\n' + parsed.warning : '');
    }

    // Handle add stock
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

    // ============================================================================
    // NORMALIZE TO MULTI-ITEM FORMAT
    // ============================================================================
    
    // If parser returned single item, convert to array
    let items = [];
    if (parsed.items && Array.isArray(parsed.items)) {
      items = parsed.items; // Already multi-item
    } else if (parsed.stockItem) {
      items = [{ stockItem: parsed.stockItem, quantity: parsed.quantity }]; // Single item
    } else {
      throw new Error('INVALID_PARSE_RESULT: No items found');
    }
    
    Logger.info(`📦 Processing ${items.length} item(s) for ${parsed.customer}`);
    
    const isCredit = (parsed.paymentStatus === 'credit') || 
                     text.toLowerCase().includes('เครดิต');
    
    // Validate stock
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

    // Create orders
    const orderResults = [];
    let totalAmount = 0;

    for (const { stockItem, quantity } of items) {
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

      Logger.success(`✅ Order #${result.orderNo}: ${stockItem.item} x${quantity}`);
    }

    await loadStockCache(true);

    // Build response
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

    // Notify admin
    await notifyAdminMultiItemOrder({
      customer: parsed.customer,
      items: orderResults,
      deliveryPerson: parsed.deliveryPerson,
      totalAmount: totalAmount,
      isCredit: isCredit,
      userId: isAdmin ? `${userId.substring(0, 12)}... (ADMIN)` : userId.substring(0, 12) + '...'
    });

    // Check low stock
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
    if (!AccessControl.canPerformAction(userId, PERMISSIONS.PLACE_ORDER)) {
      await replyToLine(replyToken, '🔒 ระบบปิดการรับคำสั่งซื้อชั่วคราว');
      return;
    }
    
    Logger.info('🎤 Processing voice message:', messageId);
    
    const audioBuffer = await fetchAudioFromLine(messageId);
    const voiceResult = await processVoiceMessage(audioBuffer);
    
    if (!voiceResult.success) {
      await replyToLine(replyToken, voiceResult.error);
      return;
    }

    Logger.success(`✅ Voice: "${voiceResult.text}"`);
    
    let finalResponse = `🎤 ได้ยิน: "${voiceResult.text}"\n\n`;
    
    try {
      const orderResult = await handleTextMessage(voiceResult.text, userId);
      finalResponse += orderResult;
      await replyToLine(replyToken, finalResponse);
    } catch (orderError) {
      Logger.error('Order processing error after voice', orderError);
      finalResponse += '❌ เกิดข้อผิดพลาด ลองใหม่ค่ะ';
      await replyToLine(replyToken, finalResponse);
    }

  } catch (error) {
    Logger.error('❌ handleVoiceMessage error', error);
    
    let errorMsg = '❌ เกิดข้อผิดพลาดค่ะ ';
    
    if (error.message?.includes('LINE audio')) {
      errorMsg += 'ไม่สามารถโหลดไฟล์เสียงได้';
    } else if (error.message?.includes('quota') || error.message?.includes('429')) {
      errorMsg += 'ระบบยุ่ง รอสักครู่นะคะ';
    } else {
      errorMsg += 'ลองพิมพ์แทนนะคะ';
    }
    
    try {
      await replyToLine(replyToken, errorMsg);
    } catch (replyError) {
      Logger.error('Failed to send error reply', replyError);
    }
    
    await notifyAdmin(`❌ Voice Error\nUser: ${userId}\nError: ${error.message}`);
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
    totalSales += order.total;
    totalProfit += (order.total - order.cost);
    if (order.paymentStatus === 'ยังไม่จ่าย' || order.paymentStatus === 'เครดิต') {
      creditOrders++;
      creditAmount += order.total;
    }
  });
  
  const lowStockItems = stockCache.filter(item => item.stock < CONFIG.LOW_STOCK_THRESHOLD);
  
  let message = `📊 Dashboard วันนี้\n${'='.repeat(30)}\n\n`;
  message += `📈 ยอดขาย\n`;
  message += `• คำสั่งซื้อ: ${orders.length} รายการ\n`;
  message += `• ยอดขายรวม: ${totalSales.toLocaleString()}฿\n`;
  message += `• กำไรรวม: ${totalProfit.toLocaleString()}฿\n\n`;
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
          await replyToLine(event.replyToken, '❌ เกิดข้อผิดพลาด กรุณาลองใหม่');
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
  const { getServiceHealth } = require('./aiServices');
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: getServiceHealth(),
    caches: {
      stock: {
        size: getStockCache().length,
        ragVectors: stockVectorStore.size()
      },
      customer: {
        size: getCustomerCache().length,
        ragVectors: customerVectorStore.size()
      }
    }
  });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  Logger.info(`🚀 LINE Order Bot running on port ${PORT}`);
  Logger.info(`⏰ ${getThaiDateTimeString()}`);
  
  await initializeApp();
});

module.exports = app;