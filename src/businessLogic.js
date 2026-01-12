// src/businessLogic.js - Business modules referenced in businessCommands.js
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getSheetData, appendSheetData, updateSheetData } = require('./googleServices');
const { getStockCache } = require('./cacheManager');
const { getThaiDateTimeString, extractGregorianDate } = require('./utils');

// ============================================================================
// PRICING ENGINE
// ============================================================================

class PricingEngine {
  constructor() {
    this.customerTiers = new Map();
    this.promotions = [];
  }

  updateCustomerTier(customerName, tier) {
    this.customerTiers.set(customerName.toLowerCase(), tier);
    Logger.success(`Updated ${customerName} to ${tier} tier`);
  }

  getCustomerTier(customerName) {
    return this.customerTiers.get(customerName.toLowerCase()) || 'regular';
  }

  addPromotion(promotion) {
    this.promotions.push(promotion);
    Logger.success(`Added promotion: ${promotion.name}`);
  }

  getActivePromotions() {
    const now = new Date();
    return this.promotions.filter(p => 
      new Date(p.startDate) <= now && new Date(p.endDate) >= now
    );
  }

  calculatePrice(item, quantity, customerName) {
    let basePrice = item.price * quantity;
    
    // Apply customer tier discount
    const tier = this.getCustomerTier(customerName);
    const tierDiscounts = {
      'vip': 0.10,
      'gold': 0.05,
      'regular': 0
    };
    
    const tierDiscount = tierDiscounts[tier] || 0;
    basePrice *= (1 - tierDiscount);
    
    // Apply promotions
    const activePromotions = this.getActivePromotions();
    for (const promo of activePromotions) {
      if (promo.items.includes(item.item)) {
        if (promo.type === 'percentage') {
          basePrice *= (1 - promo.value);
        } else if (promo.type === 'fixed') {
          basePrice -= promo.value;
        }
      }
    }
    
    return Math.max(0, basePrice);
  }
}

// ============================================================================
// INVENTORY MANAGER
// ============================================================================

class InventoryManager {
  async analyzeInventory() {
    const stockCache = getStockCache();
    
    const critical = [];
    const low = [];
    const adequate = [];
    const overstocked = [];
    
    stockCache.forEach(item => {
      if (item.stock === 0) {
        critical.push(item);
      } else if (item.stock <= 5) {
        critical.push(item);
      } else if (item.stock <= 20) {
        low.push(item);
      } else if (item.stock <= 100) {
        adequate.push(item);
      } else {
        overstocked.push(item);
      }
    });
    
    return { critical, low, adequate, overstocked };
  }

  async generateRestockReport() {
    const analysis = await this.analyzeInventory();
    
    let report = `📋 รายการที่ควรสั่งซื้อ\n${'='.repeat(40)}\n\n`;
    
    const needRestock = [...analysis.critical, ...analysis.low];
    
    if (needRestock.length === 0) {
      return '✅ สต็อกเพียงพอทุกรายการ';
    }
    
    report += `🔴 ต้องสั่งด่วน (${analysis.critical.length}):\n`;
    analysis.critical.forEach(item => {
      const suggested = Math.max(50, item.stock * 5);
      report += `  • ${item.item}: เหลือ ${item.stock} แนะนำสั่ง ${suggested}\n`;
    });
    
    if (analysis.low.length > 0) {
      report += `\n🟡 ควรสั่งเพิ่ม (${analysis.low.length}):\n`;
      analysis.low.slice(0, 10).forEach(item => {
        const suggested = Math.max(30, item.stock * 3);
        report += `  • ${item.item}: เหลือ ${item.stock} แนะนำสั่ง ${suggested}\n`;
      });
    }
    
    return report;
  }

  async getInventoryTurnover(days = 30) {
    // Calculate inventory turnover rate
    try {
      const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);
      
      const salesByProduct = new Map();
      
      for (let i = 1; i < rows.length; i++) {
        const orderDate = new Date(extractGregorianDate(rows[i][1]));
        if (orderDate >= cutoffDate) {
          const product = rows[i][3];
          const quantity = parseInt(rows[i][4] || 0);
          
          salesByProduct.set(product, (salesByProduct.get(product) || 0) + quantity);
        }
      }
      
      return salesByProduct;
    } catch (error) {
      Logger.error('Inventory turnover calculation failed', error);
      return new Map();
    }
  }
}

// ============================================================================
// CREDIT MANAGER
// ============================================================================

class CreditManager {
  async getCreditSummary() {
    try {
      const rows = await getSheetData(CONFIG.SHEET_ID, 'เครดิต!A:G');
      
      if (rows.length <= 1) {
        return {
          totalUnpaid: 0,
          overdueOrders: [],
          customers: []
        };
      }
      
      let totalUnpaid = 0;
      const overdueOrders = [];
      const customerMap = new Map();
      
      const now = new Date();
      
      for (let i = 1; i < rows.length; i++) {
        const status = (rows[i][4] || '').trim();
        if (status === 'ชำระแล้ว') continue;
        
        const amount = parseFloat(rows[i][3] || 0);
        const customer = rows[i][1];
        const dueDate = rows[i][5] ? new Date(rows[i][5]) : null;
        
        totalUnpaid += amount;
        
        if (!customerMap.has(customer)) {
          customerMap.set(customer, { name: customer, amount: 0, orders: 0 });
        }
        
        const customerData = customerMap.get(customer);
        customerData.amount += amount;
        customerData.orders += 1;
        
        if (dueDate && dueDate < now) {
          overdueOrders.push({
            customer: customer,
            orderNo: rows[i][2],
            amount: amount,
            dueDate: dueDate
          });
        }
      }
      
      return {
        totalUnpaid,
        overdueOrders,
        customers: Array.from(customerMap.values())
      };
    } catch (error) {
      Logger.error('Credit summary failed', error);
      return { totalUnpaid: 0, overdueOrders: [], customers: [] };
    }
  }

  async generateCreditReport(customerName = null) {
    try {
      const rows = await getSheetData(CONFIG.SHEET_ID, 'เครดิต!A:G');
      
      if (rows.length <= 1) {
        return '💳 ไม่มีรายการเครดิต';
      }
      
      let report = `💳 รายงานเครดิต\n${'='.repeat(40)}\n\n`;
      
      const credits = rows.slice(1).filter(row => {
        if (customerName) {
          return row[1].toLowerCase().includes(customerName.toLowerCase());
        }
        return row[4] !== 'ชำระแล้ว';
      });
      
      if (credits.length === 0) {
        return customerName 
          ? `💳 ไม่พบข้อมูลเครดิตของ ${customerName}`
          : '✅ ไม่มีเครดิตค้างชำระ';
      }
      
      let total = 0;
      const byCustomer = new Map();
      
      credits.forEach(row => {
        const customer = row[1];
        const amount = parseFloat(row[3] || 0);
        const status = row[4] || 'ค้างชำระ';
        
        if (status !== 'ชำระแล้ว') {
          total += amount;
          
          if (!byCustomer.has(customer)) {
            byCustomer.set(customer, { amount: 0, orders: [] });
          }
          
          const data = byCustomer.get(customer);
          data.amount += amount;
          data.orders.push({
            orderNo: row[2],
            date: row[0],
            amount: amount,
            dueDate: row[5]
          });
        }
      });
      
      byCustomer.forEach((data, customer) => {
        report += `👤 ${customer}\n`;
        report += `   ยอดรวม: ${data.amount.toLocaleString()}฿\n`;
        report += `   ออเดอร์: ${data.orders.length} รายการ\n\n`;
        
        data.orders.slice(0, 5).forEach(order => {
          report += `   • #${order.orderNo}: ${order.amount.toLocaleString()}฿`;
          if (order.dueDate) {
            const dueDate = new Date(order.dueDate);
            if (dueDate < new Date()) {
              report += ` ⚠️ เกินกำหนด`;
            }
          }
          report += '\n';
        });
        
        report += '\n';
      });
      
      report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      report += `💰 ยอดรวมค้างชำระ: ${total.toLocaleString()}฿`;
      
      return report;
      
    } catch (error) {
      Logger.error('Generate credit report failed', error);
      return `❌ ไม่สามารถสร้างรายงานได้: ${error.message}`;
    }
  }

  async payCredit(customerName, amount = null) {
    try {
      const rows = await getSheetData(CONFIG.SHEET_ID, 'เครดิต!A:G');
      
      const unpaidOrders = [];
      
      for (let i = 1; i < rows.length; i++) {
        const customer = (rows[i][1] || '').trim();
        const status = (rows[i][4] || '').trim();
        
        if (customer.toLowerCase().includes(customerName.toLowerCase()) && 
            status !== 'ชำระแล้ว') {
          unpaidOrders.push({
            rowIndex: i + 1,
            orderNo: rows[i][2],
            amount: parseFloat(rows[i][3] || 0),
            customer: customer
          });
        }
      }
      
      if (unpaidOrders.length === 0) {
        return {
          success: false,
          error: `❌ ไม่พบเครดิตค้างชำระของ ${customerName}`
        };
      }
      
      const paidItems = [];
      let remaining = amount || Infinity;
      
      for (const order of unpaidOrders) {
        if (remaining <= 0) break;
        
        if (amount === null || remaining >= order.amount) {
          // Pay full
          await updateSheetData(
            CONFIG.SHEET_ID,
            `เครดิต!E${order.rowIndex}`,
            [['ชำระแล้ว']]
          );
          
          paidItems.push({
            orderNo: order.orderNo,
            amount: order.amount,
            partial: false
          });
          
          remaining -= order.amount;
        } else if (remaining > 0) {
          // Partial payment
          paidItems.push({
            orderNo: order.orderNo,
            amount: remaining,
            partial: true
          });
          
          remaining = 0;
        }
      }
      
      const totalPaid = paidItems.reduce((sum, item) => sum + item.amount, 0);
      
      Logger.success(`Paid credit for ${customerName}: ${totalPaid}฿`);
      
      return {
        success: true,
        customer: unpaidOrders[0].customer,
        totalPaid: totalPaid,
        paidItems: paidItems
      };
      
    } catch (error) {
      Logger.error('Pay credit failed', error);
      return {
        success: false,
        error: `❌ เกิดข้อผิดพลาด: ${error.message}`
      };
    }
  }
}

// ============================================================================
// SALES ANALYTICS
// ============================================================================

class SalesAnalytics {
  async generateSalesReport(period = 'today') {
    try {
      const rows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
      
      if (rows.length <= 1) {
        return {
          revenue: 0,
          orders: 0,
          averageOrderValue: 0,
          topProducts: []
        };
      }
      
      const { startDate, endDate } = this.getPeriodDates(period);
      
      let revenue = 0;
      const orderNos = new Set();
      const productRevenue = new Map();
      
      for (let i = 1; i < rows.length; i++) {
        const orderDate = new Date(extractGregorianDate(rows[i][1]));
        
        if (orderDate >= startDate && orderDate <= endDate) {
          const orderNo = rows[i][0];
          const product = rows[i][3];
          const amount = parseFloat(rows[i][8] || 0);
          
          revenue += amount;
          orderNos.add(orderNo);
          
          productRevenue.set(
            product, 
            (productRevenue.get(product) || 0) + amount
          );
        }
      }
      
      const topProducts = Array.from(productRevenue.entries())
        .map(([name, rev]) => ({ name, revenue: rev }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);
      
      return {
        revenue,
        orders: orderNos.size,
        averageOrderValue: orderNos.size > 0 ? revenue / orderNos.size : 0,
        topProducts
      };
      
    } catch (error) {
      Logger.error('Sales report generation failed', error);
      return {
        revenue: 0,
        orders: 0,
        averageOrderValue: 0,
        topProducts: []
      };
    }
  }

  getPeriodDates(period) {
    const now = new Date();
    const startDate = new Date(now);
    const endDate = new Date(now);
    
    switch (period) {
      case 'today':
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
        break;
      
      case 'week':
        startDate.setDate(now.getDate() - 7);
        startDate.setHours(0, 0, 0, 0);
        break;
      
      case 'month':
        startDate.setMonth(now.getMonth() - 1);
        startDate.setHours(0, 0, 0, 0);
        break;
      
      default:
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
    }
    
    return { startDate, endDate };
  }

  async formatSalesReport(period) {
    const data = await this.generateSalesReport(period);
    
    const periodNames = {
      'today': 'วันนี้',
      'week': 'สัปดาห์นี้',
      'month': 'เดือนนี้'
    };
    
    let report = `📊 รายงานยอดขาย${periodNames[period] || period}\n`;
    report += `${'='.repeat(40)}\n\n`;
    report += `💰 รายได้: ${data.revenue.toLocaleString()}฿\n`;
    report += `📦 ออเดอร์: ${data.orders} รายการ\n`;
    report += `💵 ค่าเฉลี่ย: ${Math.round(data.averageOrderValue).toLocaleString()}฿\n\n`;
    
    if (data.topProducts.length > 0) {
      report += `🏆 สินค้าขายดี:\n`;
      data.topProducts.slice(0, 5).forEach((p, i) => {
        report += `${i + 1}. ${p.name} - ${p.revenue.toLocaleString()}฿\n`;
      });
    }
    
    return report;
  }
}

// ============================================================================
// SINGLETON INSTANCES
// ============================================================================

const pricingEngine = new PricingEngine();
const inventoryManager = new InventoryManager();
const creditManager = new CreditManager();
const salesAnalytics = new SalesAnalytics();

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  PricingEngine,
  InventoryManager,
  CreditManager,
  SalesAnalytics,
  pricingEngine,
  inventoryManager,
  creditManager,
  salesAnalytics
};
