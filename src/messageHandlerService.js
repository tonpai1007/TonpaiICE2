// messageHandlerService.js - ENHANCED: Better UX for cancel, inbox, dashboard
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
// ENHANCED MESSAGE FORMATTERS
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
         `• "จ่าย" - จ่ายออเดอร์นี้\n` +
         `• "ส่ง พี่แดง" - อัปเดตการจัดส่ง\n` +
         `• "ยกเลิก" - ยกเลิกออเดอร์นี้`;
}

function formatPaymentSuccess(orderNo, customer, totalAmount) {
  return `✅ อัปเดตการชำระเงินสำเร็จ\n\n` +
         `📋 #${orderNo} | ${customer}\n` +
         `💰 ${totalAmount.toLocaleString()}฿\n\n` +
         `━━━━━━━━━━━━━━━━━━━━\n` +
         `⚡ Next Actions:\n` +
         `• "ส่ง พี่แดง" - อัปเดตการจัดส่ง\n` +
         `• "สรุป" - ดูยอดขายวันนี้`;
}

function formatCancelSuccess(orderNo, customer, stockRestored) {
  const restoredList = stockRestored
    .map(s => `   ${s.item} +${s.restored} → ${s.newStock} ${s.unit || 'ชิ้น'}`)
    .join('\n');
  
  return `✅ ยกเลิกออเดอร์สำเร็จ\n\n` +
         `📋 ออเดอร์ #${orderNo}\n` +
         `👤 ${customer}\n\n` +
         `📦 คืนสต็อก:\n${restoredList}\n\n` +
         `━━━━━━━━━━━━━━━━━━━━\n` +
         `✨ สต็อกถูกคืนกลับเรียบร้อยแล้ว`;
}

function formatError(errorType, details = {}) {
  const errors = {
    'order_not_found': `❌ ไม่พบออเดอร์${details.orderNo ? ` #${details.orderNo}` : ''}\n\n` +
                       `━━━━━━━━━━━━━━━━━━━━\n` +
                       `💡 แก้ไข:\n` +
                       `• ตรวจสอบเลขออเดอร์\n` +
                       `• ออเดอร์อาจถูกยกเลิกไปแล้ว\n` +
                       `• พิมพ์ "inbox" เพื่อดูประวัติ`,
    
    'parse_failed': `❌ ไม่เข้าใจคำสั่ง\n\n` +
                    `"${details.input}"\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `💡 ตัวอย่างที่ถูกต้อง:\n` +
                    `• "น้ำแข็ง 2 ถุง ร้านเจ๊แดง"\n` +
                    `• "จ่าย" - จ่ายออเดอร์ล่าสุด\n` +
                    `• "เติมน้ำแข็ง 20"\n\n` +
                    `พิมพ์ "help" เพื่อดูคำสั่งทั้งหมด`
  };
  
  return errors[errorType] || `❌ เกิดข้อผิดพลาด\n\n${details.message || 'Unknown error'}`;
}

// ============================================================================
// GET LAST ORDER NUMBER (HELPER)
// ============================================================================

const { CONFIG } = require('./config');
const { getSheetData, updateSheetData } = require('./googleServices');

async function getLastOrderNumber() {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    if (rows.length <= 1) return null;
    
    // Get the most recent order number (last row)
    return rows[rows.length - 1][0];
  } catch (error) {
    Logger.error('getLastOrderNumber failed', error);
    return null;
  }
}

// ============================================================================
// MAIN MESSAGE HANDLER
// ============================================================================

async function handleMessage(text, userId) {
  try {
    const lower = text.toLowerCase().trim();

    // ========================================
    // STOCK ADJUSTMENT (Priority #1)
    // ========================================
    
    const adjCommand = await parseAdjustmentCommand(text);
    if (adjCommand.isAdjustment) {
      Logger.info(`🔧 Stock adjustment: ${adjCommand.operation} ${adjCommand.item} ${adjCommand.value}`);
      
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
    // PAYMENT COMMAND - Enhanced with "last order" support
    // ========================================
    
    const paymentMatch = text.match(/(?:จ่าย(?:เงิน|ตัง)?(?:แล้ว|เเล้ว)?)\s*(?:#?(\d+))?/i);
    if (paymentMatch && paymentMatch[0].length >= 3) {
      let orderNo = paymentMatch[1];
      
      if (!orderNo) {
        orderNo = await getLastOrderNumber();
        if (!orderNo) {
          return { 
            success: false, 
            message: '❌ ไม่มีออเดอร์ในระบบ\n\n💡 สร้างออเดอร์ก่อนนะ!' 
          };
        }
        Logger.info(`💡 Using last order: #${orderNo}`);
      }
      
      const result = await updateOrderPaymentStatus(orderNo, 'จ่ายแล้ว');

      if (result.success) {
        await saveToInbox(userId, text);
        return { 
          success: true, 
          message: formatPaymentSuccess(result.orderNo, result.customer, result.totalAmount)
        };
      } else {
        return { success: false, message: formatError('order_not_found', { orderNo }) };
      }
    }

    // ========================================
    // DELIVERY COMMAND - Enhanced
    // ========================================
    
    const deliveryMatch = text.match(/ส่ง\s*(?:#?(\d+))?\s*(.+)?/i);
    if (deliveryMatch && deliveryMatch[0].length >= 2) {
      let orderNo = deliveryMatch[1];
      const deliveryPerson = deliveryMatch[2]?.trim() || null;
      
      if (!deliveryPerson) {
        return {
          success: false,
          message: '❌ กรุณาระบุชื่อคนส่ง\n\n' +
                   '💡 ตัวอย่าง:\n' +
                   `• "ส่ง พี่แดง" - ส่งออเดอร์ล่าสุด\n` +
                   `• "ส่ง #123 พี่แดง" - ส่งออเดอร์ระบุ`
        };
      }
      
      if (!orderNo) {
        orderNo = await getLastOrderNumber();
        if (!orderNo) {
          return { 
            success: false, 
            message: '❌ ไม่มีออเดอร์ในระบบ' 
          };
        }
        Logger.info(`💡 Using last order: #${orderNo}`);
      }
      
      const result = await updateDeliveryPerson(orderNo, deliveryPerson);

      if (result.success) {
        await saveToInbox(userId, text);
        
        let msg = `✅ บันทึกการจัดส่งสำเร็จ\n\n`;
        msg += `📋 ออเดอร์ #${orderNo}\n`;
        msg += `👤 ลูกค้า: ${result.customer}\n`;
        msg += `🚚 ส่งโดย: ${deliveryPerson}\n`;
        msg += `💰 จำนวนเงิน: ${result.totalAmount?.toLocaleString() || 0}฿\n\n`;
        
        if (result.paymentStatus !== 'จ่ายแล้ว') {
          msg += `⚠️ ยังไม่ได้รับเงิน\n💡 พิมพ์ "จ่าย" เมื่อรับเงินแล้ว`;
        } else {
          msg += `✅ รับเงินแล้ว`;
        }
        
        return { success: true, message: msg };
      } else {
        return { success: false, message: formatError('order_not_found', { orderNo }) };
      }
    }

    // ========================================
    // CANCEL COMMAND - ENHANCED: Support "ยกเลิก" without number
    // ========================================
    
    const cancelMatch = text.match(/ยกเลิก\s*(?:#?(\d+))?/i);
    if (cancelMatch) {
      let orderNo = cancelMatch[1];
      
      // If no order number specified, use last order
      if (!orderNo) {
        orderNo = await getLastOrderNumber();
        if (!orderNo) {
          return { 
            success: false, 
            message: '❌ ไม่มีออเดอร์ในระบบ\n\n💡 สร้างออเดอร์ก่อนนะ!' 
          };
        }
        Logger.info(`💡 Cancelling last order: #${orderNo}`);
      }
      
      const result = await cancelOrder(orderNo);

      if (result.success) {
        await saveToInbox(userId, text);
        monitor.recordCancellation(orderNo, true);
        return { 
          success: true, 
          message: formatCancelSuccess(orderNo, result.customer, result.stockRestored) 
        };
      } else {
        return { success: false, message: formatError('order_not_found', { orderNo }) };
      }
    }

    // ========================================
    // VIEW DELIVERY STATUS
    // ========================================
    
    if (lower.includes('สถานะ') || lower.includes('ดูการส่ง')) {
      const deliveryStatus = await viewDeliveryStatus();
      return { success: true, message: deliveryStatus };
    }

    // ========================================
    // ENHANCED SYSTEM COMMANDS
    // ========================================
    
    if (lower === 'สรุป' || lower.includes('สรุปวันนี้') || lower === 'summary') {
      const summary = await generateDailySummary();
      return { success: true, message: summary };
    }

    if (lower === 'inbox' || lower.includes('ดูinbox') || lower.includes('ประวัติ')) {
      const inboxSummary = await generateInboxSummary(20); // Show more items
      return { success: true, message: inboxSummary };
    }

    if (lower === 'help' || lower === 'ช่วยเหลือ' || lower === '?') {
      return { 
        success: true, 
        message: `🤖 คำสั่งที่ใช้ได้\n` +
                `${'='.repeat(35)}\n\n` +
                `📦 รับออเดอร์:\n` +
                `• "น้ำแข็ง 5 ถุง ร้านเจ๊แดง"\n` +
                `• "ลูกค้า: พี่ไก่, น้ำแข็ง 3"\n\n` +
                `💰 การเงิน:\n` +
                `• "จ่าย" - จ่ายออเดอร์ล่าสุด\n` +
                `• "จ่าย #123" - จ่ายออเดอร์ระบุ\n\n` +
                `🚚 การส่ง:\n` +
                `• "ส่ง พี่แดง" - ส่งออเดอร์ล่าสุด\n` +
                `• "ส่ง #123 พี่แดง" - ส่งออเดอร์ระบุ\n` +
                `• "สถานะ" - ดูสถานะการส่ง\n\n` +
                `❌ ยกเลิกออเดอร์:\n` +
                `• "ยกเลิก" - ยกเลิกออเดอร์ล่าสุด\n` +
                `• "ยกเลิก #123" - ยกเลิกออเดอร์ระบุ\n\n` +
                `🔧 จัดการสต็อก:\n` +
                `• "น้ำแข็ง มี 50" - ตั้งค่าสต็อก\n` +
                `• "เติมน้ำแข็ง 20" - เพิ่มสต็อก\n` +
                `• "ลดน้ำแข็ง 10" - ลดสต็อก\n` +
                `• "สต็อก" - ดูสต็อกทั้งหมด\n\n` +
                `📊 รายงาน:\n` +
                `• "สรุป" - สรุปยอดขายวันนี้\n` +
                `• "inbox" - ดูประวัติคำสั่ง\n` +
                `• "รายงานสต็อก" - ดูการปรับสต็อก\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                `💡 TIP: คำสั่งส่วนใหญ่ทำงานกับ\n` +
                `    ออเดอร์ล่าสุดถ้าไม่ระบุเลข!`
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
      return { success: true, message: '✅ รีเฟรชข้อมูลสำเร็จ\n\n💡 ข้อมูลสต็อกและลูกค้าอัปเดตแล้ว' };
    }

    // ========================================
    // ORDER PROCESSING (Last resort)
    // ========================================
    
    await saveToInbox(userId, text, 'order_attempt');
    await smartLearner.loadOrderHistory();
    
    const parsed = await parseOrder(text);
    
    if (!parsed.success || !parsed.items || parsed.items.length === 0) {
      return await handleUnparseableOrder(text, parsed, userId);
    }

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

    return await processWithAutomationRules(parsed, userId);

  } catch (error) {
    Logger.error('handleMessage error', error);
    await saveToInbox(userId, text, 'error');
    return { 
      success: false, 
      message: '❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้ง\n\n' +
               `💡 ถ้าปัญหายังคงอยู่ พิมพ์ "help" เพื่อดูคำสั่งที่ถูกต้อง`
    };
  }
}

// ============================================================================
// UPDATE DELIVERY PERSON
// ============================================================================

async function updateDeliveryPerson(orderNo, deliveryPerson) {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    const orderRows = [];
    let customer = '';
    let totalAmount = 0;
    let paymentStatus = '';
    
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] == orderNo) {
        orderRows.push({ index: i + 1, data: rows[i] });
        customer = rows[i][2];
        totalAmount += parseFloat(rows[i][8] || 0);
        paymentStatus = rows[i][7];
      }
    }

    if (orderRows.length === 0) {
      return { success: false, error: `ไม่พบออเดอร์ #${orderNo}` };
    }

    for (const orderRow of orderRows) {
      await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!G${orderRow.index}`, [[deliveryPerson]]);
    }
    
    Logger.success(`🚚 Delivery updated: #${orderNo} → ${deliveryPerson}`);

    return {
      success: true,
      orderNo,
      customer,
      deliveryPerson,
      totalAmount,
      paymentStatus
    };
  } catch (error) {
    Logger.error('updateDeliveryPerson failed', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// VIEW DELIVERY STATUS
// ============================================================================

async function viewDeliveryStatus() {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    
    if (rows.length <= 1) {
      return '📦 ไม่มีออเดอร์ในระบบ';
    }

    const orders = new Map();
    
    for (let i = 1; i < rows.length; i++) {
      const orderNo = rows[i][0];
      const customer = rows[i][2];
      const deliveryPerson = rows[i][6] || '';
      const paymentStatus = rows[i][7];
      const amount = parseFloat(rows[i][8] || 0);
      
      if (!orders.has(orderNo)) {
        orders.set(orderNo, {
          orderNo,
          customer,
          deliveryPerson,
          paymentStatus,
          totalAmount: 0,
          itemCount: 0
        });
      }
      
      const order = orders.get(orderNo);
      order.totalAmount += amount;
      order.itemCount++;
    }

    const delivered = [];
    const pending = [];
    
    orders.forEach(order => {
      if (order.deliveryPerson) {
        delivered.push(order);
      } else {
        pending.push(order);
      }
    });

    let msg = `📦 สถานะการจัดส่ง\n${'='.repeat(40)}\n\n`;
    
    if (pending.length > 0) {
      msg += `⏳ รอจัดส่ง (${pending.length} ออเดอร์):\n\n`;
      pending.slice(0, 10).forEach(order => {
        const payIcon = order.paymentStatus === 'จ่ายแล้ว' ? '💰' : '⏳';
        msg += `${payIcon} #${order.orderNo} │ ${order.customer}\n`;
        msg += `   ${order.totalAmount.toLocaleString()}฿ │ ${order.itemCount} รายการ\n\n`;
      });
      
      if (pending.length > 10) {
        msg += `   ... และอีก ${pending.length - 10} ออเดอร์\n\n`;
      }
    }

    if (delivered.length > 0) {
      msg += `✅ ส่งแล้ว (${delivered.length} ออเดอร์ล่าสุด):\n\n`;
      delivered.slice(-5).reverse().forEach(order => {
        const payIcon = order.paymentStatus === 'จ่ายแล้ว' ? '💰' : '⏳';
        msg += `${payIcon} #${order.orderNo} │ ${order.customer}\n`;
        msg += `   🚚 ${order.deliveryPerson} │ ${order.totalAmount.toLocaleString()}฿\n\n`;
      });
    }

    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 สรุป: ${pending.length} รอส่ง │ ${delivered.length} ส่งแล้ว\n\n`;
    msg += `💡 พิมพ์ "ส่ง พี่แดง" เพื่ออัปเดตออเดอร์ล่าสุด`;

    return msg;

  } catch (error) {
    Logger.error('viewDeliveryStatus failed', error);
    return `❌ ไม่สามารถดูสถานะได้: ${error.message}`;
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
    await saveToInbox(userId, `Order #${result.orderNo}: ${customer}`, 'order_success');
    
    const msg = formatOrderSuccess(
      result.orderNo,
      result.customer,
      result.items,
      result.totalAmount,
      confidence
    );
    
    let finalMsg = msg;
    if (successMessage) {
      finalMsg = `🎯 ${successMessage}\n\n` + msg;
    }
    
    if (stockCheck.hasWarnings) {
      const warnings = stockCheck.warnings.map(w => w.message).join('\n');
      finalMsg += '\n\n━━━━━━━━━━━━━━━━━━━━\n⚠️ แจ้งเตือนสต็อก:\n' + warnings;
    }

    Logger.success(`✅ Direct order created: #${result.orderNo}`);
    return { success: true, message: finalMsg };
  } else {
    return { 
      success: false, 
      message: `❌ ไม่สามารถสร้างออเดอร์ได้\n\n${result.error}\n\n💡 พิมพ์ "สต็อก" เพื่อดูสต็อกปัจจุบัน`
    };
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
        finalMsg += '\n\n━━━━━━━━━━━━━━━━━━━━\n⚠️ แจ้งเตือนสต็อก:\n' + warnings;
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
  updateDeliveryPerson,
  viewDeliveryStatus
};
