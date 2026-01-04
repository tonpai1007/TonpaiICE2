// src/config.js
require('dotenv').config();

class ConfigManager {
  constructor() {
    this._config = {
      // Google Sheets
      SHEET_ID: process.env.SHEET_ID,
      
      // LINE Bot (เหลือแค่นี้พอ)
      LINE_TOKEN: process.env.LINE_TOKEN,
      LINE_SECRET: process.env.LINE_SECRET,
      
      // AI Services
      GROQ_API_KEY: process.env.GROQ_API_KEY,
      
      // Admin
      ADMIN_USER_IDS: (process.env.ADMIN_USER_IDS || '').split(',').filter(Boolean),
      
      // Config อื่นๆ
      CACHE_DURATION: 5 * 60 * 1000
    };
    
    this._validated = false;
  }

  get(key) { return this._config[key]; }
  getAll() { return { ...this._config }; }

  validate() {
    if (this._validated) return true;

    // เช็คแค่นี้พอ เพื่อให้รันผ่านแน่นอน
    const required = [
      'SHEET_ID',
      'LINE_TOKEN',
      'LINE_SECRET',
      'GROQ_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS_BASE64'
    ];
    
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) throw new Error(`❌ Missing: ${missing.join(', ')}`);

    this._validated = true;
    return true;
  }

  loadGoogleCredentials() {
    const base64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
  }
}

const configManager = new ConfigManager();
module.exports = {
  CONFIG: configManager.getAll(),
  validateConfig: () => configManager.validate(),
  loadGoogleCredentials: () => configManager.loadGoogleCredentials(),
  configManager
};