require('dotenv').config();

class ConfigManager {
  constructor() {
    this._config = {
      // Google Sheets
      SHEET_ID: process.env.SHEET_ID,
      
      // LINE Bot
      LINE_TOKEN: process.env.LINE_TOKEN,
      LINE_SECRET: process.env.LINE_SECRET,
      
      // AI Services
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY,
      
      // Google Drive
      VOICE_FOLDER_ID: process.env.VOICE_FOLDER_ID,
      
      // Payment
      PROMPTPAY_ID: process.env.PROMPTPAY_ID || null,
      
      // Admin - Support multiple admins
      ADMIN_USER_IDS: (process.env.ADMIN_USER_IDS || '').split(',').filter(Boolean),
      
      // Feature flags
      ALLOW_USER_ORDERS: true,
      ALLOW_USER_STOCK_VIEW: false,
      ALLOW_USER_REFRESH: false,
      LOW_STOCK_THRESHOLD: 10,
      MAX_ORDER_QUANTITY: 1000,
      
      // Voice settings
      VOICE_MIN_CONFIDENCE: 0.55,
      VOICE_MIN_TEXT_LENGTH: 3,
      
      // Cache settings
      CACHE_DURATION: 5 * 60 * 1000, // 5 minutes
      
      // Retry settings
      MAX_RETRIES: 3,
      INITIAL_RETRY_DELAY: 1000,
      
      // Confidence thresholds
      CONFIDENCE_THRESHOLD: {
        HIGH: 200,
        MEDIUM: 120,
        LOW: 60
      },
      
      // Daily summary time
      DAILY_SUMMARY_TIME: '20:00'
    };
    
    this._validated = false;
  }

  /**
   * Safe getter with default value support
   * @param {string} key - Config key (supports nested paths like 'CONFIDENCE_THRESHOLD.HIGH')
   * @param {any} defaultValue - Default value if key not found
   * @returns {any} Config value or default
   */
  get(key, defaultValue = null) {
    if (!key) return defaultValue;
    
    // Handle nested keys (e.g., 'CONFIDENCE_THRESHOLD.HIGH')
    const keys = key.split('.');
    let value = this._config;
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return defaultValue;
      }
    }
    
    return value !== undefined && value !== null ? value : defaultValue;
  }

  /**
   * Get all config as object
   */
  getAll() {
    return { ...this._config };
  }

  /**
   * Check if config key exists
   */
  has(key) {
    return this.get(key) !== null;
  }

  /**
   * Validate required environment variables
   */
  validate() {
    if (this._validated) return true;

    const required = [
      'SHEET_ID',
      'LINE_TOKEN',
      'LINE_SECRET',
      'GEMINI_API_KEY',
      'ASSEMBLYAI_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS_BASE64'
    ];
    
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      throw new Error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    }
    
    const recommended = ['ADMIN_USER_IDS', 'VOICE_FOLDER_ID'];
    const missingRecommended = recommended.filter(key => !process.env[key]);
    
    if (missingRecommended.length > 0) {
      console.warn(`⚠️  Warning: Missing recommended variables: ${missingRecommended.join(', ')}`);
      console.warn('Some features may not work properly without these.');
    }

    this._validated = true;
    return true;
  }

  /**
   * Load and parse Google credentials
   */
  loadGoogleCredentials() {
    try {
      const base64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;
      if (!base64) throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS_BASE64');
      
      const jsonString = Buffer.from(base64, 'base64').toString('utf-8');
      return JSON.parse(jsonString);
    } catch (error) {
      throw new Error(`Failed to load Google credentials: ${error.message}`);
    }
  }

  /**
   * Get environment info for diagnostics
   */
  getEnvironmentInfo() {
    return {
      nodeEnv: process.env.NODE_ENV || 'development',
      port: process.env.PORT || 3000,
      hasAdmins: this._config.ADMIN_USER_IDS.length > 0,
      adminCount: this._config.ADMIN_USER_IDS.length,
      hasVoiceFolder: !!this._config.VOICE_FOLDER_ID,
      hasPromptPay: !!this._config.PROMPTPAY_ID,
      cacheEnabled: this._config.CACHE_DURATION > 0,
      lowStockAlert: this._config.LOW_STOCK_THRESHOLD,
      maxOrderQty: this._config.MAX_ORDER_QUANTITY
    };
  }
}

// Create singleton instance
const configManager = new ConfigManager();

// Export both CONFIG object (backward compatibility) and methods
module.exports = {
  CONFIG: configManager.getAll(),
  validateConfig: () => configManager.validate(),
  loadGoogleCredentials: () => configManager.loadGoogleCredentials(),
  getEnvironmentInfo: () => configManager.getEnvironmentInfo(),
  configManager // Export manager for .get() method
};