// businessCommands.js - Admin commands for business management
const { Logger } = require('./logger');
const { 
  pricingEngine, 
  inventoryManager, 
  creditManager,
  salesAnalytics 
} = require('./businessLogic');
const { AccessControl, PERMISSIONS } = require('./accessControl');

// ============================================================================
// COMMAND PARSER
// ============================================================================

class BusinessCommandParser {
  parseCommand(text) {
    const lower = text.toLowerCase().trim();

    // Inventory commands
    if (lower.includes('สต็อกรายงาน') || lower.includes('inventory report')) {
      return { type: 'inventory_report', command: text };
    }
    if (lower.includes('ต้องสั่ง') || lower.includes('restock')) {
      return { type: 'restock_report', command: text };
    }

    // Credit commands
    if (lower.includes('เครดิต') && (lower.includes('รายงาน') || lower.includes('ดู'))) {
      const customerMatch = text.match(/(?:ลูกค้า|customer)\s*[:=]?\s*(.+)/i);
      return {
        type: 'credit_report',
        customer: customerMatch ? customerMatch[1].trim() : null,
        command: text
      };
    }
    if (lower.includes('จ่ายเครดิต') || lower.includes('pay credit')) {
      const customerMatch = text.match(/(?:ลูกค้า|customer)\s*[:=]?\s*([^\s,]+)/i);
      const amountMatch = text.match(/(\d+)\s*(?:บาท|฿)?/);
      return {
        type: 'pay_credit',
        customer: customerMatch ? customerMatch[1].trim() : null,
        amount: amountMatch ? parseInt(amountMatch[1]) : null,
        command: text
      };
    }

    // Sales analytics
    if (lower.includes('ยอดขาย') || lower.includes('sales')) {
      let period = 'today';
      if (lower.includes('สัปดาห์') || lower.includes('week')) period = 'week';
      if (lower.includes('เดือน') || lower.includes('month')) period = 'month';
      
      return { type: 'sales_report', period, command: text };
    }

    // Pricing commands
    if (lower.includes('โปรโมชั่น') || lower.includes('promotion')) {
      return { type: 'promotion_management', command: text };
    }

    // Customer tier
    if (lower.includes('ระดับลูกค้า') || lower.includes('customer tier')) {
      const customerMatch = text.match(/(?:ลูกค้า|customer)\s*[:=]?\s*([^\s,]+)/i);
      const tierMatch = text.match(/(?:ระดับ|tier)\s*[:=]?\s*(vip|gold|regular)/i);
      return {
        type: 'set_customer_tier',
        customer: customerMatch ? customerMatch[1].trim() : null,
        tier: tierMatch ? tierMatch[1].toLowerCase() : null,
        command: text
      };
    }

    return null;
  }
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

class BusinessCommandHandler {
  constructor() {
    this.parser = new BusinessCommandParser();
  }

  async handleCommand(text, userId) {
    // Check if user has admin permissions
    if (!AccessControl.isAdmin(userId)) {
      return {
        success: false,
        message: '🔒 เฉพาะแอดมินเท่านั้นที่ใช้คำสั่งนี้ได้'
      };
    }

    const parsed = this.parser.parseCommand(text);
    
    if (!parsed) {
      return null; // Not a business command
    }

    Logger.info(`💼 Business command: ${parsed.type} by ${userId.substring(0, 8)}`);

    try {
      switch (parsed.type) {
        case 'inventory_report':
          return await this.handleInventoryReport();
        
        case 'restock_report':
          return await this.handleRestockReport();
        
        case 'credit_report':
          return await this.handleCreditReport(parsed.customer);
        
        case 'pay_credit':
          return await this.handlePayCredit(parsed.customer, parsed.amount);
        
        case 'sales_report':
          return await this.handleSalesReport(parsed.period);
        
        case 'set_customer_tier':
          return await this.handleSetCustomerTier(parsed.customer, parsed.tier);
        
        case 'promotion_management':
          return await this.handlePromotionManagement(parsed.command);
        
        default:
          return {
            success: false,
            message: '❌ ไม่รู้จักคำสั่งนี้'
          };
      }
    } catch (error) {
      Logger.error('Business command handler error', error);
      return {
        success: false,
        message: `❌ เกิดข้อผิดพลาด: ${error.message}`
      };
    }
  }

  async handleInventoryReport() {
    const analysis = await inventoryManager.analyzeInventory();
    
    let msg = `📦 รายงานสถานะสต็อก\n${'='.repeat(40)}\n\n`;
    
    // Summary
    msg += `📊 สรุป:\n`;
    msg += `  🔴 หมด/ใกล้หมด: ${analysis.critical.length}\n`;
    msg += `  🟡 สต็อกต่ำ: ${analysis.low.length}\n`;
    msg += `  🟢 เพียงพอ: ${analysis.adequate.length}\n`;
    msg += `  📈 เกิน: ${analysis.overstocked.length}\n\n`;

    // Critical items
    if (analysis.critical.length > 0) {
      msg += `🔴 หมด/ใกล้หมด (${analysis.critical.length}):\n`;
      analysis.critical.slice(0, 10).forEach(item => {
        msg += `  • ${item.item}: ${item.stock} ${item.unit}\n`;
      });
      if (analysis.critical.length > 10) {
        msg += `  ... และอีก ${analysis.critical.length - 10} รายการ\n`;
      }
      msg += '\n';
    }

    // Low stock
    if (analysis.low.length > 0) {
      msg += `🟡 สต็อกต่ำ (${analysis.low.length}):\n`;
      analysis.low.slice(0, 5).forEach(item => {
        msg += `  • ${item.item}: ${item.stock} ${item.unit}\n`;
      });
      if (analysis.low.length > 5) {
        msg += `  ... และอีก ${analysis.low.length - 5} รายการ\n`;
      }
      msg += '\n';
    }

    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💡 พิมพ์ "ต้องสั่ง" เพื่อดูรายการที่ควรสั่งซื้อ`;

    return { success: true, message: msg };
  }

  async handleRestockReport() {
    const report = await inventoryManager.generateRestockReport();
    return { success: true, message: report };
  }

  async handleCreditReport(customer) {
    const report = await creditManager.generateCreditReport(customer);
    return { success: true, message: report };
  }

  async handlePayCredit(customer, amount) {
    if (!customer) {
      return {
        success: false,
        message: '❌ กรุณาระบุชื่อลูกค้า\n\n💡 ตัวอย่าง: "จ่ายเครดิต ลูกค้า: คุณสมชาย"'
      };
    }

    const result = await creditManager.payCredit(customer, amount);
    
    if (!result.success) {
      return {
        success: false,
        message: result.error
      };
    }

    let msg = `✅ บันทึกการชำระเครดิตสำเร็จ\n\n`;
    msg += `👤 ลูกค้า: ${result.customer}\n`;
    msg += `💰 ยอดชำระ: ${result.totalPaid.toLocaleString()}฿\n\n`;
    msg += `📋 รายการที่ชำระ:\n`;
    
    result.paidItems.forEach(item => {
      msg += `  • #${item.orderNo}: ${item.amount.toLocaleString()}฿`;
      if (item.partial) msg += ` (บางส่วน)`;
      msg += '\n';
    });

    return { success: true, message: msg };
  }

  async handleSalesReport(period) {
    const report = await salesAnalytics.formatSalesReport(period);
    return { success: true, message: report };
  }

  async handleSetCustomerTier(customer, tier) {
    if (!customer || !tier) {
      return {
        success: false,
        message: '❌ กรุณาระบุลูกค้าและระดับ\n\n' +
                '💡 ตัวอย่าง: "ระดับลูกค้า: คุณสมชาย tier: vip"\n' +
                'ระดับที่มี: vip, gold, regular'
      };
    }

    if (!['vip', 'gold', 'regular'].includes(tier)) {
      return {
        success: false,
        message: '❌ ระดับไม่ถูกต้อง\n\nใช้ได้: vip, gold, regular'
      };
    }

    pricingEngine.updateCustomerTier(customer, tier);

    const tierNames = {
      'vip': 'VIP (-10%)',
      'gold': 'ทอง (-5%)',
      'regular': 'ปกติ'
    };

    return {
      success: true,
      message: `✅ อัปเดตระดับลูกค้าสำเร็จ\n\n` +
              `👤 ${customer}\n` +
              `⭐ ระดับ: ${tierNames[tier]}`
    };
  }

  async handlePromotionManagement(command) {
    // Parse promotion command
    // Example: "โปรโมชั่น: น้ำแข็ง ลด 10% จนถึง 31/12/2025"
    
    const itemMatch = command.match(/(?:สินค้า|item)\s*[:=]?\s*([^\s,]+)/i);
    const discountMatch = command.match(/ลด\s*(\d+)\s*%/i);
    const endDateMatch = command.match(/(\d{2})\/(\d{2})\/(\d{4})/);

    if (!itemMatch || !discountMatch) {
      return {
        success: false,
        message: '❌ รูปแบบไม่ถูกต้อง\n\n' +
                '💡 ตัวอย่าง:\n' +
                '"โปรโมชั่น: สินค้า: น้ำแข็ง ลด 10% จนถึง 31/12/2025"'
      };
    }

    const item = itemMatch[1];
    const discount = parseInt(discountMatch[1]) / 100;
    
    let endDate = new Date();
    if (endDateMatch) {
      endDate = new Date(
        parseInt(endDateMatch[3]),
        parseInt(endDateMatch[2]) - 1,
        parseInt(endDateMatch[1])
      );
    } else {
      endDate.setDate(endDate.getDate() + 30); // Default 30 days
    }

    const promotion = {
      id: `promo_${Date.now()}`,
      name: `ส่วนลด ${discount * 100}% - ${item}`,
      type: 'percentage',
      value: discount,
      items: [item],
      startDate: new Date(),
      endDate: endDate
    };

    pricingEngine.addPromotion(promotion);

    return {
      success: true,
      message: `✅ เพิ่มโปรโมชั่นสำเร็จ\n\n` +
              `🎉 ${promotion.name}\n` +
              `📅 ถึง: ${endDate.toLocaleDateString('th-TH')}\n\n` +
              `💡 โปรโมชั่นนี้จะใช้กับออเดอร์ใหม่ทั้งหมด`
    };
  }
}

// ============================================================================
// BUSINESS INSIGHTS GENERATOR
// ============================================================================

class BusinessInsightsGenerator {
  async generateDailyInsights() {
    try {
      const [salesReport, inventoryAnalysis, creditSummary] = await Promise.all([
        salesAnalytics.generateSalesReport('today'),
        inventoryManager.analyzeInventory(),
        creditManager.getCreditSummary()
      ]);

      let insights = `💼 ภาพรวมธุรกิจวันนี้\n${'='.repeat(40)}\n\n`;

      // Sales performance
      insights += `📊 ยอดขาย:\n`;
      insights += `  💰 รายได้: ${salesReport.revenue.toLocaleString()}฿\n`;
      insights += `  📦 ออเดอร์: ${salesReport.orders}\n`;
      insights += `  💵 ค่าเฉลี่ย: ${Math.round(salesReport.averageOrderValue).toLocaleString()}฿\n\n`;

      // Inventory alerts
      const criticalCount = inventoryAnalysis.critical.length;
      const lowCount = inventoryAnalysis.low.length;
      
      if (criticalCount > 0 || lowCount > 0) {
        insights += `⚠️ สต็อก:\n`;
        if (criticalCount > 0) {
          insights += `  🔴 หมด/ใกล้หมด: ${criticalCount} รายการ\n`;
        }
        if (lowCount > 0) {
          insights += `  🟡 สต็อกต่ำ: ${lowCount} รายการ\n`;
        }
        insights += '\n';
      }

      // Credit status
      if (creditSummary.totalUnpaid > 0) {
        insights += `💳 เครดิต:\n`;
        insights += `  ค้างชำระ: ${creditSummary.totalUnpaid.toLocaleString()}฿\n`;
        
        if (creditSummary.overdueOrders.length > 0) {
          insights += `  ⚠️ เกินกำหนด: ${creditSummary.overdueOrders.length} รายการ\n`;
        }
        insights += '\n';
      }

      // Top performers
      if (salesReport.topProducts.length > 0) {
        insights += `🏆 สินค้าขายดี:\n`;
        salesReport.topProducts.slice(0, 3).forEach((p, i) => {
          insights += `  ${i + 1}. ${p.name} (${p.revenue.toLocaleString()}฿)\n`;
        });
      }

      return insights;

    } catch (error) {
      Logger.error('Generate insights failed', error);
      return '❌ ไม่สามารถสร้างรายงานได้';
    }
  }

  async generateWeeklyReport() {
    // TODO: Implement comprehensive weekly report
    // Include: Sales trends, inventory turnover, top customers, etc.
    return '📊 รายงานสัปดาห์ (coming soon)';
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

const businessCommandHandler = new BusinessCommandHandler();
const insightsGenerator = new BusinessInsightsGenerator();

async function handleBusinessCommand(text, userId) {
  return await businessCommandHandler.handleCommand(text, userId);
}

async function getDailyInsights() {
  return await insightsGenerator.generateDailyInsights();
}

module.exports = {
  BusinessCommandParser,
  BusinessCommandHandler,
  BusinessInsightsGenerator,
  businessCommandHandler,
  insightsGenerator,
  handleBusinessCommand,
  getDailyInsights
};
