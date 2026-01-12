// enhancedOrderService.js - Order processing with full business logic
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getThaiDateTimeString } = require('./utils');
const { getSheetData, appendSheetData, updateSheetData } = require('./googleServices');
const { loadStockCache } = require('./cacheManager');
const { 
  pricingEngine, 
  inventoryManager, 
  creditManager,
  businessRules 
} = require('./businessLogic');

// ============================================================================
// ENHANCED ORDER CREATION
// ============================================================================

async function createEnhancedOrder(orderData) {
  const { customer, items, paymentStatus = 'unpaid', deliveryPerson = '' } = orderData;
  
  if (!customer || !items || !Array.isArray(items) || items.length === 0) {
    return {
      success: false,
      error: 'ข้อมูลไม่ครบถ้วน: ต้องมีลูกค้าและรายการสินค้า'
    };
  }

  try {
    // Step 1: Calculate pricing with all business rules
    const pricingResults = [];
    let totalAmount = 0;
    let totalCost = 0;

    for (const item of items) {
      const pricing = pricingEngine.calculatePrice(
        item.stockItem,
        item.quantity,
        customer,
        paymentStatus === 'credit' ? 'credit' : 'cash'
      );

      if (!pricing.valid) {
        return {
          success: false,
          error: pricing.error,
          details: pricing
        };
      }

      pricingResults.push({
        item: item.stockItem,
        quantity: item.quantity,
        pricing: pricing
      });

      totalAmount += pricing.finalPrice;
      totalCost += item.stockItem.cost * item.quantity;
    }

    // Step 2: Validate order against business rules
    const orderContext = {
      customer,
      items,
      totalAmount,
      totalCost,
      paymentStatus
    };

    const validation = await businessRules.validateOrder(orderContext);
    
    if (!validation.valid) {
      Logger.warn(`Order validation failed: ${validation.violations.length} violations`);
      return {
        success: false,
        error: validation.violations[0].message,
        violations: validation.violations
      };
    }

    // Step 3: Check credit limit if applicable
    if (paymentStatus === 'credit') {
      const creditCheck = await creditManager.checkCreditLimit(customer, totalAmount);
      
      if (!creditCheck.allowed) {
        return {
          success: false,
          error: creditCheck.message,
          creditInfo: creditCheck
        };
      }

      Logger.info(`💳 Credit check passed: ${customer} (${creditCheck.available}฿ available)`);
    }

    // Step 4: Get next order number
    const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    const orderNo = orderRows.length || 1;

    // Step 5: Verify and update stock
    const stockRows = await getSheetData(CONFIG.SHEET_ID, 'สต็อก!A:G');
    const stockMap = new Map();
    
    for (let i = 1; i < stockRows.length; i++) {
      const name = (stockRows[i][0] || '').toLowerCase().trim();
      const unit = (stockRows[i][3] || '').toLowerCase().trim();
      const stock = parseInt(stockRows[i][4] || 0);
      const key = `${name}|${unit}`;
      stockMap.set(key, { stock, rowIndex: i + 1 });
    }

    // Verify stock one more time (race condition protection)
    for (const result of pricingResults) {
      const key = `${result.item.item.toLowerCase().trim()}|${result.item.unit.toLowerCase().trim()}`;
      const stockInfo = stockMap.get(key);
      
      if (!stockInfo || stockInfo.stock < result.quantity) {
        return {
          success: false,
          error: `❌ สต็อกเปลี่ยนแปลง: ${result.item.item}\nกรุณาลองใหม่อีกครั้ง`
        };
      }
    }

    // Step 6: Create order rows and update stock
    const rowsToAdd = [];
    const timestamp = getThaiDateTimeString();
    const paymentText = paymentStatus === 'paid' ? 'จ่ายแล้ว' : 
                       paymentStatus === 'credit' ? 'เครดิต' : 'ยังไม่จ่าย';
    
    for (const result of pricingResults) {
      const key = `${result.item.item.toLowerCase().trim()}|${result.item.unit.toLowerCase().trim()}`;
      const stockInfo = stockMap.get(key);
      const newStock = stockInfo.stock - result.quantity;
      
      // Update stock
      await updateSheetData(CONFIG.SHEET_ID, `สต็อก!E${stockInfo.rowIndex}`, [[newStock]]);
      
      // Build notes with pricing breakdown if discounts applied
      let notes = '';
      if (result.pricing.appliedRules.length > 0) {
        notes = result.pricing.appliedRules
          .map(r => r.description)
          .filter(Boolean)
          .join(', ');
      }
      
      // Create order row (9 columns)
      const row = [
        orderNo,                      // A - รหัส
        timestamp,                    // B - วันที่
        customer,                     // C - ลูกค้า
        result.item.item,            // D - สินค้า
        result.quantity,             // E - จำนวน
        notes,                       // F - หมายเหตุ
        deliveryPerson,              // G - ผู้ส่ง
        paymentText,                 // H - จ่ายแล้วหรือยัง
        result.pricing.finalPrice    // I - ยอดเงิน
      ];
      
      rowsToAdd.push(row);
      
      Logger.success(
        `📦 ${result.item.item}: ${stockInfo.stock} → ${newStock} ` +
        `(${result.pricing.finalPrice}฿${result.pricing.savings > 0 ? ` save ${result.pricing.savings}฿` : ''})`
      );
    }

    // Step 7: Add all rows at once
    await appendSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I', rowsToAdd);
    
    // Step 8: Record credit if applicable
    if (paymentStatus === 'credit') {
      await creditManager.recordCredit(orderNo, customer, totalAmount);
    }

    // Step 9: Check for low stock alerts
    const lowStockItems = pricingResults.filter(r => {
      const key = `${r.item.item.toLowerCase().trim()}|${r.item.unit.toLowerCase().trim()}`;
      const stockInfo = stockMap.get(key);
      const newStock = stockInfo.stock - r.quantity;
      return newStock <= inventoryManager.getReorderPoint(r.item.item);
    });

    // Step 10: Reload cache
    await loadStockCache(true);

    // Step 11: Prepare detailed response
    const profit = totalAmount - totalCost;
    const profitMargin = totalAmount > 0 ? (profit / totalAmount * 100).toFixed(1) : 0;

    Logger.success(
      `✅ Order #${orderNo} created: ${customer} - ${totalAmount}฿ ` +
      `(profit: ${profit}฿, margin: ${profitMargin}%)`
    );

    return {
      success: true,
      orderNo,
      customer,
      totalAmount,
      totalCost,
      profit,
      profitMargin,
      paymentStatus,
      items: pricingResults.map((r, idx) => ({
        productName: r.item.item,
        quantity: r.quantity,
        unit: r.item.unit,
        basePrice: r.pricing.basePrice,
        finalPrice: r.pricing.finalPrice,
        savings: r.pricing.savings,
        discounts: r.pricing.appliedRules.filter(rule => rule.amount < 0),
        fees: r.pricing.appliedRules.filter(rule => rule.amount > 0),
        newStock: stockMap.get(
          `${r.item.item.toLowerCase().trim()}|${r.item.unit.toLowerCase().trim()}`
        ).stock - r.quantity,
        stockItem: r.item
      })),
      lowStockAlerts: lowStockItems.map(r => ({
        item: r.item.item,
        stock: stockMap.get(
          `${r.item.item.toLowerCase().trim()}|${r.item.unit.toLowerCase().trim()}`
        ).stock - r.quantity,
        reorderPoint: inventoryManager.getReorderPoint(r.item.item)
      }))
    };

  } catch (error) {
    Logger.error('Enhanced order creation failed', error);
    return {
      success: false,
      error: `❌ ไม่สามารถสร้างออเดอร์ได้: ${error.message}`
    };
  }
}

// ============================================================================
// FORMAT ORDER SUCCESS MESSAGE
// ============================================================================

function formatEnhancedOrderMessage(result) {
  let msg = `✅ บันทึกออเดอร์สำเร็จ!\n\n`;
  msg += `📋 คำสั่งซื้อ #${result.orderNo}\n`;
  msg += `👤 ${result.customer}\n`;
  msg += `${'='.repeat(35)}\n\n`;

  // Items with pricing details
  result.items.forEach(item => {
    const stockIcon = item.newStock === 0 ? '🔴' : 
                     item.newStock < 10 ? '🟡' : '🟢';
    
    msg += `${stockIcon} ${item.productName} x${item.quantity}\n`;
    
    // Show pricing breakdown if there are discounts/fees
    if (item.savings > 0) {
      msg += `   ราคาปกติ: ${item.basePrice}฿\n`;
      msg += `   ส่วนลด: -${item.savings}฿\n`;
      msg += `   ราคาสุทธิ: ${item.finalPrice}฿\n`;
      
      if (item.discounts.length > 0) {
        item.discounts.forEach(d => {
          msg += `   💡 ${d.description}\n`;
        });
      }
    } else {
      msg += `   ${item.finalPrice}฿\n`;
    }
    
    msg += `   สต็อกเหลือ: ${item.newStock} ${item.unit}\n\n`;
  });

  msg += `${'='.repeat(35)}\n`;
  msg += `💰 ยอดรวม: ${result.totalAmount.toLocaleString()}฿\n`;
  
  if (result.totalAmount !== result.items.reduce((sum, i) => sum + i.basePrice, 0)) {
    const totalSavings = result.items.reduce((sum, i) => sum + i.savings, 0);
    msg += `🎉 ประหยัด: ${totalSavings.toLocaleString()}฿\n`;
  }
  
  msg += `💵 กำไร: ${result.profit.toLocaleString()}฿ (${result.profitMargin}%)\n`;

  // Payment status
  if (result.paymentStatus === 'credit') {
    msg += `\n⚠️ เครดิต - ยังไม่ได้รับเงิน\n`;
  } else if (result.paymentStatus === 'paid') {
    msg += `\n✅ รับเงินแล้ว\n`;
  }

  // Low stock alerts
  if (result.lowStockAlerts && result.lowStockAlerts.length > 0) {
    msg += `\n⚠️ แจ้งเตือนสต็อกต่ำ:\n`;
    result.lowStockAlerts.forEach(alert => {
      msg += `  • ${alert.item}: เหลือ ${alert.stock} (ควรสั่งเมื่อเหลือ ${alert.reorderPoint})\n`;
    });
  }

  msg += `\n${'━'.repeat(35)}\n`;
  msg += `⚡ คำสั่งด่วน:\n`;
  msg += `• "จ่าย" - จ่ายออเดอร์นี้\n`;
  msg += `• "ส่ง ชื่อ" - อัปเดตการจัดส่ง\n`;
  msg += `• "ยกเลิก" - ยกเลิกออเดอร์นี้\n`;

  return msg;
}

// ============================================================================
// PAYMENT MANAGEMENT
// ============================================================================

async function processPayment(orderNo, paymentMethod = 'cash') {
  try {
    const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
    const orderRows = [];
    let totalAmount = 0;
    let customer = '';
    let currentStatus = '';
    
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] == orderNo) {
        orderRows.push({ index: i + 1, data: rows[i] });
        totalAmount += parseFloat(rows[i][8] || 0);
        customer = rows[i][2];
        currentStatus = rows[i][7];
      }
    }

    if (orderRows.length === 0) {
      return { success: false, error: `ไม่พบออเดอร์ #${orderNo}` };
    }

    // Update payment status
    const newStatus = 'จ่ายแล้ว';
    
    for (const orderRow of orderRows) {
      await updateSheetData(
        CONFIG.SHEET_ID, 
        `คำสั่งซื้อ!H${orderRow.index}`, 
        [[newStatus]]
      );
    }

    // If was credit, update credit record
    if (currentStatus === 'เครดิต') {
      await creditManager.payCredit(customer, totalAmount, orderNo);
    }
    
    Logger.success(`💰 Payment processed: #${orderNo} → ${newStatus}`);

    return {
      success: true,
      orderNo,
      customer,
      totalAmount,
      previousStatus: currentStatus,
      newStatus,
      paymentMethod
    };
  } catch (error) {
    Logger.error('Payment processing failed', error);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  createEnhancedOrder,
  formatEnhancedOrderMessage,
  processPayment
};
