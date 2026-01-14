// messageHandlerService.js - ENHANCED: Support disambiguation
const { Logger } = require('./logger');
const { parseOrder } = require('./orderParser');
const { createOrderTransaction, updateOrderPaymentStatus } = require('./orderService');
const { parseAdjustmentCommand, adjustStock } = require('./stockAdjustment');
const { generateDailySummary, generateInboxSummary } = require('./dashboardService');
const { loadStockCache, loadCustomerCache } = require('./cacheManager');

// ============================================================================
// FORMAT DISAMBIGUATION MESSAGE
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

// ============================================================================
// FORMAT ORDER SUCCESS
// ============================================================================

function formatOrderSuccess(orderNo, customer, items, totalAmount, confidence, shop = null) {
  const summary = items.map(i => {
    const itemName = i.productName || i.stockItem?.item || 'สินค้า';
    const newStock = i.newStock !== undefined ? i.newStock : 0;
    
    let stockIcon = '✅';
    if (newStock <= 3) stockIcon = '🔴';
    else if (newStock <= 10) stockIcon = '🟡';
    
    return `${stockIcon} ${itemName} x${i.quantity} (${newStock} เหลือ)`;
  }).join('\n');
  
  let msg = `✅ บันทึกออเดอร์สำเร็จ!\n\n`;
  msg += `📋 คำสั่งซื้อ #${orderNo}\n`;
  if (shop) msg += `🏪 ${shop}\n`;
  msg += `👤 ${customer}\n\n`;
  msg += `${summary}\n\n`;
  msg += `💰 รวม: ${totalAmount.toLocaleString()}฿\n`;
  msg += `🎯 ความมั่นใจ: ${confidence}\n\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `⚡ Quick Actions:\n`;
  msg += `• "จ่าย" - จ่ายออเดอร์นี้\n`;
  msg += `• "ส่ง พี่แดง" - อัปเดตการจัดส่ง\n\n`;
  msg += `พิมพ์ "help" ดูคำสั่งทั้งหมด`;
  
  return msg;
}

// ============================================================================
// FORMAT STOCK ADJUSTMENT SUCCESS
// ============================================================================

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

// ============================================================================
// HELP MESSAGE
// ============================================================================

function getHelpMessage(userId) {
  const { AccessControl } = require('./accessControl');
  const isAdmin = AccessControl.isAdmin(userId);
  
  let msg = `💡 คู่มือการใช้งาน Order Bot\n${'='.repeat(40)}\n\n`;
  
  // ORDERS
  msg += `🛒 **สั่งสินค้า**\n`;
  msg += `• [ร้าน] สั่ง [สินค้า] [ราคา] จำนวน [จำนวน]\n`;
  msg += `  ตัวอย่าง: เจ้แอน สั่ง น้ำแข็งหลอด 60 จำนวน 2\n\n`;
  msg += `• แบบสั้น: [สินค้า] [จำนวน] [ลูกค้า]\n`;
  msg += `  ตัวอย่าง: โค้ก 5 ขวด พี่ใหญ่\n\n`;
  
  // PAYMENT
  msg += `💰 **จ่ายเงิน**\n`;
  msg += `• "จ่าย" = จ่ายออเดอร์ล่าสุด\n`;
  msg += `• "จ่าย #123" = จ่ายออเดอร์เลขที่ 123\n\n`;
  
  // DELIVERY
  msg += `🚚 **จัดส่ง**\n`;
  msg += `• "ส่ง พี่แดง" = ผู้ส่งของออเดอร์ล่าสุด\n`;
  msg += `• "ส่ง #123 พี่แดง" = ระบุเลขออเดอร์\n\n`;
  
  // STOCK ADJUSTMENT
  if (isAdmin) {
    msg += `📦 **จัดการสต็อก**\n`;
    msg += `• "เติม [สินค้า] [ราคา] [จำนวน]"\n`;
    msg += `  ตัวอย่าง: เติม น้ำแข็งหลอด 60 10\n\n`;
    msg += `• "มี [สินค้า] [ราคา] [จำนวน]"\n`;
    msg += `  ตัวอย่าง: มี โค้ก 30 50\n\n`;
    msg += `• "ลด [สินค้า] [ราคา] [จำนวน]"\n`;
    msg += `  ตัวอย่าง: ลด เบียร์สิงห์ 720 5\n\n`;
  }
  
  // CANCEL
  msg += `❌ **ยกเลิกออเดอร์**\n`;
  msg += `• "ยกเลิก" = ยกเลิกออเดอร์ล่าสุด\n`;
  msg += `• "ยกเลิก #123" = ยกเลิกเลขที่ 123\n\n`;
  
  // ADMIN ONLY
  if (isAdmin) {
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `👑 **คำสั่งแอดมิน**\n\n`;
    
    msg += `📊 **รายงาน**\n`;
    msg += `• "สรุป" = สรุปยอดขายวันนี้\n`;
    msg += `• "inbox" = ดูประวัติการสนทนา\n`;
    msg += `• "เครดิต" = รายงานเครดิตค้าง\n\n`;
    
    msg += `🔧 **ระบบ**\n`;
    msg += `• "รีเฟรช" = โหลดข้อมูลใหม่\n`;
    msg += `• "help" = แสดงคู่มือนี้\n\n`;
  }
  
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💡 **เคล็ดลับ:**\n`;
  msg += `• ระบุราคาเพื่อแยกสินค้าชื่อซ้ำ\n`;
  msg += `• ระบบจะถามถ้าไม่แน่ใจ\n`;
  msg += `• พูดง่ายๆ ตามธรรมชาติ\n`;
  
  if (!isAdmin) {
    msg += `\n📞 ติดต่อแอดมินถ้าต้องการความช่วยเหลือ`;
  }
  
  return msg;
}

// ============================================================================
// MAIN MESSAGE HANDLER
// ============================================================================

async function handleMessage(text, userId) {
  try {
    const lower = text.toLowerCase().trim();

    // Save ALL messages to inbox first (raw transcript only)
    const { saveToInbox } = require('./inboxService');
    await saveToInbox(userId, text);

    // ========================================================================
    // WELCOME MESSAGE (First time user or "start")
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
        welcome += `• อัปเดตการชำระเงิน\n`;
        welcome += `• จัดการการจัดส่ง\n\n`;
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
    // ADMIN COMMANDS (Hidden - not shown to regular users)
    // ========================================================================
    
    if (lower === 'help' || lower === 'ช่วย' || lower === 'สอน') {
      return { success: true, message: getHelpMessage(userId) };
    }
    
    if (lower === 'สรุป' || lower.includes('สรุปวันนี้')) {
      // Daily sales summary
      const summary = await generateDailySummary();
      return { success: true, message: summary };
    }
    
    if (lower === 'inbox' || lower.includes('ประวัติ')) {
      // View conversation transcript (for debugging/admin)
      const { generateInboxSummary } = require('./inboxService');
      const inbox = await generateInboxSummary(50);
      return { success: true, message: inbox };
    }
    
    if (lower === 'รีเฟรช') {
      // Force cache reload
      await loadStockCache(true);
      await loadCustomerCache(true);
      return { success: true, message: '✅ รีเฟรชข้อมูลสำเร็จ' };
    }
    
    // ========================================================================
    // END ADMIN COMMANDS
    // ========================================================================
    
    // Payment update shortcut
    if (lower === 'จ่าย' || lower === 'จ่ายแล้ว') {
      const { getLastOrderNumber } = require('./orderService');
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

    // Stock adjustment detection (AUTO-DETECT, no keyword needed)
    const { parseAdjustmentCommand, adjustStock } = require('./stockAdjustment');
    const stockAdjustment = await parseAdjustmentCommand(text);
    
    if (stockAdjustment.isAdjustment) {
      // Handle ambiguous stock items
      if (stockAdjustment.ambiguous) {
        let msg = `🤔 พบสินค้าหลายรายการ: "${stockAdjustment.productName}"\n\n`;
        
        stockAdjustment.suggestions.forEach((item, idx) => {
          msg += `${idx + 1}. ${item.item}\n`;
          msg += `   💰 ${item.price}฿ │ 📦 ${item.stock} ${item.unit}\n\n`;
        });
        
        msg += `━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `💡 ระบุให้ชัดเจน:\n`;
        msg += `ตัวอย่าง: "เติม ${stockAdjustment.suggestions[0].item} ${stockAdjustment.suggestions[0].price} ${stockAdjustment.value}"\n\n`;
        msg += `พิมพ์ "help" ดูคู่มือเพิ่มเติม`;
        
        return { success: true, message: msg };
      }
      
      // Execute stock adjustment
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

    // Order parsing
    const aiResults = await parseOrder(text);
    
    if (!aiResults || aiResults.length === 0) {
      return {
        success: false,
        message: "❌ ไม่เข้าใจคำสั่ง\n\n💡 พิมพ์ \"help\" เพื่อดูคู่มือการใช้งาน\n\nตัวอย่าง:\n• เจ้แอน สั่ง น้ำแข็งหลอด 60 จำนวน 2\n• จ่าย\n• ส่ง พี่แดง"
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
// EXECUTION HELPERS
// ============================================================================

async function executeOrderLogic(parsed, userId) {
  try {
    const orderData = {
      customer: parsed.customer || 'ไม่ระบุ',
      items: parsed.items,
      deliveryPerson: '',
      paymentStatus: 'unpaid'
    };
    
    const result = await createOrderTransaction(orderData);
    
    if (result.success) {
      return {
        success: true,
        message: formatOrderSuccess(
          result.orderNo,
          result.customer,
          result.items,
          result.totalAmount,
          parsed.confidence,
          parsed.shop
        )
      };
    } else {
      return {
        success: false,
        message: `❌ ไม่สามารถสร้างออเดอร์ได้\n\n${result.error}`
      };
    }
  } catch (error) {
    Logger.error('executeOrderLogic failed', error);
    return {
      success: false,
      message: '❌ เกิดข้อผิดพลาดในการสร้างออเดอร์'
    };
  }
}

async function executePaymentLogic(res, userId) {
  try {
    const { getLastOrderNumber } = require('./orderService');
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
  handleMessage
};
