// logger.js - Centralized logging and performance monitoring

class Logger {
  static info(message, ...args) {
    console.log(`ℹ️ [INFO] ${new Date().toISOString()} - ${message}`, ...args);
  }
  
  static success(message, ...args) {
    console.log(`✅ [SUCCESS] ${new Date().toISOString()} - ${message}`, ...args);
  }
  
  static warn(message, ...args) {
    console.warn(`⚠️ [WARN] ${new Date().toISOString()} - ${message}`, ...args);
  }
  
  static error(message, error) {
    console.error(`❌ [ERROR] ${new Date().toISOString()} - ${message}`, error?.message || error);
    if (error?.stack) {
      console.error('Stack trace:', error.stack);
    }
  }
  
  static debug(message, data) {
    if (process.env.DEBUG === 'true') {
      console.log(`🔍 [DEBUG] ${new Date().toISOString()} - ${message}`, data);
    }
  }
}

class PerformanceMonitor {
  constructor() {
    this.timers = new Map();
  }
  
  start(label) {
    this.timers.set(label, Date.now());
  }
  
  end(label) {
    const startTime = this.timers.get(label);
    if (startTime) {
      const duration = Date.now() - startTime;
      Logger.debug(`${label} took ${duration}ms`);
      this.timers.delete(label);
      return duration;
    }
    return 0;
  }
}

const performanceMonitor = new PerformanceMonitor();

module.exports = {
  Logger,
  PerformanceMonitor: performanceMonitor
};
