require('dotenv').config();

class ConfigManager {
  constructor() {
    this._config = {
      // Google Sheets
      SHEET_ID: process.env.SHEET_ID,
      
      // LINE Bot
      LINE_TOKEN: process.env.LINE_TOKEN,
      LINE_SECRET: process.env.LINE_SECRET,
      LINE_NOTIFY_TOKEN: process.env.LINE_NOTIFY_TOKEN, // ✅ NEW
      
      // AI Services
      GROQ_API_KEY: process.env.GROQ_API_KEY, // ✅ NEW (replace Gemini)
      
      // Admin
      ADMIN_USER_IDS: (process.env.ADMIN_USER_IDS || '').split(',').filter(Boolean),
      
      // Feature flags
      LOW_STOCK_THRESHOLD: 10,
      MAX_ORDER_QUANTITY: 1000,
      CACHE_DURATION: 5 * 60 * 1000
    };
    
    this._validated = false;
  }

  get(key, defaultValue = null) {
    if (!key) return defaultValue;
    
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

  getAll() {
    return { ...this._config };
  }

  validate() {
    if (this._validated) return true;

    const required = [
      'SHEET_ID',
      'LINE_TOKEN',
      'LINE_SECRET',
      'GROQ_API_KEY', // ✅ Changed from GEMINI_API_KEY
      'GOOGLE_APPLICATION_CREDENTIALS_BASE64'
    ];
    
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      throw new Error(`❌ Missing: ${missing.join(', ')}`);
    }
    
    const recommended = ['ADMIN_USER_IDS', 'LINE_NOTIFY_TOKEN'];
    const missingRecommended = recommended.filter(key => !process.env[key]);
    
    if (missingRecommended.length > 0) {
      console.warn(`⚠️ Missing recommended: ${missingRecommended.join(', ')}`);
    }

    this._validated = true;
    return true;
  }

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
}

const configManager = new ConfigManager();

module.exports = {
  CONFIG: configManager.getAll(),
  validateConfig: () => configManager.validate(),
  loadGoogleCredentials: () => configManager.loadGoogleCredentials(),
  configManager
};