// src/config.js - UPDATED: Multi-AI provider support
require('dotenv').config();

class ConfigManager {
  constructor() {
    this._config = {
      // Google Sheets
      SHEET_ID: process.env.SHEET_ID,
      
      // LINE Bot
      LINE_TOKEN: process.env.LINE_TOKEN,
      LINE_SECRET: process.env.LINE_SECRET,
      
      // AI Provider Selection
      AI_PROVIDER: process.env.AI_PROVIDER || 'groq', // 'groq' | 'ollama' | 'openrouter'
      
      // AI Service Keys (only need one based on provider)
      GROQ_API_KEY: process.env.GROQ_API_KEY,
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      
      // Admin
      ADMIN_USER_IDS: (process.env.ADMIN_USER_IDS || '').split(',').filter(Boolean),
      
      // Config
      CACHE_DURATION: 5 * 60 * 1000,
      PORT: process.env.PORT || 3000,
      NODE_ENV: process.env.NODE_ENV || 'development'
    };
    
    this._validated = false;
  }

  get(key) { 
    return this._config[key]; 
  }
  
  getAll() { 
    return { ...this._config }; 
  }

  validate() {
    if (this._validated) return true;

    // Required for all setups
    const required = [
      'SHEET_ID',
      'LINE_TOKEN',
      'LINE_SECRET',
      'GOOGLE_APPLICATION_CREDENTIALS_BASE64'
    ];
    
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(`❌ Missing required: ${missing.join(', ')}`);
    }

    // Validate AI provider config
    const provider = this._config.AI_PROVIDER;
    
    switch (provider) {
      case 'groq':
        if (!this._config.GROQ_API_KEY) {
          throw new Error('❌ GROQ_API_KEY required when AI_PROVIDER=groq');
        }
        break;
      
      case 'ollama':
        // Ollama doesn't need API key, just URL
        console.log(`✅ Using Ollama at ${this._config.OLLAMA_BASE_URL}`);
        break;
      
      case 'openrouter':
        if (!this._config.OPENROUTER_API_KEY) {
          throw new Error('❌ OPENROUTER_API_KEY required when AI_PROVIDER=openrouter');
        }
        break;
      
      default:
        throw new Error(`❌ Unknown AI_PROVIDER: ${provider}. Use 'groq', 'ollama', or 'openrouter'`);
    }

    this._validated = true;
    console.log(`✅ Config validated (AI Provider: ${provider})`);
    return true;
  }

  loadGoogleCredentials() {
    const base64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;
    if (!base64) {
      throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS_BASE64');
    }
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
  }

  getAIProviderInfo() {
    const provider = this._config.AI_PROVIDER;
    
    const info = {
      groq: {
        name: 'Groq',
        cost: 'FREE',
        model: 'llama-3.3-70b-versatile',
        speed: 'Very Fast',
        limits: '~30 req/min'
      },
      ollama: {
        name: 'Ollama',
        cost: 'FREE (Local)',
        model: 'llama3.2:3b',
        speed: 'Medium',
        limits: 'Unlimited'
      },
      openrouter: {
        name: 'OpenRouter',
        cost: 'FREE tier',
        model: 'llama-3.2-3b-instruct:free',
        speed: 'Fast',
        limits: 'Varies'
      }
    };
    
    return info[provider] || { name: 'Unknown' };
  }
}

const configManager = new ConfigManager();

module.exports = {
  CONFIG: configManager.getAll(),
  validateConfig: () => configManager.validate(),
  loadGoogleCredentials: () => configManager.loadGoogleCredentials(),
  configManager
};
