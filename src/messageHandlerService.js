// messageHandlerService.js - Unified handler for both text and voice messages
const { Logger } = require('./logger');
const { parseOrder } = require('./orderParser');
const { createOrderTransaction, updateOrderPaymentStatus } = require('./orderService');
const { parseAdjustmentCommand, adjustStock, generateVarianceReport, viewCurrentStock } = require('./stockAdjustment');
const { autoAddCustomer } = require('./customerService');
const { applySmartCorrection, shouldAutoProcess, monitor } = require('./aggressiveAutoConfig');
const { smartLearner } = require('./smartOrderLearning');
const { saveToInbox, cancelOrder } = require('./inboxService');
const { generateDailySummary, generateInboxSummary } = require('./dashboardService');
const { loadStockCache, loadCustomerCache } = require('./cacheManager');

// ============================================================================
// STOCK WARNING HELPERS
// ============================================================================

function checkStockWarnings(items) {
  const warnings = [];
  const criticalItems = [];
  
  items.forEach(item => {
    const remaining = item.stockItem.stock - item.quantity;
    
    if (remaining < 0) {
      warnings.push({
        level: 'critical',
        message: `⚠️ สต็อกไม่พอ!\n${item.stockItem.item}: มี ${item.stockItem.stock} เหลือ (สั่ง ${item.quantity})`,
        canProceed: false
      });
      criticalItems.push(item.stockItem.item);
    } else if (remaining <= 3) {
      warnings.push({
        level: 'critical',
        message: `⚠️ สต็อกเหลือน้อยมาก!\n${item.stockItem.item}: จะเหลือ ${remaining} ${item.stockItem.unit}`,
        canProceed: true
      });
    } else if (remaining <= 10) {
      warnings.push({
        level: 'warning',
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

// ============================================================================
// MESSAGE FORMATTERS
// ============================================================================

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

// ============================================================================
// DELIVERY STATUS UPDATE (from app.js)
// ============================================================================

const { CONFIG } = require('./config');
const { getSheetData, updateSheetData } = require('./googleServices');

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
    
    await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!E${rowIndex}`, [[status]]);
    
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

// ============================================================================
// MAIN MESSAGE HANDLER - Handles both text and voice
// ============================================================================

async function handleMessage(text, userId) {
  try {
    const lower = text.toLowerCase().trim();

    // ========================================
    // SPECIAL COMMANDS (Quick actions)
    // ========================================
    
    // Payment command
    const paymentMatch = text.match(/(?:จ่าย(?:เงิน|ตัง|แล้ว)?)\s*#?(\d+)/i);
    if (paymentMatch) {
      const orderNo = paymentMatch[1];
      const result = await updateOrderPaymentStatus(orderNo, 'จ่ายแล้ว');

      if (result.success) {
        await saveToInbox(userId, text);
        return { success: true, message: formatPaymentSuccess(orderNo, result.customer, result.totalAmount) };
      } else {
        return { success: false, message: formatError('order_not_found', { orderNo }) };
      }
    }

    // Delivery command
    const deliveryMatch = text.match(/ส่ง\s*#?(\d+)(?:\s+(.+))?/i);
    if (deliveryMatch) {
      const orderNo = deliveryMatch[1];
      const deliveryPerson = deliveryMatch[2]?.trim() || null;
      
      const result = await updateDeliveryStatus(orderNo, 'กำลังจัดส่ง', deliveryPerson);

      if (result.success) {
        await saveToInbox(userId, text);
        return { success: true, message: formatDeliveryStatus(result) };
      } else {
        return { success: false, message: formatError('order_not_found', { orderNo }) };
      }
    }

    // Cancel command
    const cancelMatch = text.match(/ยกเลิก\s*#?(\d+)/i);
    if (cancelMatch) {
      const orderNo = cancelMatch[1];
      const result = await cancelOrder(orderNo);

      if (result.success) {
        await saveToInbox(userId, text);
        monitor.recordCancellation(orderNo, true);
        return { success: true, message: formatCancelSuccess(orderNo, result.customer, result.stockRestored) };
      } else {
        return { success: false, message: formatError('order_not_found', { orderNo }) };
      }
    }

    // Stock adjustment
    const adjCommand = await parseAdjustmentCommand(text);
    if (adjCommand.isAdjustment) {
      const result = await adjustStock(
        adjCommand.item,
        adjCommand.value,
        adjCommand.operation,
        'manual_adjustment'
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
        
        await saveToInbox(userId, text);
        return { success: true, message: msg };
      } else {
        return { success: false, message: result.error };
      }
    }

    // ========================================
    // SYSTEM COMMANDS
    // ========================================
    
    if (lower === 'สรุป' || lower.includes('สรุปวันนี้') || lower === 'summary') {
      const summary = await generateDailySummary();
      return { success: true, message: summary };
    }

    if (lower === 'inbox' || lower.includes('ดูinbox')) {
      const inboxSummary = await generateInboxSummary(15);
      return { success: true, message: inboxSummary };
    }

    if (lower === 'help' || lower === 'ช่วยเหลือ') {
      return { 
        success: true, 
        message: `🤖 คำสั่งที่ใช้ได้\n` +
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
                `• "สรุป" - สรุปยอดขายวันนี้\n\n` +
                `⚙️ อื่นๆ:\n` +
                `• "ยกเลิก #123" - ยกเลิกออเดอร์\n` +
                `• "รีเฟรช" - โหลดข้อมูลใหม่\n\n` +
                `💡 Tip: ใช้เสียงจะแม่นและเร็วกว่า!`
      };
    }

    if (lower.includes('สต็อก') && !lower.includes('รายงาน')) {
      const searchTerm = text.replace(/สต็อก|ดู/gi, '').trim();
      const stockList = await viewCurrentStock(searchTerm || null);
      return { success: true, message: stockList };
    }

    if (lower.includes('รายงานสต็อก')) {
      const report = await generateVarianceReport('today');
      return { success: true, message: report };
    }

    if (lower === 'รีเฟรช' || lower === 'refresh') {
      await loadStockCache(true);
      await loadCustomerCache(true);
      return { success: true, message: '✅ รีเฟรชข้อมูลสำเร็จ\n\nโหลดสต็อกและลูกค้าใหม่แล้ว' };
    }

    // ========================================
    // ORDER PROCESSING (Main flow)
    // ========================================
    
    await saveToInbox(userId, text, 'order_attempt');
    
    // Load smart learning
    await smartLearner.loadOrderHistory();
    
    // Parse order
    const parsed = await parseOrder(text);
    
    if (!parsed.success || !parsed.items || parsed.items.length === 0) {
      return await handleUnparseableOrder(text, parsed, userId);
    }

    // Check for exact repeat order
    if (parsed.customer && parsed.customer !== 'ไม่ระบุ') {
      const exactMatch = smartLearner.findExactOrderMatch(parsed.customer, parsed.items);
      
      if (exactMatch) {
        Logger.success(`🎯 EXACT REPEAT ORDER: ${exactMatch.customer}`);
        return await createOrderDirectly(
          exactMatch.customer,
          parsed.items,
          'high',
          exactMatch.message,
          userId
        );
      }

      // Check smart learning prediction
      const prediction = smartLearner.predictOrder(parsed.customer, parsed.items);
      
      if (prediction.success && prediction.confidence === 'high' && prediction.matchRate >= 0.8) {
        Logger.success(`🧠 HIGH CONFIDENCE from history: ${(prediction.matchRate * 100).toFixed(0)}%`);
        return await createOrderDirectly(
          prediction.customer,
          parsed.items,
          'high',
          prediction.message,
          userId
        );
      }
    }

    // Apply automation rules
    return await processWithAutomationRules(parsed, userId);

  } catch (error) {
    Logger.error('handleMessage error', error);
    await saveToInbox(userId, text, 'error');
    return { success: false, message: '❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้ง' };
  }
}

// ============================================================================
// ORDER PROCESSING HELPERS
// ============================================================================

async function createOrderDirectly(customer, items, confidence, successMessage, userId) {
  const stockCheck = checkStockWarnings(items);
  
  if (stockCheck.hasCritical) {
    return { success: false, message: formatStockWarnings(stockCheck) };
  }

  if (customer && customer !== 'ไม่ระบุ') {
    await autoAddCustomer(customer);
  }

  const result = await createOrderTransaction({
    customer,
    items,
    paymentStatus: 'unpaid'
  });

  if (result.success) {
    let msg = `✅ บันทึกออเดอร์สำเร็จ!\n\n`;
    if (successMessage) {
      msg += `🎯 ${successMessage}\n\n`;
    }
    msg += `📋 คำสั่งซื้อ #${result.orderNo}\n`;
    msg += `👤 ${result.customer}\n`;
    msg += `💰 รวม: ${result.totalAmount.toLocaleString()}฿\n\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `⚡ Quick Actions:\n`;
    msg += `• "จ่าย #${result.orderNo}" - จ่ายเงิน\n`;
    msg += `• "ส่ง #${result.orderNo}" - อัปเดตการจัดส่ง`;

    if (stockCheck.hasWarnings) {
      msg += `\n\n⚠️ แจ้งเตือนสต็อก:\n${stockCheck.warnings.map(w => w.message).join('\n')}`;
    }

    Logger.success(`✅ Direct order created: #${result.orderNo}`);
    return { success: true, message: msg };
  } else {
    return { success: false, message: `❌ ไม่สามารถสร้างออเดอร์ได้\n\n${result.error}` };
  }
}

async function processWithAutomationRules(parsed, userId) {
  const corrected = applySmartCorrection(parsed);
  const stockCheck = checkStockWarnings(corrected.items);
  
  if (stockCheck.hasCritical) {
    await saveToInbox(userId, parsed.rawInput || '', 'insufficient_stock');
    return { success: false, message: formatStockWarnings(stockCheck) };
  }

  const orderValue = corrected.items.reduce((sum, item) => 
    sum + (item.quantity * item.stockItem.price), 0
  );

  const decision = shouldAutoProcess(corrected, orderValue);

  if (decision.shouldAuto) {
    if (corrected.customer && corrected.customer !== 'ไม่ระบุ') {
      await autoAddCustomer(corrected.customer);
    }
    
    const result = await createOrderTransaction({
      customer: corrected.customer,
      items: corrected.items,
      paymentStatus: corrected.paymentStatus || 'unpaid'
    });

    if (result.success) {
      await saveToInbox(userId, parsed.rawInput || '', 'order_auto_success');
      
      const msg = formatOrderSuccess(
        result.orderNo,
        result.customer,
        result.items,
        result.totalAmount,
        corrected.confidence
      );
      
      let finalMsg = msg;
      if (stockCheck.hasWarnings) {
        const warnings = stockCheck.warnings.map(w => w.message).join('\n');
        finalMsg += '\n\n━━━━━━━━━━━━━━━━━━━━\n' + warnings;
      }
      
      monitor.recordDecision(decision, result.orderNo);
      Logger.success(`✅ Auto-processed order: #${result.orderNo}`);
      
      return { success: true, message: finalMsg };
    } else {
      await saveToInbox(userId, parsed.rawInput || '', 'order_auto_failed');
      return { 
        success: false, 
        message: `❌ ไม่สามารถสร้างออเดอร์ได้\n\n${result.error}\n\n💡 พิมพ์ "สต็อก" เพื่อดูสต็อกปัจจุบัน`
      };
    }
  } else {
    // Manual review needed
    const guess = corrected.items.map(i => `${i.stockItem.item} x${i.quantity}`).join(', ');
    await saveToInbox(userId, parsed.rawInput || '', 'pending_review');
    
    monitor.recordDecision(decision, 'pending');
    
    return { 
      success: true, 
      message: `📝 รับคำสั่งแล้ว (รอตรวจสอบ)\n\n"${parsed.rawInput}"\n\n` +
              `🤖 ระบบเดา:\n• ลูกค้า: ${corrected.customer}\n• สินค้า: ${guess}\n` +
              `• ยอดรวม: ${orderValue.toLocaleString()}฿\n\n⚠️ เหตุผล: ${decision.reason}\n` +
              `💡 แอดมินจะตรวจสอบและบันทึกให้`
    };
  }
}

async function handleUnparseableOrder(text, parsed, userId) {
  // If customer detected but no items
  if (parsed.customer && parsed.customer !== 'ไม่ระบุ') {
    const prediction = smartLearner.predictOrder(parsed.customer, []);
    
    if (prediction.success && prediction.suggestedItems && prediction.suggestedItems.length > 0) {
      const suggestions = prediction.suggestedItems
        .map(s => `${s.name} (มักสั่ง ${s.avgQuantity})`)
        .join('\n• ');

      return { 
        success: true, 
        message: `💡 รู้จัก "${prediction.customer}"!\n\n` +
                `${prediction.customer} มักสั่ง:\n• ${suggestions}\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 กรุณาระบุสินค้าที่ต้องการ:\n` +
                `ตัวอย่าง: "เอา${prediction.suggestedItems[0].name} ${prediction.suggestedItems[0].avgQuantity}"\n\n` +
                `✅ บันทึกไว้ใน Inbox แล้ว`
      };
    }
  }

  // Complete failure
  await saveToInbox(userId, text, 'unknown_command');
  Logger.warn(`📥 Unparseable: "${text}"`);
  
  return { 
    success: false, 
    message: formatError('parse_failed', { input: text })
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  handleMessage,
  updateDeliveryStatus
};
