// logger.js - Simple console logger (no external dependencies)

// ============================================================================
// SIMPLE LOGGER - Works everywhere
// ============================================================================

class SimpleLogger {
  constructor() {
    // ✅ FIX: Don't import config here - use environment variable directly
    this.level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
    this.levels = {
      debug: 0,
      info: 1,
      success: 1,
      warn: 2,
      error: 3
    };
  }

  _shouldLog(level) {
    const currentLevel = this.levels[this.level] || 1;
    const messageLevel = this.levels[level] || 1;
    return messageLevel >= currentLevel;
  }

  _format(level, message, data) {
    const timestamp = new Date().toISOString();
    const levelUpper = level.toUpperCase().padEnd(7);
    
    let logMessage = `${levelUpper} [${timestamp}] - ${message}`;
    
    if (data) {
      if (data instanceof Error) {
        logMessage += `\n  Error: ${data.message}`;
        if (data.stack && this.level === 'debug') {
          logMessage += `\n  Stack: ${data.stack}`;
        }
      } else if (typeof data === 'object') {
        logMessage += `\n  ${JSON.stringify(data, null, 2)}`;
      } else {
        logMessage += `\n  ${data}`;
      }
    }
    
    return logMessage;
  }

  debug(message, data) {
    if (this._shouldLog('debug')) {
      console.log(this._format('debug', message, data));
    }
  }

  info(message, data) {
    if (this._shouldLog('info')) {
      console.log(this._format('info', message, data));
    }
  }

  success(message, data) {
    if (this._shouldLog('success')) {
      console.log(this._format('success', message, data));
    }
  }

  warn(message, data) {
    if (this._shouldLog('warn')) {
      console.warn(this._format('warn', message, data));
    }
  }

  error(message, data) {
    if (this._shouldLog('error')) {
      console.error(this._format('error', message, data));
    }
  }
}

// ============================================================================
// PERFORMANCE MONITOR
// ============================================================================

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

// ============================================================================
// SINGLETON INSTANCES
// ============================================================================


const performanceMonitor = new PerformanceMonitor();

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  SimpleLogger,
  PerformanceMonitor: performanceMonitor
};