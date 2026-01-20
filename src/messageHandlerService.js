// messageHandlerService.js - FIXED: Complete integration
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

// ============================================================================
// FORMAT MESSAGES
// ============================================================================

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
    msg += `ตัวอย่าง:\n`;
    
    if (result.ambiguousItems[0]) {
      const first = result.ambiguousItems[0].possibleMatches[0];
      const qty = result.ambiguousItems[0].quantity || 1;
      msg += `"${result.customer || 'เจ้แอน'} สั่ง ${first.item} ${first.price} จำนวน ${qty}"\n\n`;
    }
    
    msg += `พิมพ์ "help" สำหรับคู่มือฉบับเต็ม`;
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
  msg += `• "ยกเลิก" - ยกเลิกออเดอร์\n\n`;
  msg += `พิมพ์ "help" ดูคำสั่งทั้งหมด`;
  
  return msg;
}

function formatStockAdjustmentSuccess(result) {
  const icon = result.difference > 0 ? '📈' : result.difference < 0 ? '📉' : '➖';
  
  let msg = `${icon} ปรับสต็อกสำเร็จ!\n\n`;
  msg += `📦 ${result.item}\n`;
  msg += `💰 ${result.price}฿\n\n`;
  msg += `📊 ${result.oldStock} → ${result.newStock} ${result.unit}\n`;
  msg += `${result.difference >= 0 ? '+' : ''}${result.difference}\n\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `✅ ${result.operationText}`;
  
  if (result.newStock <= 5) {
    msg += `\n\n⚠️ แจ้งเตือน: สต็อกเหลือน้อย!`;
  }
  
  msg += `\n\nพิมพ์ "help" ดูคำสั่งทั้งหมด`;
  
  return msg;
}

function getHelpMessage(userId) {
  const { AccessControl } = require('./accessControl');
  const isAdmin = AccessControl.isAdmin(userId);
  
  let msg = `💡 คู่มือการใช้งาน Order Bot\n${'='.repeat(40)}\n\n`;
  
  msg += `🛒 **สั่งสินค้า**\n`;
  msg += `• [ร้าน] สั่ง [สินค้า] [ราคา] จำนวน [จำนวน]\n`;
  msg += `  ตัวอย่าง: เจ้แอน สั่ง น้ำแข็งหลอด 60 จำนวน 2\n\n`;
  
  msg += `💰 **จ่ายเงิน**\n`;
  msg += `• "จ่าย" = จ่ายออเดอร์ล่าสุด\n`;
  msg += `• "จ่าย #123" = จ่ายออเดอร์เลขที่ 123\n\n`;
  
  msg += `🚚 **จัดส่ง**\n`;
  msg += `• "ส่ง พี่แดง" = ผู้ส่งของออเดอร์ล่าสุด\n`;
  msg += `• "ส่ง #123 พี่แดง" = ระบุเลขออเดอร์\n\n`;
  
  if (isAdmin) {
    msg += `📦 **จัดการสต็อก**\n`;
    msg += `• "เติม [สินค้า] [ราคา] [จำนวน]"\n`;
    msg += `• "มี [สินค้า] [ราคา] [จำนวน]"\n`;
    msg += `• "ลด [สินค้า] [ราคา] [จำนวน]"\n\n`;
  }
  
  msg += `❌ **ยกเลิกออเดอร์**\n`;
  msg += `• "ยกเลิก" = ยกเลิกออเดอร์ล่าสุด\n`;
  msg += `• "ยกเลิก #123" = ยกเลิกเลขที่ 123\n\n`;
  
  if (isAdmin) {
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `👑 **คำสั่งแอดมิน**\n\n`;
    msg += `📊 "สรุป" - สรุปยอดขายวันนี้\n`;
    msg += `📝 "inbox" - ดูประวัติการสนทนา\n`;
    msg += `💳 "เครดิต" - รายงานเครดิตค้าง\n`;
    msg += `🔄 "รีเฟรช" - โหลดข้อมูลใหม่\n\n`;
  }
  
  return msg;
}

// ============================================================================
// UPDATE DELIVERY PERSON (NEW FUNCTION)
// ============================================================================

async function updateDeliveryPerson(orderNo, deliveryPerson) {
  try {
    const { getSheetData, updateSheetData } = require('./googleServices');
    const { CONFIG } = require('./config');
    
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
      return { success: false, error: `ไม่พบออเดอร์ #${orderNo}` };
    }

    // Update delivery person (Column G)
    for (const orderRow of orderRows) {
      await updateSheetData(CONFIG.SHEET_ID, `คำสั่งซื้อ!G${orderRow.index}`, [[deliveryPerson]]);
    }
    
    Logger.success(`🚚 Delivery updated: #${orderNo} → ${deliveryPerson}`);

    return {
      success: true,
      orderNo,
      customer,
      deliveryPerson
    };
  } catch (error) {
    Logger.error('updateDeliveryPerson failed', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// MAIN MESSAGE HANDLER (FIXED)
// ============================================================================

async function handleMessage(text, userId) {
  try {
    const lower = text.toLowerCase().trim();

    // Save to inbox
    const { saveToInbox } = require('./inboxService');
    await saveToInbox(userId, text);

    // ========================================================================
    // WELCOME MESSAGE
    // ========================================================================
    
    if (lower === 'start' || lower === 'เริ่ม' || lower === 'hello' || lower === 'สวัสดี') {
      const { AccessControl } = require('./accessControl');
      const isAdmin = AccessControl.isAdmin(userId);
      
      let welcome = `👋 ยินดีต้อนรับสู่ Order Bot!\n${'='.repeat(40)}\n\n`;
      
      if (isAdmin) {
        welcome += `🎉 คุณเป็น **Admin**\n\n`;
        welcome += `✨ ความสามารถ:\n`;
        welcome += `• สั่งสินค้า & จัดการออเดอร์\n`;
        welcome += `• จัดการสต็อก (เติม/ลด)\n`;
        welcome += `• ดูรายงานยอดขาย\n`;
        welcome += `• อัปเดตการชำระเงิน & จัดส่ง\n\n`;
      } else {
        welcome += `📦 คุณสามารถ:\n`;
        welcome += `• สั่งสินค้า\n`;
        welcome += `• ตรวจสอบสถานะออเดอร์\n\n`;
      }
      
      welcome += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      welcome += `💡 พิมพ์ "help" เพื่อดูคู่มือการใช้งาน\n\n`;
      welcome += `ตัวอย่างคำสั่งง่ายๆ:\n`;
      welcome += `• "เจ้แอน สั่ง โค้ก 30 จำนวน 5"\n`;
      welcome += `• "จ่าย" (จ่ายออเดอร์ล่าสุด)\n`;
      welcome += `• "ส่ง พี่แดง" (อัปเดตผู้ส่งของ)`;
      
      return { success: true, message: welcome };
    }

    // ========================================================================
    // HELP COMMAND
    // ========================================================================
    
    if (lower === 'help' || lower === 'ช่วย' || lower === 'สอน') {
      return { success: true, message: getHelpMessage(userId) };
    }

    // ========================================================================
    // BUSINESS COMMANDS (Must check before other processing)
    // ========================================================================
    
    const businessResult = await handleBusinessCommand(text, userId);
    if (businessResult && businessResult.success) {
      return businessResult;
    }

    // ========================================================================
    // ADMIN QUICK COMMANDS
    // ========================================================================
    
    if (lower === 'สรุป' || lower.includes('สรุปวันนี้')) {
      const summary = await generateDailySummary();
      return { success: true, message: summary };
    }
    
    if (lower === 'inbox' || lower.includes('ประวัติ')) {
      const { generateInboxSummary } = require('./inboxService');
      const inbox = await generateInboxSummary(50);
      return { success: true, message: inbox };
    }
    
    if (lower === 'รีเฟรช') {
      await loadStockCache(true);
      await loadCustomerCache(true);
      await smartLearner.loadOrderHistory();
      return { success: true, message: '✅ รีเฟรชข้อมูลสำเร็จ' };
    }

    // ========================================================================
    // PAYMENT UPDATE (Simple shortcut)
    // ========================================================================
    
    if (lower === 'จ่าย' || lower === 'จ่ายแล้ว') {
      const lastOrderNo = await getLastOrderNumber();
      
      if (lastOrderNo) {
        const result = await updateOrderPaymentStatus(lastOrderNo, 'จ่ายแล้ว');
        if (result.success) {
          return {
            success: true,
            message: `✅ อัปเดตการชำระเงินสำเร็จ\n\n📋 #${lastOrderNo} | ${result.customer}\n💰 ${result.totalAmount.toLocaleString()}฿`
          };
        }
      }
      
      return { success: false, message: '❌ ไม่พบออเดอร์ล่าสุด' };
    }

    // Payment with order number
    if (lower.startsWith('จ่าย #') || lower.startsWith('จ่าย#')) {
      const orderNoMatch = text.match(/#(\d+)/);
      if (orderNoMatch) {
        const orderNo = parseInt(orderNoMatch[1]);
        const result = await updateOrderPaymentStatus(orderNo, 'จ่ายแล้ว');
        
        if (result.success) {
          return {
            success: true,
            message: `✅ จ่ายเงินออเดอร์ #${orderNo}\n\n👤 ${result.customer}\n💰 ${result.totalAmount.toLocaleString()}฿`
          };
        } else {
          return { success: false, message: result.error };
        }
      }
    }

    // ========================================================================
    // DELIVERY UPDATE (NEW FEATURE)
    // ========================================================================
    
    if (lower.startsWith('ส่ง ')) {
      const deliveryMatch = text.match(/ส่ง\s+(?:#(\d+)\s+)?(.+)/i);
      
      if (deliveryMatch) {
        const orderNo = deliveryMatch[1] ? parseInt(deliveryMatch[1]) : await getLastOrderNumber();
        const deliveryPerson = deliveryMatch[2].trim();
        
        const result = await updateDeliveryPerson(orderNo, deliveryPerson);
        
        if (result.success) {
          return {
            success: true,
            message: `🚚 อัปเดตการจัดส่งสำเร็จ!\n\n📋 #${orderNo}\n👤 ${result.customer}\n🚴 ผู้ส่ง: ${deliveryPerson}`
          };
        } else {
          return { success: false, message: result.error };
        }
      }
    }

    // ========================================================================
    // CANCEL ORDER (NEW FEATURE)
    // ========================================================================
    
    if (lower === 'ยกเลิก' || lower.startsWith('ยกเลิก ')) {
      const { cancelOrder } = require('./inboxService');
      
      const orderNoMatch = text.match(/#(\d+)/);
      const orderNo = orderNoMatch ? parseInt(orderNoMatch[1]) : await getLastOrderNumber();
      
      if (!orderNo) {
        return { success: false, message: '❌ ไม่พบออเดอร์ที่ต้องการยกเลิก' };
      }
      
      const result = await cancelOrder(orderNo);
      
      if (result.success) {
        let msg = `✅ ยกเลิกออเดอร์ #${orderNo}\n\n`;
        msg += `👤 ${result.customer}\n\n`;
        msg += `📦 คืนสต็อก:\n`;
        
        result.stockRestored.forEach(item => {
          msg += `• ${item.item} +${item.restored} → ${item.newStock} ${item.unit}\n`;
        });
        
        return { success: true, message: msg };
      } else {
        return { success: false, message: result.error };
      }
    }

    // ========================================================================
    // STOCK ADJUSTMENT (Auto-detect)
    // ========================================================================
    
    const stockAdjustment = await parseAdjustmentCommand(text);
    
    if (stockAdjustment.isAdjustment) {
      if (stockAdjustment.ambiguous) {
        let msg = `🤔 พบสินค้าหลายรายการ: "${stockAdjustment.productName}"\n\n`;
        
        stockAdjustment.suggestions.forEach((item, idx) => {
          msg += `${idx + 1}. ${item.item}\n`;
          msg += `   💰 ${item.price}฿ │ 📦 ${item.stock} ${item.unit}\n\n`;
        });
        
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `💡 ระบุให้ชัดเจน:\n`;
        msg += `ตัวอย่าง: "เติม ${stockAdjustment.suggestions[0].item} ${stockAdjustment.suggestions[0].price} ${stockAdjustment.value}"\n\n`;
        
        return { success: true, message: msg };
      }
      
      const result = await adjustStock(
        stockAdjustment.item,
        stockAdjustment.value,
        stockAdjustment.operation,
        'manual_adjustment'
      );
      
      if (result.success) {
        return {
          success: true,
          message: formatStockAdjustmentSuccess(result)
        };
      } else {
        return { success: false, message: result.error };
      }
    }

    // ========================================================================
    // ORDER PARSING (With Smart Learning & Auto-Process)
    // ========================================================================
    
    const aiResults = await parseOrder(text);
    
    if (!aiResults || aiResults.length === 0) {
      return {
        success: false,
        message: "❌ ไม่เข้าใจคำสั่ง\n\n💡 พิมพ์ \"help\" เพื่อดูคู่มือการใช้งาน"
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
          const paymentResult = await executePaymentLogic(res, userId);
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
    Logger.error('handleMessage error', error);
    return {
      success: false,
      message: '❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้ง'
    };
  }
}

// ============================================================================
// EXECUTION HELPERS (ENHANCED)
// ============================================================================

async function executeOrderLogic(parsed, userId) {
  try {
    // 1. Smart Correction & Learning (เหมือนเดิม)
    parsed = applySmartCorrection(parsed);
    const prediction = smartLearner.predictOrder(parsed.customer, parsed.items);
    if (prediction.success && prediction.confidence === 'high') {
      parsed.items = prediction.items || parsed.items;
    }

    // 2. Auto-add customer (เหมือนเดิม)
    if (parsed.customer && parsed.customer !== 'ไม่ระบุ') {
      const { getCustomerCache } = require('./cacheManager');
      const customerCache = getCustomerCache();
      const customerExists = customerCache.some(c => 
        c.name.toLowerCase() === parsed.customer.toLowerCase()
      );
      if (!customerExists) {
        await autoAddCustomer(parsed.customer);
      }
    }

    // 3. เตรียมข้อมูลสร้างออเดอร์
    const orderData = {
      customer: parsed.customer || 'ไม่ระบุ',
      items: parsed.items,
      deliveryPerson: parsed.deliveryPerson || '', // ✅ รับค่าคนส่งทันทีถ้ามี
      paymentStatus: parsed.isPaid ? 'จ่ายแล้ว' : 'unpaid' // ✅ รับสถานะจ่ายเงินทันทีถ้ามี
    };
    
    // คำนวณยอดรวม
    const totalValue = parsed.items.reduce((sum, item) => 
      sum + (item.quantity * item.stockItem.price), 0
    );

    // เช็ค Auto Process
    const autoDecision = shouldAutoProcess(parsed, totalValue);
    monitor.recordDecision(autoDecision, 'pending');

    // 4. 🔥 สร้างออเดอร์ (Create Order)
    const result = await createOrderTransaction(orderData);
    
    if (result.success) {
      monitor.recordDecision(autoDecision, result.orderNo);

      // ==========================================================
      // ✅ EXTRA ACTIONS: จัดการสถานะเพิ่มเติมทันที (ถ้ามี)
      // ==========================================================
      
      let extraMessages = [];

      // A. ถ้าสั่งว่า "จ่ายแล้ว" ให้ไปอัปเดตสถานะใน Sheet ทันที (เพื่อความชัวร์)
      if (parsed.isPaid) {
        const { updateOrderPaymentStatus } = require('./orderService');
        await updateOrderPaymentStatus(result.orderNo, 'จ่ายแล้ว');
        extraMessages.push('💸 บันทึกรับเงินแล้ว');
      }

      // B. ถ้าระบุคนส่ง "ส่งพี่แดง"
      if (parsed.deliveryPerson) {
        // (Function updateDeliveryPerson จะไปแก้ใน Google Sheet)
        // บันทึก Log หรือแจ้งเตือนเพิ่มได้ตรงนี้
        extraMessages.push(`🚚 ฝากส่งโดย: ${parsed.deliveryPerson}`);
      }

      // ==========================================================

      // สร้างข้อความตอบกลับ
      let responseMsg = formatOrderSuccess(
        result.orderNo,
        result.customer,
        result.items,
        result.totalAmount,
        parsed.confidence,
        autoDecision.shouldAuto
      );

      // เติมข้อความสถานะพิเศษต่อท้าย
      if (extraMessages.length > 0) {
        responseMsg += `\n\n✨ อัปเดตเพิ่มเติม:\n• ${extraMessages.join('\n• ')}`;
      }

      return {
        success: true,
        message: responseMsg
      };

    } else {
      return {
        success: false,
        message: `❌ สร้างออเดอร์ไม่สำเร็จ: ${result.error}`
      };
    }
  } catch (error) {
    Logger.error('executeOrderLogic failed', error);
    return { success: false, message: '❌ ระบบขัดข้อง' };
  }
}

async function executePaymentLogic(res, userId) {
  try {
    let orderNo = res.orderNo || await getLastOrderNumber();
    
    const result = await updateOrderPaymentStatus(orderNo, 'จ่ายแล้ว');
    
    if (result.success) {
      return {
        success: true,
        message: `✅ จ่ายเงินออเดอร์ #${orderNo}\n\n👤 ${result.customer}\n💰 ${result.totalAmount.toLocaleString()}฿`
      };
    } else {
      return {
        success: false,
        message: `❌ ไม่พบออเดอร์ #${orderNo}`
      };
    }
  } catch (error) {
    Logger.error('executePaymentLogic failed', error);
    return {
      success: false,
      message: '❌ เกิดข้อผิดพลาดในการอัปเดตการชำระเงิน'
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  handleMessage,
  updateDeliveryPerson
};
