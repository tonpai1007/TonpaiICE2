// src/stockPrediction.js - Predictive Stock Management
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getSheetData } = require('./googleServices');
const { getStockCache } = require('./cacheManager');

class StockPredictor {
  constructor() {
    this.salesHistory = new Map(); // SKU -> daily sales
    this.lastAnalysis = 0;
    this.ANALYSIS_INTERVAL = 24 * 60 * 60 * 1000; // Daily
  }

  // ========================================================================
  // ANALYZE SALES VELOCITY (Last 30 days)
  // ========================================================================
  
  async analyzeSalesVelocity() {
    try {
      Logger.info('📊 Analyzing sales velocity...');
      
      const orderRows = await getSheetData(CONFIG.SHEET_ID, 'คำสั่งซื้อ!A:I');
      const stockCache = getStockCache();
      
      // Get last 30 days
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 30);
      
      const salesByProduct = new Map();
      const salesByDay = new Map();
      
      for (let i = 1; i < orderRows.length; i++) {
        const dateStr = orderRows[i][1];
        const product = orderRows[i][3];
        const quantity = parseInt(orderRows[i][4] || 0);
        
        // Parse date
        let orderDate;
        try {
          const parts = dateStr.split(/[\s\/]/);
          if (parts.length >= 3) {
            orderDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
          }
        } catch (e) {
          continue;
        }
        
        if (orderDate < cutoffDate) continue;
        
        // Track sales
        if (!salesByProduct.has(product)) {
          salesByProduct.set(product, {
            name: product,
            totalSold: 0,
            orderCount: 0,
            dailySales: []
          });
        }
        
        const data = salesByProduct.get(product);
        data.totalSold += quantity;
        data.orderCount++;
        data.dailySales.push({ date: orderDate, quantity });
      }
      
      // Calculate velocity
      salesByProduct.forEach((data, product) => {
        const avgDailySales = data.totalSold / 30;
        const orderFrequency = data.orderCount / 30;
        
        // Find stock item
        const stockItem = stockCache.find(s => s.item === product);
        
        if (stockItem) {
          data.currentStock = stockItem.stock;
          data.avgDailySales = avgDailySales;
          data.orderFrequency = orderFrequency;
          data.daysUntilStockout = avgDailySales > 0 
            ? Math.floor(stockItem.stock / avgDailySales) 
            : 999;
          data.velocity = this.calculateVelocity(avgDailySales, stockItem.stock);
        }
      });
      
      this.salesHistory = salesByProduct;
      this.lastAnalysis = Date.now();
      
      Logger.success(`✅ Analyzed ${salesByProduct.size} products`);
      return salesByProduct;
      
    } catch (error) {
      Logger.error('Sales velocity analysis failed', error);
      return new Map();
    }
  }

  // ========================================================================
  // VELOCITY CLASSIFICATION
  // ========================================================================
  
  calculateVelocity(avgDailySales, currentStock) {
    if (avgDailySales === 0) return 'dormant';
    
    const turnoverRate = avgDailySales / Math.max(1, currentStock);
    
    if (turnoverRate > 0.5) return 'fast'; // 50%+ per day
    if (turnoverRate > 0.2) return 'medium'; // 20-50% per day
    if (turnoverRate > 0.05) return 'slow'; // 5-20% per day
    return 'very_slow';
  }

  // ========================================================================
  // GENERATE REORDER RECOMMENDATIONS
  // ========================================================================
  
  async generateReorderRecommendations() {
    const velocity = this.salesHistory.size === 0 
      ? await this.analyzeSalesVelocity() 
      : this.salesHistory;
    
    const recommendations = [];
    
    velocity.forEach((data, product) => {
      const { currentStock, avgDailySales, daysUntilStockout, velocity } = data;
      
      // Reorder point logic
      let shouldReorder = false;
      let urgency = 'low';
      let recommendedQuantity = 0;
      
      // Critical: < 3 days
      if (daysUntilStockout <= 3) {
        shouldReorder = true;
        urgency = 'critical';
        recommendedQuantity = Math.ceil(avgDailySales * 14); // 2 weeks supply
      }
      // Warning: < 7 days
      else if (daysUntilStockout <= 7) {
        shouldReorder = true;
        urgency = 'high';
        recommendedQuantity = Math.ceil(avgDailySales * 14);
      }
      // Low stock for fast movers
      else if (velocity === 'fast' && currentStock < avgDailySales * 10) {
        shouldReorder = true;
        urgency = 'medium';
        recommendedQuantity = Math.ceil(avgDailySales * 21); // 3 weeks
      }
      
      if (shouldReorder) {
        recommendations.push({
          product,
          currentStock,
          daysUntilStockout,
          avgDailySales: avgDailySales.toFixed(1),
          velocity,
          urgency,
          recommendedQuantity,
          estimatedCost: this.estimateCost(product, recommendedQuantity)
        });
      }
    });
    
    // Sort by urgency
    const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    recommendations.sort((a, b) => 
      urgencyOrder[a.urgency] - urgencyOrder[b.urgency]
    );
    
    return recommendations;
  }

  estimateCost(product, quantity) {
    const stockCache = getStockCache();
    const item = stockCache.find(s => s.item === product);
    return item ? item.cost * quantity : 0;
  }

  // ========================================================================
  // GENERATE REPORT
  // ========================================================================
  
  async generateStockReport() {
    const recommendations = await this.generateReorderRecommendations();
    
    if (recommendations.length === 0) {
      return '✅ สต็อกทุกรายการเพียงพอ\n\nไม่มีสินค้าที่ต้องสั่งซื้อในขณะนี้';
    }
    
    let report = `📋 รายการสั่งซื้อสินค้า\n${'='.repeat(40)}\n\n`;
    
    const critical = recommendations.filter(r => r.urgency === 'critical');
    const high = recommendations.filter(r => r.urgency === 'high');
    const medium = recommendations.filter(r => r.urgency === 'medium');
    
    if (critical.length > 0) {
      report += `🔴 สั่งด่วนมาก (${critical.length} รายการ):\n`;
      critical.forEach(r => {
        report += `• ${r.product}\n`;
        report += `  📦 เหลือ: ${r.currentStock} (พอ ${r.daysUntilStockout} วัน)\n`;
        report += `  📈 ขายเฉลี่ย: ${r.avgDailySales}/วัน\n`;
        report += `  ✅ แนะนำสั่ง: ${r.recommendedQuantity} (≈${r.estimatedCost.toLocaleString()}฿)\n\n`;
      });
    }
    
    if (high.length > 0) {
      report += `🟡 สั่งเร็วๆ นี้ (${high.length} รายการ):\n`;
      high.slice(0, 5).forEach(r => {
        report += `• ${r.product}: เหลือ ${r.currentStock} → สั่ง ${r.recommendedQuantity}\n`;
      });
      if (high.length > 5) {
        report += `  ... และอีก ${high.length - 5} รายการ\n`;
      }
      report += '\n';
    }
    
    if (medium.length > 0) {
      report += `🟢 พิจารณาสั่ง (${medium.length} รายการ)\n\n`;
    }
    
    const totalCost = recommendations.reduce((sum, r) => sum + r.estimatedCost, 0);
    report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    report += `💰 ต้นทุนรวม (ประมาณ): ${totalCost.toLocaleString()}฿`;
    
    return report;
  }

  // ========================================================================
  // ABC ANALYSIS
  // ========================================================================
  
  async performABCAnalysis() {
    const velocity = this.salesHistory.size === 0 
      ? await this.analyzeSalesVelocity() 
      : this.salesHistory;
    
    const items = Array.from(velocity.values())
      .filter(v => v.totalSold > 0)
      .sort((a, b) => b.totalSold - a.totalSold);
    
    const totalSales = items.reduce((sum, item) => sum + item.totalSold, 0);
    
    let cumulative = 0;
    const abc = { A: [], B: [], C: [] };
    
    items.forEach(item => {
      cumulative += item.totalSold;
      const percentage = (cumulative / totalSales) * 100;
      
      if (percentage <= 80) {
        abc.A.push(item.name);
      } else if (percentage <= 95) {
        abc.B.push(item.name);
      } else {
        abc.C.push(item.name);
      }
    });
    
    let report = `📊 ABC Analysis (Last 30 Days)\n${'='.repeat(40)}\n\n`;
    report += `🔴 Class A (Top 80% sales) - ${abc.A.length} items:\n`;
    report += `   → Focus: Never stockout, tight control\n`;
    abc.A.slice(0, 10).forEach(name => report += `   • ${name}\n`);
    if (abc.A.length > 10) report += `   ... และอีก ${abc.A.length - 10} รายการ\n`;
    
    report += `\n🟡 Class B (Next 15%) - ${abc.B.length} items:\n`;
    report += `   → Focus: Moderate control\n`;
    
    report += `\n🟢 Class C (Last 5%) - ${abc.C.length} items:\n`;
    report += `   → Focus: Minimal monitoring\n`;
    
    return report;
  }

  // ========================================================================
  // STOCK HEALTH DASHBOARD
  // ========================================================================
  
  async getStockHealth() {
    const stockCache = getStockCache();
    const velocity = this.salesHistory.size === 0 
      ? await this.analyzeSalesVelocity() 
      : this.salesHistory;
    
    const health = {
      total: stockCache.length,
      outOfStock: stockCache.filter(s => s.stock === 0).length,
      lowStock: stockCache.filter(s => s.stock > 0 && s.stock <= 5).length,
      fastMovers: Array.from(velocity.values()).filter(v => v.velocity === 'fast').length,
      dormant: Array.from(velocity.values()).filter(v => v.velocity === 'dormant').length
    };
    
    const healthScore = Math.max(0, 100 - (health.outOfStock * 5) - (health.lowStock * 2));
    
    let report = `💊 Stock Health Score: ${healthScore}/100\n${'='.repeat(40)}\n\n`;
    report += `📦 Total SKUs: ${health.total}\n`;
    report += `🔴 Out of Stock: ${health.outOfStock}\n`;
    report += `🟡 Low Stock: ${health.lowStock}\n`;
    report += `⚡ Fast Movers: ${health.fastMovers}\n`;
    report += `💤 Dormant: ${health.dormant}\n\n`;
    
    if (healthScore >= 90) {
      report += `✅ สุขภาพสต็อกดีเยี่ยม!`;
    } else if (healthScore >= 70) {
      report += `⚠️ สต็อกปานกลาง - ควรตรวจสอบ`;
    } else {
      report += `🚨 สต็อกมีปัญหา - ต้องดูแลด่วน!`;
    }
    
    return report;
  }
}

// Singleton
const stockPredictor = new StockPredictor();

module.exports = {
  StockPredictor,
  stockPredictor
};