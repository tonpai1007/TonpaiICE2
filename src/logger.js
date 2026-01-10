// logger.js - Centralized logging and performance monitoring

const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'line-order-bot' },
  transports: [
    new winston.transports.File({ 
      filename: 'error.log', 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: 'combined.log',
      maxsize: 5242880,
      maxFiles: 5
    })
  ]
});
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
