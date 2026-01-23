// monitoring.js - Comprehensive System Monitoring

const { Logger } = require('./logger');
const { CONFIG } = require('./config');

// ============================================================================
// METRICS COLLECTOR
// ============================================================================

class MetricsCollector {
  constructor() {
    this.metrics = {
      orders: {
        total: 0,
        successful: 0,
        failed: 0,
        avgProcessingTime: 0,
        processingTimes: []
      },
      api: {
        groqCalls: 0,
        groqErrors: 0,
        groqAvgLatency: 0,
        latencies: []
      },
      cache: {
        stockHits: 0,
        stockMisses: 0,
        customerHits: 0,
        customerMisses: 0
      },
      errors: {
        total: 0,
        by_type: {}
      },
      system: {
        startTime: Date.now(),
        lastHealthCheck: Date.now()
      }
    };
    
    this.alerts = [];
    this.maxMetricsHistory = 1000;
  }

  // ========================================================================
  // ORDER METRICS
  // ========================================================================
  
  recordOrder(success, processingTime) {
    this.metrics.orders.total++;
    
    if (success) {
      this.metrics.orders.successful++;
    } else {
      this.metrics.orders.failed++;
    }
    
    // Track processing time
    this.metrics.orders.processingTimes.push(processingTime);
    if (this.metrics.orders.processingTimes.length > this.maxMetricsHistory) {
      this.metrics.orders.processingTimes.shift();
    }
    
    // Calculate average
    const times = this.metrics.orders.processingTimes;
    this.metrics.orders.avgProcessingTime = 
      times.reduce((a, b) => a + b, 0) / times.length;
    
    // Alert if processing is slow
    if (processingTime > 10000) { // 10 seconds
      this.createAlert('slow_order', `Order processing took ${processingTime}ms`, 'warning');
    }
  }

  // ========================================================================
  // API METRICS
  // ========================================================================
  
  recordAPICall(provider, success, latency) {
    this.metrics.api.groqCalls++;
    
    if (!success) {
      this.metrics.api.groqErrors++;
      
      // Alert on high error rate
      const errorRate = this.metrics.api.groqErrors / this.metrics.api.groqCalls;
      if (errorRate > 0.1) { // 10% error rate
        this.createAlert('high_api_errors', `API error rate: ${(errorRate * 100).toFixed(1)}%`, 'critical');
      }
    }
    
    if (latency) {
      this.metrics.api.latencies.push(latency);
      if (this.metrics.api.latencies.length > this.maxMetricsHistory) {
        this.metrics.api.latencies.shift();
      }
      
      const latencies = this.metrics.api.latencies;
      this.metrics.api.groqAvgLatency = 
        latencies.reduce((a, b) => a + b, 0) / latencies.length;
    }
  }

  // ========================================================================
  // CACHE METRICS
  // ========================================================================
  
  recordCacheAccess(type, hit) {
    if (type === 'stock') {
      if (hit) {
        this.metrics.cache.stockHits++;
      } else {
        this.metrics.cache.stockMisses++;
      }
    } else if (type === 'customer') {
      if (hit) {
        this.metrics.cache.customerHits++;
      } else {
        this.metrics.cache.customerMisses++;
      }
    }
  }

  getCacheHitRate(type) {
    if (type === 'stock') {
      const total = this.metrics.cache.stockHits + this.metrics.cache.stockMisses;
      return total > 0 ? (this.metrics.cache.stockHits / total * 100).toFixed(1) : 0;
    } else {
      const total = this.metrics.cache.customerHits + this.metrics.cache.customerMisses;
      return total > 0 ? (this.metrics.cache.customerHits / total * 100).toFixed(1) : 0;
    }
  }

  // ========================================================================
  // ERROR TRACKING
  // ========================================================================
  
  recordError(errorType, error) {
    this.metrics.errors.total++;
    
    if (!this.metrics.errors.by_type[errorType]) {
      this.metrics.errors.by_type[errorType] = {
        count: 0,
        lastOccurrence: null,
        samples: []
      };
    }
    
    const typeMetrics = this.metrics.errors.by_type[errorType];
    typeMetrics.count++;
    typeMetrics.lastOccurrence = new Date().toISOString();
    
    // Store error samples (last 5)
    typeMetrics.samples.push({
      message: error.message,
      timestamp: new Date().toISOString()
    });
    if (typeMetrics.samples.length > 5) {
      typeMetrics.samples.shift();
    }
    
    // Alert on error spikes
    if (typeMetrics.count > 10 && typeMetrics.count % 10 === 0) {
      this.createAlert(
        'error_spike',
        `${errorType} occurred ${typeMetrics.count} times`,
        'warning'
      );
    }
  }

  // ========================================================================
  // ALERTS
  // ========================================================================
  
  createAlert(type, message, severity = 'info') {
    const alert = {
      type,
      message,
      severity,
      timestamp: new Date().toISOString()
    };
    
    this.alerts.push(alert);
    
    // Keep only last 100 alerts
    if (this.alerts.length > 100) {
      this.alerts.shift();
    }
    
    // Log critical alerts
    if (severity === 'critical') {
      Logger.error(`🚨 ALERT: ${message}`);
    } else if (severity === 'warning') {
      Logger.warn(`⚠️ ALERT: ${message}`);
    }
  }

  getActiveAlerts() {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    return this.alerts.filter(a => 
      new Date(a.timestamp).getTime() > oneHourAgo
    );
  }

  // ========================================================================
  // SYSTEM HEALTH
  // ========================================================================
  
  async checkHealth() {
    this.metrics.system.lastHealthCheck = Date.now();
    const health = {
      status: 'healthy',
      checks: {},
      issues: []
    };
    
    // Check order success rate
    const orderSuccessRate = this.metrics.orders.total > 0 
      ? (this.metrics.orders.successful / this.metrics.orders.total * 100)
      : 100;
    
    health.checks.orders = {
      status: orderSuccessRate >= 90 ? 'ok' : orderSuccessRate >= 70 ? 'warning' : 'critical',
      successRate: orderSuccessRate.toFixed(1) + '%',
      total: this.metrics.orders.total
    };
    
    if (orderSuccessRate < 90) {
      health.issues.push(`Low order success rate: ${orderSuccessRate.toFixed(1)}%`);
      health.status = orderSuccessRate >= 70 ? 'degraded' : 'unhealthy';
    }
    
    // Check API error rate
    const apiErrorRate = this.metrics.api.groqCalls > 0
      ? (this.metrics.api.groqErrors / this.metrics.api.groqCalls * 100)
      : 0;
    
    health.checks.api = {
      status: apiErrorRate <= 5 ? 'ok' : apiErrorRate <= 15 ? 'warning' : 'critical',
      errorRate: apiErrorRate.toFixed(1) + '%',
      totalCalls: this.metrics.api.groqCalls
    };
    
    if (apiErrorRate > 5) {
      health.issues.push(`High API error rate: ${apiErrorRate.toFixed(1)}%`);
      if (health.status === 'healthy') {
        health.status = 'degraded';
      }
    }
    
    // Check cache performance
    const stockCacheHitRate = parseFloat(this.getCacheHitRate('stock'));
    health.checks.cache = {
      status: stockCacheHitRate >= 80 ? 'ok' : stockCacheHitRate >= 60 ? 'warning' : 'critical',
      stockHitRate: stockCacheHitRate + '%',
      customerHitRate: this.getCacheHitRate('customer') + '%'
    };
    
    if (stockCacheHitRate < 80) {
      health.issues.push(`Low cache hit rate: ${stockCacheHitRate}%`);
    }
    
    // Check memory usage
    const memUsage = process.memoryUsage();
    const heapUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
    const heapTotalMB = (memUsage.heapTotal / 1024 / 1024).toFixed(2);
    const heapPercent = (memUsage.heapUsed / memUsage.heapTotal * 100).toFixed(1);
    
    health.checks.memory = {
      status: heapPercent < 80 ? 'ok' : heapPercent < 90 ? 'warning' : 'critical',
      heapUsed: heapUsedMB + 'MB',
      heapTotal: heapTotalMB + 'MB',
      heapPercent: heapPercent + '%'
    };
    
    if (heapPercent >= 80) {
      health.issues.push(`High memory usage: ${heapPercent}%`);
      if (health.status === 'healthy') {
        health.status = 'degraded';
      }
    }
    
    // Check uptime
    const uptimeHours = ((Date.now() - this.metrics.system.startTime) / 1000 / 60 / 60).toFixed(2);
    health.checks.uptime = {
      status: 'ok',
      hours: uptimeHours
    };
    
    // Check active alerts
    const activeAlerts = this.getActiveAlerts();
    const criticalAlerts = activeAlerts.filter(a => a.severity === 'critical');
    
    if (criticalAlerts.length > 0) {
      health.status = 'unhealthy';
      health.issues.push(`${criticalAlerts.length} critical alerts active`);
    }
    
    return health;
  }

  // ========================================================================
  // REPORT GENERATION
  // ========================================================================
  
  generateReport() {
    const uptime = ((Date.now() - this.metrics.system.startTime) / 1000 / 60 / 60).toFixed(2);
    const orderSuccessRate = this.metrics.orders.total > 0 
      ? (this.metrics.orders.successful / this.metrics.orders.total * 100).toFixed(1)
      : 0;
    const apiErrorRate = this.metrics.api.groqCalls > 0
      ? (this.metrics.api.groqErrors / this.metrics.api.groqCalls * 100).toFixed(1)
      : 0;
    
    let report = `📊 System Metrics Report\n`;
    report += `${'='.repeat(40)}\n\n`;
    
    report += `⏰ Uptime: ${uptime} hours\n\n`;
    
    report += `📦 Orders:\n`;
    report += `  • Total: ${this.metrics.orders.total}\n`;
    report += `  • Successful: ${this.metrics.orders.successful}\n`;
    report += `  • Failed: ${this.metrics.orders.failed}\n`;
    report += `  • Success Rate: ${orderSuccessRate}%\n`;
    report += `  • Avg Processing: ${this.metrics.orders.avgProcessingTime.toFixed(0)}ms\n\n`;
    
    report += `🤖 AI API:\n`;
    report += `  • Total Calls: ${this.metrics.api.groqCalls}\n`;
    report += `  • Errors: ${this.metrics.api.groqErrors}\n`;
    report += `  • Error Rate: ${apiErrorRate}%\n`;
    report += `  • Avg Latency: ${this.metrics.api.groqAvgLatency.toFixed(0)}ms\n\n`;
    
    report += `💾 Cache:\n`;
    report += `  • Stock Hit Rate: ${this.getCacheHitRate('stock')}%\n`;
    report += `  • Customer Hit Rate: ${this.getCacheHitRate('customer')}%\n\n`;
    
    report += `❌ Errors:\n`;
    report += `  • Total: ${this.metrics.errors.total}\n`;
    
    const topErrors = Object.entries(this.metrics.errors.by_type)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5);
    
    if (topErrors.length > 0) {
      report += `  • Top Issues:\n`;
      topErrors.forEach(([type, data]) => {
        report += `    - ${type}: ${data.count} times\n`;
      });
    }
    
    const activeAlerts = this.getActiveAlerts();
    if (activeAlerts.length > 0) {
      report += `\n🚨 Active Alerts (${activeAlerts.length}):\n`;
      activeAlerts.slice(0, 5).forEach(alert => {
        const icon = alert.severity === 'critical' ? '🔴' : 
                     alert.severity === 'warning' ? '🟡' : 'ℹ️';
        report += `  ${icon} ${alert.message}\n`;
      });
    }
    
    return report;
  }

  // ========================================================================
  // RESET METRICS
  // ========================================================================
  
  reset() {
    this.metrics = {
      orders: {
        total: 0,
        successful: 0,
        failed: 0,
        avgProcessingTime: 0,
        processingTimes: []
      },
      api: {
        groqCalls: 0,
        groqErrors: 0,
        groqAvgLatency: 0,
        latencies: []
      },
      cache: {
        stockHits: 0,
        stockMisses: 0,
        customerHits: 0,
        customerMisses: 0
      },
      errors: {
        total: 0,
        by_type: {}
      },
      system: {
        startTime: Date.now(),
        lastHealthCheck: Date.now()
      }
    };
    
    this.alerts = [];
    Logger.info('📊 Metrics reset');
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

const metricsCollector = new MetricsCollector();

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  MetricsCollector,
  metricsCollector
};
