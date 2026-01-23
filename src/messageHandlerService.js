// src/messageHandlerService.js - FIXED: Proper import usage
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
    msg += `🔄 "รีเฟรช" - โหลดข้อมูลใหม่\n\n`;
    msg += `💳 **เครดิต**\n`;
    msg += `• "เครดิต" - รายงานเครดิตทั้งหมด\n`;
    msg += `• "เครดิต [ชื่อ]" - เช็คเครดิตลูกค้า\n`;
    msg += `• "จ่าย" - จ่ายออเดอร์ล่าสุด (อัปเดตเครดิตอัตโนมัติ)\n\n`;
  }
  
  return msg;
}

// ============================================================================
// UPDATE DELIVERY PERSON
// ============================================================================

async function updateDeliveryPerson(orderNo, deliveryPerson) {
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
// MAIN MESSAGE HANDLER
// ============================================================================

async function handleMessage(text, userId) {
  try {
    const lower = text.toLowerCase().trim();

    // Save to inbox - USE IMPORTED FUNCTION
    await saveToInbox(userId, text);

    // ========================================================================
    // STOCK ADJUSTMENT DETECTION
    // ========================================================================
    
    const stockKeywords = ['เหลือ', 'มี', 'เติม', 'ลด', 'เพิ่ม', 'ปรับ'];
    const orderKeywords = ['สั่ง', 'ซื้อ', 'เอา', 'ขอ', 'จอง'];
    const customerPrefixes = ['คุณ', 'พี่', 'น้อง', 'เจ๊', 'ร้าน', 'ป้า'];
    
    const hasStockKeywords = stockKeywords.some(kw => lower.includes(kw));
    const hasOrderKeywords = orderKeywords.some(kw => lower.includes(kw));
    const hasCustomerPrefix = customerPrefixes.some(prefix => lower.includes(prefix));
    
    let isLikelyStockAdjustment = false;
    
    if (hasStockKeywords && !hasOrderKeywords && !hasCustomerPrefix) {
      isLikelyStockAdjustment = true;
    } else if (lower.match(/^[ก-๙a-z\s]+\s+(เหลือ|มี)\s+\d+/i)) {
      isLikelyStockAdjustment = true;
    }
    
    Logger.info(`🔍 Detection: Stock=${hasStockKeywords}, Order=${hasOrderKeywords}, Customer=${hasCustomerPrefix}, IsStockAdj=${isLikelyStockAdjustment}`);

    // ========================================================================
    // WELCOME
    // ========================================================================
    
    if (lower === 'start' || lower === 'เริ่ม' || lower === 'hello' || lower === 'สวัสดี') {
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
      welcome += `• "เจ้แอน สั่ง โค้ก 30 จำนวน 5" (สั่งสินค้า)\n`;
      welcome += `• "น้ำแข็ง เหลือ 10" (ปรับสต็อก)\n`;
      welcome += `• "จ่าย" (จ่ายออเดอร์ล่าสุด)\n`;
      welcome += `• "ส่ง พี่แดง" (อัปเดตผู้ส่งของ)`;
      
      return { success: true, message: welcome };
    }

    // ========================================================================
    // HELP
    // ========================================================================
    
    if (lower === 'help' || lower === 'ช่วย' || lower === 'สอน') {
      return { success: true, message: getHelpMessage(userId) };
    }

    // ========================================================================
    // BUSINESS COMMANDS
    // ========================================================================
    
    const businessResult = await handleBusinessCommand(text, userId);
    if (businessResult && businessResult.success) {
      return businessResult;
    }

    // ========================================================================
    // ADMIN COMMANDS
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
    // PAYMENT UPDATE
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
    // DELIVERY UPDATE
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
    // CANCEL ORDER
    // ========================================================================
    
    if (lower === 'ยกเลิก' || lower.startsWith('ยกเลิก ')) {
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
    // CREDIT COMMANDS
    // ========================================================================
    
    if (lower.includes('เครดิต') || lower === 'credit') {
      if (lower.startsWith('เครดิต ')) {
        const customerName = text.replace(/เครดิต/i, '').trim();
        
        const summary = await getCreditSummaryWithAlerts();
        const customer = summary.customers.find(c => 
          c.name.toLowerCase().includes(customerName.toLowerCase())
        );
        
        if (!customer) {
          return {
            success: false,
            message: `❌ ไม่พบเครดิตของ ${customerName}\n\nลูกค้ารายนี้อาจจ่ายเงินหมดแล้ว หรือยังไม่เคยมีเครดิตค้าง`
          };
        }
        
        let msg = `💳 เครดิตของ ${customer.name}\n${'='.repeat(40)}\n\n`;
        msg += `ยอดรวม: ${customer.totalAmount.toLocaleString()}฿\n\n`;
        
        customer.orders.forEach(order => {
          let status = '';
          if (order.isOverdue) {
            status = `🔴 เกิน ${Math.abs(order.daysUntilDue)} วัน`;
          } else if (order.daysUntilDue <= 7) {
            status = `⏰ เหลือ ${order.daysUntilDue} วัน`;
          }
          
          msg += `#${order.orderNo}: ${order.amount.toLocaleString()}฿ ${status}\n`;
        });
        
        return { success: true, message: msg };
      }
      
      const report = await generateEnhancedCreditReport();
      return { success: true, message: report };
    }

    // ========================================================================
    // STOCK ADJUSTMENT
    // ========================================================================
    
    if (isLikelyStockAdjustment) {
      Logger.info('🔧 Detected as stock adjustment');
      
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
          msg += `ตัวอย่าง: "เติม ${stockAdjustment.suggestions[0].item} ${stockAdjustment.value}"\n\n`;
          
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
    }

    // ========================================================================
    // ORDER PARSING
    // ========================================================================
    
    if (lower === 'วิเคราะห์สต็อก' || lower === 'analyze stock') {
      const { stockPredictor } = require('./stockPrediction');
      await stockPredictor.analyzeSalesVelocity();
      const report = await stockPredictor.generateStockReport();
      return { success: true, message: report };
    }

    if (lower === 'abc' || lower === 'abc analysis') {
      const { stockPredictor } = require('./stockPrediction');
      const report = await stockPredictor.performABCAnalysis();
      return { success: true, message: report };
    }

    if (lower === 'สุขภาพสต็อก' || lower === 'stock health') {
      const { stockPredictor } = require('./stockPrediction');
      const health = await stockPredictor.getStockHealth();
      return { success: true, message: health };
    }

    if (lower === 'ต้องสั่งอะไร' || lower === 'ควรสั่งอะไร' || lower === 'reorder') {
      const { stockPredictor } = require('./stockPrediction');
      const recommendations = await stockPredictor.generateReorderRecommendations();
      
      if (recommendations.length === 0) {
        return { 
          success: true, 
          message: '✅ สต็อกทุกรายการเพียงพอ\n\nไม่มีสินค้าที่ต้องสั่งซื้อด่วน' 
        };
      }
      
      let msg = `📋 รายการที่ควรสั่งซื้อ (${recommendations.length} รายการ)\n${'='.repeat(40)}\n\n`;
      
      recommendations.slice(0, 10).forEach((r, i) => {
        const urgencyIcon = r.urgency === 'critical' ? '🔴' : 
                            r.urgency === 'high' ? '🟡' : '🟢';
        msg += `${urgencyIcon} ${i + 1}. ${r.product}\n`;
        msg += `   📦 เหลือ ${r.currentStock} (พอ ${r.daysUntilStockout} วัน)\n`;
        msg += `   ✅ แนะนำสั่ง ${r.recommendedQuantity}\n\n`;
      });
      
      if (recommendations.length > 10) {
        msg += `... และอีก ${recommendations.length - 10} รายการ\n\n`;
      }
      
      const totalCost = recommendations.reduce((sum, r) => sum + r.estimatedCost, 0);
      msg += `💰 ต้นทุนรวม: ${totalCost.toLocaleString()}฿`;
      
      return { success: true, message: msg };
    }

    // ============================================================================
    // VOICE-FRIENDLY STOCK QUERY
    // ============================================================================

    if (lower.match(/^(มี|เหลือ|สต็อก)\s+(.+?)(?:\s+เท่าไหร่|อยู่|ไหม)?$/)) {
      const match = lower.match(/^(มี|เหลือ|สต็อก)\s+(.+?)(?:\s+เท่าไหร่|อยู่|ไหม)?$/);
      const productName = match[2].trim();
      
      const stockCache = getStockCache();
      const { fuzzyMatchStock } = require('./stockAdjustment');
      
      const matches = fuzzyMatchStock(productName, stockCache);
      
      if (matches.length === 0) {
        return { 
          success: false, 
          message: `❌ ไม่พบสินค้า "${productName}"\n\nลองเช็คชื่อใหม่อีกครั้ง` 
        };
      }
      
      if (matches.length === 1) {
        const item = matches[0].item;
        let msg = `📦 ${item.item}\n${'='.repeat(30)}\n\n`;
        msg += `💰 ราคา: ${item.price}฿\n`;
        msg += `📊 สต็อก: ${item.stock} ${item.unit}\n`;
        
        if (item.stock <= 3) {
          msg += `\n🔴 สต็อกเหลือน้อย!`;
        } else if (item.stock <= 10) {
          msg += `\n🟡 ควรสั่งเพิ่ม`;
        }
        
        return { success: true, message: msg };
      }
      
      // Multiple matches
      let msg = `🔍 พบ ${matches.length} รายการ:\n\n`;
      matches.slice(0, 5).forEach((m, i) => {
        msg += `${i + 1}. ${m.item.item}\n`;
        msg += `   💰 ${m.item.price}฿ │ 📦 ${m.item.stock} ${m.item.unit}\n\n`;
      });
      
      return { success: true, message: msg };
    }

    // ============================================================================
    // FAST MOVERS REPORT
    // ============================================================================

    if (lower === 'ขายดี' || lower === 'fast movers' || lower === 'top sellers') {
      const { stockPredictor } = require('./stockPrediction');
      
      if (stockPredictor.salesHistory.size === 0) {
        await stockPredictor.analyzeSalesVelocity();
      }
      
      const fastMovers = Array.from(stockPredictor.salesHistory.values())
        .filter(v => v.velocity === 'fast')
        .sort((a, b) => b.avgDailySales - a.avgDailySales)
        .slice(0, 15);
      
      if (fastMovers.length === 0) {
        return { 
          success: true, 
          message: '📊 ยังไม่มีข้อมูลเพียงพอ\n\nให้ระบบทำงานไปสักพัก' 
        };
      }
      
      let msg = `⚡ สินค้าขายดี (Fast Movers)\n${'='.repeat(40)}\n\n`;
      
      fastMovers.forEach((item, i) => {
        msg += `${i + 1}. ${item.name}\n`;
        msg += `   📈 ขาย ${item.avgDailySales.toFixed(1)}/วัน\n`;
        msg += `   📦 เหลือ ${item.currentStock} (พอ ${item.daysUntilStockout} วัน)\n\n`;
      });
      
      msg += `\n💡 แนะนำ: เติมสินค้าเหล่านี้บ่อยๆ`;
      
      return { success: true, message: msg };
    }

    // ============================================================================
    // SLOW MOVERS / DEADSTOCK
    // ============================================================================

    if (lower === 'ขายไม่ดี' || lower === 'slow movers' || lower === 'deadstock') {
      const { stockPredictor } = require('./stockPrediction');
      
      if (stockPredictor.salesHistory.size === 0) {
        await stockPredictor.analyzeSalesVelocity();
      }
      
      const slowMovers = Array.from(stockPredictor.salesHistory.values())
        .filter(v => v.velocity === 'very_slow' || v.velocity === 'dormant')
        .sort((a, b) => a.avgDailySales - b.avgDailySales)
        .slice(0, 15);
      
      if (slowMovers.length === 0) {
        return { 
          success: true, 
          message: '✅ ทุกสินค้าขายดีหมด!' 
        };
      }
      
      let msg = `🐌 สินค้าขายช้า (Slow Movers)\n${'='.repeat(40)}\n\n`;
      
      slowMovers.forEach((item, i) => {
        msg += `${i + 1}. ${item.name}\n`;
        msg += `   📉 ขาย ${item.avgDailySales.toFixed(1)}/วัน\n`;
        msg += `   📦 สต็อก ${item.currentStock}\n\n`;
      });
      
      msg += `\n💡 พิจารณา: ลดราคา หรือหยุดสั่ง`;
      
      return { success: true, message: msg };
    }
    const aiResults = await parseOrder(text);
    
    if (!aiResults || aiResults.length === 0) {
      return {
        success: false,
        message: "❌ ไม่เข้าใจคำสั่ง\n\n💡 พิมพ์ \"help\" เพื่อดูคู่มือการใช้งาน\n\n" +
                 "หรือตรวจสอบรูปแบบ:\n" +
                 "• สั่งสินค้า: \"[ร้าน] สั่ง [สินค้า] [ราคา] [จำนวน]\"\n" +
                 "• ปรับสต็อก: \"[สินค้า] เหลือ/มี [จำนวน]\""
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
    const { getCustomerCache } = require('./cacheManager');
    
    // Apply smart correction
    parsed = applySmartCorrection(parsed);
    
    // Apply smart learning
    const prediction = smartLearner.predictOrder(parsed.customer, parsed.items);
    if (prediction.success && prediction.confidence === 'high') {
      parsed.items = prediction.items || parsed.items;
    }

    // Auto-add customer if not exists
    if (parsed.customer && parsed.customer !== 'ไม่ระบุ') {
      const customerCache = getCustomerCache();
      const customerExists = customerCache.some(c => 
        c.name.toLowerCase() === parsed.customer.toLowerCase()
      );
      
      if (!customerExists) {
        await autoAddCustomer(parsed.customer);
      }
    }

    // ✅ FIX: ตรวจสอบ payment status อย่างชัดเจน
    let paymentStatus = 'unpaid';
    
    if (parsed.isPaid === true) {
      paymentStatus = 'paid';
      Logger.info('💰 Detected: PAID order');
    }

    // ✅ FIX: ตรวจสอบ delivery person
    let deliveryPerson = '';
    
    if (parsed.deliveryPerson && parsed.deliveryPerson.trim() !== '') {
      deliveryPerson = parsed.deliveryPerson.trim();
      Logger.info(`🚚 Detected: Delivery by ${deliveryPerson}`);
    }

    // Prepare order data
    const orderData = {
      customer: parsed.customer || 'ไม่ระบุ',
      items: parsed.items,
      deliveryPerson: deliveryPerson,
      paymentStatus: paymentStatus
    };
    
    const totalValue = parsed.items.reduce((sum, item) => 
      sum + (item.quantity * item.stockItem.price), 0
    );

    // Auto-process decision
    const autoDecision = shouldAutoProcess(parsed, totalValue);
    monitor.recordDecision(autoDecision, 'pending');

    // Create order
    const result = await createOrderTransaction(orderData);
    
    if (result.success) {
      monitor.recordDecision(autoDecision, result.orderNo);

      let extraMessages = [];

      // ✅ FIX: Update payment ONLY if paid
      if (paymentStatus === 'paid') {
        await updateOrderPaymentStatus(result.orderNo, 'จ่ายแล้ว');
        extraMessages.push('💸 บันทึกรับเงินแล้ว');
        Logger.success(`✅ Payment marked as PAID for order #${result.orderNo}`);
      }

      // ✅ FIX: Show delivery info if provided
      if (deliveryPerson) {
        extraMessages.push(`🚚 กำลังส่งโดย: ${deliveryPerson}`);
      }

      // Format response
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
    return { 
      success: false, 
      message: '❌ ระบบขัดข้อง' 
    };
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
updateDeliveryPerson,
executeOrderLogic 
};