// src/messageHandlerService.js - COMPLETE REWRITE WITH ALL FIXES
const { Logger } = require('./logger');
const { parseOrder } = require('./orderParser');
const { createOrderTransaction, updateOrderPaymentStatus, getLastOrderNumber } = require('./orderService');
const { parseAdjustmentCommand, adjustStock } = require('./stockAdjustment');
const { generateDailySummary } = require('./dashboardService');
const { loadStockCache, loadCustomerCache } = require('./cacheManager');
const { shouldAutoProcess, applySmartCorrection, monitor } = require('./aggressiveAutoConfig');
const { smartLearner } = require('./smartOrderLearning');
const { autoAddCustomer } = require('./customerService');
const { handleBusinessCommand } = require('./businessCommands');
const { AccessControl } = require('./accessControl');
const { saveToInbox, cancelOrder, generateInboxSummary } = require('./inboxService');
const { generateEnhancedCreditReport, getCreditSummaryWithAlerts } = require('./creditService');
const { getSheetData, updateSheetData } = require('./googleServices');
const { CONFIG } = require('./config');

// ============================================================================
// PAYMENT LOCK (Fix race condition)
// ============================================================================

class PaymentLock {
  constructor() {
    this.processing = new Set();
  }

  async lock(orderNo) {
    if (this.processing.has(orderNo)) {
      throw new Error('Payment update already in progress');
    }
    this.processing.add(orderNo);
  }

  unlock(orderNo) {
    this.processing.delete(orderNo);
  }

  isLocked(orderNo) {
    return this.processing.has(orderNo);
  }
}

const paymentLock = new PaymentLock();

// ============================================================================
// DELIVERY LOCK (Fix race condition)
// ============================================================================

class DeliveryLock {
  constructor() {
    this.processing = new Set();
  }

  async lock(orderNo) {
    if (this.processing.has(orderNo)) {
      throw new Error('Delivery update already in progress');
    }
    this.processing.add(orderNo);
  }

  unlock(orderNo) {
    this.processing.delete(orderNo);
  }
}

const deliveryLock = new DeliveryLock();

// ============================================================================
// MAIN MESSAGE HANDLER - FIXED PRIORITY ORDER
// ============================================================================

async function handleMessage(text, userId) {
  try {
    const lower = text.toLowerCase().trim();

    // ✅ ALWAYS save to inbox first
    await saveToInbox(userId, text);

    // ========================================================================
    // PRIORITY 0: PURE GREETINGS & HELP (No AI needed)
    // ========================================================================

    const greetings = ['start', 'เริ่ม', 'hello', 'hi', 'สวัสดี', 'hey'];
    if (greetings.includes(lower)) {
      return { success: true, message: getHelpMessage(userId) };
    }

    if (lower === 'help' || lower === 'ช่วย' || lower === 'สอน') {
      return { success: true, message: getHelpMessage(userId) };
    }

    // ========================================================================
    // PRIORITY 1: PURE PAYMENT COMMANDS (No AI needed)
    // ========================================================================

    // ✅ Check if it's PURE payment (not mixed with order)
    const isPurePayment = /^(จ่าย(?:แล้ว|เงิน)?|paid|ชำระ(?:แล้ว|เงิน)?|โอน(?:แล้ว|เงิน)?)(\s*#?\d+)?$/i.test(text.trim());


    if (isPurePayment) {
      Logger.info('💰 Pure payment command detected');

      const orderNoMatch = text.match(/#?(\d+)/);
      const orderNo = orderNoMatch
        ? parseInt(orderNoMatch[1])
        : await getLastOrderNumber();

      if (!orderNo) {
        return {
          success: false,
          message: '❌ ไม่พบออเดอร์\n\nพิมพ์ "จ่าย #123" เพื่อระบุเลขออเดอร์'
        };
      }

      const result = await handlePaymentUpdate(orderNo);
      return result;
    }

    // ========================================================================
    // PRIORITY 2: PURE DELIVERY COMMANDS
    // ========================================================================

    if (/^ส่ง\s+/.test(lower)) {
      Logger.info('🚚 Pure delivery command detected');

      const deliveryMatch = text.match(/^ส่ง\s+(?:#(\d+)\s+)?(.+)/i);

      if (deliveryMatch) {
        const orderNo = deliveryMatch[1]
          ? parseInt(deliveryMatch[1])
          : await getLastOrderNumber();
        const deliveryPerson = deliveryMatch[2].trim();

        if (!orderNo) {
          return {
            success: false,
            message: '❌ ไม่พบออเดอร์\n\nพิมพ์ "ส่ง #123 พี่แดง"'
          };
        }

        const result = await handleDeliveryUpdate(orderNo, deliveryPerson);
        return result;
      }
    }

    // ========================================================================
    // PRIORITY 3: CANCEL ORDER
    // ========================================================================

    if (lower === 'ยกเลิก' || lower.startsWith('ยกเลิก ')) {
      Logger.info('❌ Cancel command detected');

      const orderNoMatch = text.match(/#?(\d+)/);
      const orderNo = orderNoMatch
        ? parseInt(orderNoMatch[1])
        : await getLastOrderNumber();

      if (!orderNo) {
        return {
          success: false,
          message: '❌ ไม่พบออเดอร์ที่ต้องการยกเลิก'
        };
      }

      const result = await handleCancelOrder(orderNo);
      return result;
    }

    // ========================================================================
    // PRIORITY 4: ADMIN COMMANDS
    // ========================================================================

    if (lower === 'สรุป' || lower.includes('สรุปวันนี้')) {
      const summary = await generateDailySummary();
      return { success: true, message: summary };
    }

    if (lower === 'inbox' || lower.includes('ประวัติ')) {
      const inbox = await generateInboxSummary(50);
      return { success: true, message: inbox };
    }

    if (lower === 'รีเฟรช' || lower === 'refresh') {
      await loadStockCache(true);
      await loadCustomerCache(true);
      await smartLearner.loadOrderHistory();
      return { success: true, message: '✅ รีเฟรชข้อมูลสำเร็จ' };
    }

    // ========================================================================
    // PRIORITY 5: CREDIT COMMANDS
    // ========================================================================

    if (lower.includes('เครดิต') || lower === 'credit') {
      if (lower.startsWith('เครดิต ')) {
        const customerName = text.replace(/เครดิต/i, '').trim();
        return await handleCustomerCreditQuery(customerName);
      }

      const report = await generateEnhancedCreditReport();
      return { success: true, message: report };
    }

    // ========================================================================
    // PRIORITY 6: BUSINESS COMMANDS (analytics, etc.)
    // ========================================================================

    const businessResult = await handleBusinessCommand(text, userId);
    if (businessResult && businessResult.success) {
      return businessResult;
    }

    // ========================================================================
    // PRIORITY 7: DETECT ORDER vs STOCK ADJUSTMENT
    // ========================================================================

    const intent = detectIntent(text);
    Logger.info(`🎯 Intent detected: ${intent.type} (confidence: ${intent.confidence})`);

    if (intent.type === 'stock_adjustment' && intent.confidence === 'high') {
      Logger.info('🔧 Processing as stock adjustment');
      return await handleStockAdjustment(text);
    }

    // ========================================================================
    // PRIORITY 8: ORDER PARSING (Uses AI - Last Resort)
    // ========================================================================

    Logger.info('📝 Falling through to AI order parsing...');
    return await handleOrderParsing(text, userId);

  } catch (error) {
    Logger.error('handleMessage error', error);
    return {
      success: false,
      message: '❌ เกิดข้อผิดพลาด\n\nกรุณาลองใหม่อีกครั้ง'
    };
  }
}

// ============================================================================
// INTENT DETECTION (No AI - Fast)
// ============================================================================

function detectIntent(text) {
  const lower = text.toLowerCase();

  // Stock adjustment keywords
  const stockKeywords = ['เหลือ', 'มี', 'เติม', 'ลด', 'เพิ่ม', 'ปรับ'];
  const hasStockKeywords = stockKeywords.some(kw => lower.includes(kw));

  // Order keywords
  const orderKeywords = ['สั่ง', 'ซื้อ', 'เอา', 'ขอ', 'จอง'];
  const hasOrderKeywords = orderKeywords.some(kw => lower.includes(kw));

  // Customer prefixes
  const customerPrefixes = ['คุณ', 'พี่', 'น้อง', 'เจ๊', 'ร้าน', 'ป้า'];
  const hasCustomerPrefix = customerPrefixes.some(prefix => lower.includes(prefix));

  // Pattern: "[product] เหลือ/มี [number]"
  const stockPattern = /^[ก-๙a-z\s]+\s+(เหลือ|มี)\s+\d+/i;
  const isStockPattern = stockPattern.test(text);

  // Scoring
  let stockScore = 0;
  let orderScore = 0;

  if (hasStockKeywords) stockScore += 3;
  if (isStockPattern) stockScore += 5;
  if (!hasOrderKeywords) stockScore += 2;
  if (!hasCustomerPrefix) stockScore += 2;

  if (hasOrderKeywords) orderScore += 3;
  if (hasCustomerPrefix) orderScore += 3;
  if (!hasStockKeywords) orderScore += 2;

  Logger.debug(`Intent scores - Stock: ${stockScore}, Order: ${orderScore}`);

  if (stockScore >= 7 && stockScore > orderScore) {
    return { type: 'stock_adjustment', confidence: 'high' };
  }

  if (orderScore >= 5 && orderScore > stockScore) {
    return { type: 'order', confidence: 'high' };
  }

  return { type: 'unknown', confidence: 'low' };
}

// ============================================================================
// PAYMENT UPDATE HANDLER - FIXED WITH LOCK
// ============================================================================

async function handlePaymentUpdate(orderNo) {
  try {
    // ✅ Check if already processing
    if (paymentLock.isLocked(orderNo)) {
      return {
        success: false,
        message: '⏳ กำลังอัปเดตการชำระเงินอยู่\n\nกรุณารอสักครู่'
      };
    }

    // ✅ Acquire lock
    await paymentLock.lock(orderNo);

    try {
      // ✅ Check current status
      const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');

      const orderRows = rows.filter(r => r[0] == orderNo);

      if (orderRows.length === 0) {
        return {
          success: false,
          message: `❌ ไม่พบออเดอร์ #${orderNo}`
        };
      }

      const currentStatus = orderRows[0][7]; // Column H

      if (currentStatus === 'จ่ายแล้ว') {
        Logger.info(`Order #${orderNo} already paid`);

        const customer = orderRows[0][2];
        const totalAmount = orderRows.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

        return {
          success: true,
          message: `ℹ️ ออเดอร์นี้จ่ายเงินแล้ว\n\n📋 #${orderNo}\n👤 ${customer}\n💰 ${totalAmount.toLocaleString()}฿`
        };
      }

      // ✅ Update payment status
      const result = await updateOrderPaymentStatus(orderNo, 'จ่ายแล้ว');

      if (result.success) {
        return {
          success: true,
          message: `✅ อัปเดตการชำระเงินสำเร็จ!\n\n📋 #${orderNo}\n👤 ${result.customer}\n💰 ${result.totalAmount.toLocaleString()}฿`
        };
      } else {
        return {
          success: false,
          message: result.error
        };
      }

    } finally {
      // ✅ Always release lock
      paymentLock.unlock(orderNo);
    }

  } catch (error) {
    Logger.error('Payment update failed', error);
    paymentLock.unlock(orderNo);

    return {
      success: false,
      message: '❌ เกิดข้อผิดพลาดในการอัปเดตการชำระเงิน'
    };
  }
}

// ============================================================================
// DELIVERY UPDATE HANDLER - FIXED WITH VALIDATION
// ============================================================================

async function handleDeliveryUpdate(orderNo, deliveryPerson) {
  try {
    // ✅ Validate input
    if (!deliveryPerson || deliveryPerson.trim().length === 0) {
      return {
        success: false,
        message: '❌ กรุณาระบุชื่อผู้ส่ง\n\n💡 ตัวอย่าง:\n• "ส่ง พี่แดง"\n• "ส่ง #123 พี่แดง"'
      };
    }

    if (deliveryPerson.length > 50) {
      return {
        success: false,
        message: '❌ ชื่อผู้ส่งยาวเกินไป (สูงสุด 50 ตัวอักษร)'
      };
    }

    // ✅ Acquire lock
    await deliveryLock.lock(orderNo);

    try {
      const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
      const orderRows = [];
      let customer = '';

      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] == orderNo) {
          orderRows.push({ index: i + 1, data: rows[i] });
          customer = rows[i][2];
        }
      }

      if (orderRows.length === 0) {
        return {
          success: false,
          message: `❌ ไม่พบออเดอร์ #${orderNo}`
        };
      }

      // ✅ Check if already has delivery
      const currentDelivery = orderRows[0].data[6]; // Column G

      let warningMessage = '';

      if (currentDelivery && currentDelivery.trim() !== '') {
        Logger.warn(`Order #${orderNo} already has delivery: ${currentDelivery}`);
        warningMessage = `\n\n⚠️ เดิม: ${currentDelivery}`;
      }

      // ✅ Update delivery
      for (const orderRow of orderRows) {
        await updateSheetData(
          CONFIG.SHEET_ID,
          `คำสั่งซื้อ!G${orderRow.index}`,
          [[deliveryPerson]]
        );
      }

      Logger.success(`🚚 Delivery updated: #${orderNo} → ${deliveryPerson}`);

      return {
        success: true,
        message: `🚚 อัปเดตการจัดส่งสำเร็จ!\n\n📋 #${orderNo}\n👤 ${customer}\n🚴 ผู้ส่ง: ${deliveryPerson}${warningMessage}`
      };

    } finally {
      deliveryLock.unlock(orderNo);
    }

  } catch (error) {
    Logger.error('Delivery update failed', error);
    deliveryLock.unlock(orderNo);

    return {
      success: false,
      message: '❌ เกิดข้อผิดพลาดในการอัปเดตการจัดส่ง'
    };
  }
}

// ============================================================================
// CANCEL ORDER HANDLER - FIXED WITH STOCK LOCK
// ============================================================================

async function handleCancelOrder(orderNo) {
  try {
    Logger.info(`🔄 Cancelling order #${orderNo}...`);

    const result = await cancelOrder(orderNo);

    if (result.success) {
      let msg = `✅ ยกเลิกออเดอร์สำเร็จ!\n\n📋 #${orderNo}\n👤 ${result.customer}\n\n📦 คืนสต็อก:\n`;

      result.stockRestored.forEach(item => {
        msg += `• ${item.item} +${item.restored} → ${item.newStock} ${item.unit}\n`;
      });

      return { success: true, message: msg };
    } else {
      return { success: false, message: result.error };
    }

  } catch (error) {
    Logger.error('Cancel order failed', error);
    return {
      success: false,
      message: '❌ ไม่สามารถยกเลิกออเดอร์ได้'
    };
  }
}

// ============================================================================
// CUSTOMER CREDIT QUERY
// ============================================================================

async function handleCustomerCreditQuery(customerName) {
  try {
    const summary = await getCreditSummaryWithAlerts();
    const customer = summary.customers.find(c =>
      c.name.toLowerCase().includes(customerName.toLowerCase())
    );

    if (!customer) {
      return {
        success: false,
        message: `❌ ไม่พบเครดิตของ ${customerName}\n\nลูกค้ารายนี้อาจ:\n• จ่ายเงินหมดแล้ว\n• ยังไม่เคยมีเครดิตค้าง`
      };
    }

    let msg = `💳 เครดิตของ ${customer.name}\n${'='.repeat(40)}\n\n`;
    msg += `💰 ยอดรวม: ${customer.totalAmount.toLocaleString()}฿\n`;
    msg += `📦 จำนวนออเดอร์: ${customer.orders.length} รายการ\n\n`;

    customer.orders.forEach(order => {
      let status = '';
      if (order.isOverdue) {
        const daysOverdue = Math.abs(order.daysUntilDue);
        status = ` 🔴 เกิน ${daysOverdue} วัน`;
      } else if (order.daysUntilDue <= 7 && order.daysUntilDue > 0) {
        status = ` ⏰ เหลือ ${order.daysUntilDue} วัน`;
      }

      msg += `#${order.orderNo}: ${order.amount.toLocaleString()}฿${status}\n`;
    });

    return { success: true, message: msg };

  } catch (error) {
    Logger.error('Customer credit query failed', error);
    return {
      success: false,
      message: '❌ ไม่สามารถดูข้อมูลเครดิตได้'
    };
  }
}

// ============================================================================
// STOCK ADJUSTMENT HANDLER
// ============================================================================

async function handleStockAdjustment(text) {
  try {
    const stockAdjustment = await parseAdjustmentCommand(text);

    if (!stockAdjustment.isAdjustment) {
      // Not a stock adjustment - continue to order parsing
      return null;
    }

    if (stockAdjustment.ambiguous) {
      let msg = `🤔 พบสินค้าหลายรายการ: "${stockAdjustment.productName}"\n\n`;

      stockAdjustment.suggestions.forEach((item, idx) => {
        msg += `${idx + 1}. ${item.item}\n`;
        msg += `   💰 ${item.price}฿ │ 📦 ${item.stock} ${item.unit}\n\n`;
      });

      msg += `━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `💡 กรุณาระบุให้ชัดเจน:\n`;
      msg += `ตัวอย่าง: "${stockAdjustment.suggestions[0].item} ${stockAdjustment.value}"`;

      return { success: true, message: msg };
    }

    const result = await adjustStock(
      stockAdjustment.item,
      stockAdjustment.value,
      stockAdjustment.operation,
      'manual_adjustment'
    );

    if (result.success) {
      return { success: true, message: result.message };
    } else {
      return { success: false, message: result.error };
    }

  } catch (error) {
    Logger.error('Stock adjustment handler failed', error);
    return null;
  }
}

// ============================================================================
// ORDER PARSING HANDLER (AI)
// ============================================================================

async function handleOrderParsing(userInput, userId) {
  try {
    const aiResults = await parseOrder(userInput);

    if (!aiResults || aiResults.length === 0) {
      return {
        success: false,
        message: getCannotParseMessage()
      };
    }

    let finalResponses = [];

    for (const res of aiResults) {
      Logger.info(`🤖 Processing: ${res.intent} for ${res.customer}`);

      switch (res.intent) {
        case 'disambiguation':
          finalResponses.push(formatDisambiguationMessage(res));
          break;

        case 'order':
          const orderResult = await executeOrderLogic(res, userId);
          finalResponses.push(orderResult.message);
          break;

        case 'payment':
          const paymentResult = await handlePaymentUpdate(res.orderNo || await getLastOrderNumber());
          finalResponses.push(paymentResult.message);
          break;

        default:
          finalResponses.push('❌ ไม่เข้าใจคำสั่ง');
      }
    }

    return {
      success: true,
      message: finalResponses.join('\n\n' + '━'.repeat(15) + '\n\n')
    };

  } catch (error) {
    Logger.error('Order parsing failed', error);
    return {
      success: false,
      message: '❌ ไม่สามารถประมวลผลคำสั่งได้'
    };
  }
}

// ============================================================================
// EXECUTE ORDER LOGIC
// ============================================================================

async function executeOrderLogic(parsed, userId) {
  try {
    const { getCustomerCache } = require('./cacheManager');

    // Apply smart corrections
    parsed = applySmartCorrection(parsed);

    // Try smart learning
    const prediction = smartLearner.predictOrder(parsed.customer, parsed.items);
    if (prediction.success && prediction.confidence === 'high') {
      parsed.items = prediction.items || parsed.items;
    }

    // Auto-add customer if needed
    if (parsed.customer && parsed.customer !== 'ไม่ระบุ') {
      const customerCache = getCustomerCache();
      const customerExists = customerCache.some(c =>
        c.name.toLowerCase() === parsed.customer.toLowerCase()
      );

      if (!customerExists) {
        await autoAddCustomer(parsed.customer);
      }
    }

    // Determine payment status
    let paymentStatus = 'unpaid';
    if (parsed.isPaid === true) {
      paymentStatus = 'paid';
      Logger.info('💰 Detected: PAID order');
    }

    // Determine delivery person
    let deliveryPerson = '';
    if (parsed.deliveryPerson && parsed.deliveryPerson.trim() !== '') {
      deliveryPerson = parsed.deliveryPerson.trim();
      Logger.info(`🚚 Detected: Delivery by ${deliveryPerson}`);
    }

    const orderData = {
      customer: parsed.customer || 'ไม่ระบุ',
      items: parsed.items,
      deliveryPerson: deliveryPerson,
      paymentStatus: paymentStatus
    };

    const totalValue = parsed.items.reduce((sum, item) =>
      sum + (item.quantity * item.stockItem.price), 0
    );

    const autoDecision = shouldAutoProcess(parsed, totalValue);
    monitor.recordDecision(autoDecision, 'pending');

    // Create order
    const result = await createOrderTransaction(orderData);

    if (result.success) {
      monitor.recordDecision(autoDecision, result.orderNo);

      let extraMessages = [];

      // Handle payment
      if (paymentStatus === 'paid') {
        await updateOrderPaymentStatus(result.orderNo, 'จ่ายแล้ว');
        extraMessages.push('💸 บันทึกรับเงินแล้ว');
      }

      // Handle delivery
      if (deliveryPerson) {
        extraMessages.push(`🚚 กำลังส่งโดย: ${deliveryPerson}`);
      }

      let responseMsg = formatOrderSuccess(
        result.orderNo,
        result.customer,
        result.items,
        result.totalAmount,
        parsed.confidence,
        autoDecision.shouldAuto
      );

      if (extraMessages.length > 0) {
        responseMsg += `\n\n✨ อัปเดตเพิ่มเติม:\n• ${extraMessages.join('\n• ')}`;
      }

      return { success: true, message: responseMsg };

    } else {
      return {
        success: false,
        message: `❌ สร้างออเดอร์ไม่สำเร็จ: ${result.error}`
      };
    }

  } catch (error) {
    Logger.error('executeOrderLogic failed', error);
    return {
      success: false,
      message: '❌ ระบบขัดข้อง'
    };
  }
}

// ============================================================================
// FORMAT FUNCTIONS
// ============================================================================

function getHelpMessage(userId) {
  const isAdmin = AccessControl.isAdmin(userId);

  let msg = `💡 คู่มือการใช้งาน Order Bot\n${'='.repeat(40)}\n\n`;

  msg += `🛒 **สั่งสินค้า**\n`;
  msg += `• [ร้าน] สั่ง [สินค้า] [ราคา] จำนวน [จำนวน]\n`;
  msg += `  ตัวอย่าง: เจ้แอน สั่ง โค้ก 30 จำนวน 5\n\n`;

  msg += `💰 **จ่ายเงิน**\n`;
  msg += `• "จ่าย" = จ่ายออเดอร์ล่าสุด\n`;
  msg += `• "จ่าย #123" = จ่ายออเดอร์เลขที่ 123\n\n`;

  msg += `🚚 **จัดส่ง**\n`;
  msg += `• "ส่ง พี่แดง" = ผู้ส่งของออเดอร์ล่าสุด\n`;
  msg += `• "ส่ง #123 พี่แดง" = ระบุเลขออเดอร์\n\n`;

  if (isAdmin) {
    msg += `📦 **จัดการสต็อก**\n`;
    msg += `• "[สินค้า] มี [จำนวน]"\n`;
    msg += `• "เติม [สินค้า] [จำนวน]"\n`;
    msg += `• "ลด [สินค้า] [จำนวน]"\n\n`;
  }

  msg += `❌ **ยกเลิกออเดอร์**\n`;
  msg += `• "ยกเลิก" = ยกเลิกออเดอร์ล่าสุด\n`;
  msg += `• "ยกเลิก #123" = ยกเลิกเลขที่ 123\n\n`;

  if (isAdmin) {
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `👑 **คำสั่งแอดมิน**\n\n`;
    msg += `📊 "สรุป" - สรุปยอดขายวันนี้\n`;
    msg += `📝 "inbox" - ดูประวัติการสนทนา\n`;
    msg += `🔄 "รีเฟรช" - โหลดข้อมูลใหม่\n`;
    msg += `💳 "เครดิต" - รายงานเครดิต\n`;
  }

  return msg;
}

function getCannotParseMessage() {
  return "❌ ไม่เข้าใจคำสั่ง\n\n💡 พิมพ์ \"help\" เพื่อดูคู่มือ\n\n" +
    "หรือลองรูปแบบนี้:\n" +
    "• สั่งสินค้า: \"[ร้าน] สั่ง [สินค้า] [ราคา] [จำนวน]\"\n" +
    "• ปรับสต็อก: \"[สินค้า] มี/เหลือ [จำนวน]\"\n" +
    "• จ่ายเงิน: \"จ่าย\" หรือ \"จ่าย #123\"";
}

function formatDisambiguationMessage(result) {
  let msg = `🤔 พบสินค้าหลายรายการ กรุณาระบุให้ชัดเจน\n\n`;

  if (result.ambiguousItems && result.ambiguousItems.length > 0) {
    result.ambiguousItems.forEach(ambig => {
      msg += `📦 "${ambig.keyword}" มี ${ambig.possibleMatches.length} แบบ:\n\n`;

      ambig.possibleMatches.forEach((match, idx) => {
        msg += `${idx + 1}. ${match.item}\n`;
        msg += `   💰 ${match.price}฿ │ 📦 ${match.stock} ${match.unit}\n\n`;
      });

      msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    });

    msg += `💡 วิธีสั่ง:\n`;
    msg += `พิมพ์: "${result.customer || 'ชื่อร้าน'} สั่ง [ชื่อสินค้า] [ราคา] จำนวน [จำนวน]"\n\n`;

    if (result.ambiguousItems[0]) {
      const first = result.ambiguousItems[0].possibleMatches[0];
      const qty = result.ambiguousItems[0].quantity || 1;
      msg += `ตัวอย่าง:\n`;
      msg += `"${result.customer || 'เจ้แอน'} สั่ง ${first.item} ${first.price} จำนวน ${qty}"`;
    }
  }

  return msg;
}

function formatOrderSuccess(orderNo, customer, items, totalAmount, confidence, wasAuto = false) {
  const summary = items.map(i => {
    const itemName = i.productName || i.stockItem?.item || 'สินค้า';
    const newStock = i.newStock !== undefined ? i.newStock : 0;

    let stockIcon = '✅';
    if (newStock <= 3) stockIcon = '🔴';
    else if (newStock <= 10) stockIcon = '🟡';

    return `${stockIcon} ${itemName} x${i.quantity} (${newStock} เหลือ)`;
  }).join('\n');

  let msg = wasAuto ? `⚡ Auto-Approved!\n\n` : `✅ บันทึกออเดอร์สำเร็จ!\n\n`;
  msg += `📋 คำสั่งซื้อ #${orderNo}\n`;
  msg += `👤 ${customer}\n\n`;
  msg += `${summary}\n\n`;
  msg += `💰 รวม: ${totalAmount.toLocaleString()}฿\n`;
  msg += `🎯 ความมั่นใจ: ${confidence}\n`;

  if (wasAuto) {
    msg += `🤖 ระบบ Auto-Process\n`;
  }

  msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `⚡ Quick Actions:\n`;
  msg += `• "จ่าย" - จ่ายออเดอร์นี้\n`;
  msg += `• "ส่ง พี่แดง" - อัปเดตการจัดส่ง\n`;
  msg += `• "ยกเลิก" - ยกเลิกออเดอร์`;

  return msg;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  handleMessage,
  handlePaymentUpdate,
  handleDeliveryUpdate,
  executeOrderLogic
};