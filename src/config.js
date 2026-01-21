// config.js - ENHANCED: Comprehensive validation & error handling

require('dotenv').config();

// ============================================================================
// CONFIGURATION VALIDATOR
// ============================================================================

class ConfigValidator {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.info = [];
  }

  validate(config) {
    this.errors = [];
    this.warnings = [];
    this.info = [];
    
    // Required fields
    this.checkRequired('SHEET_ID', config.SHEET_ID);
    this.checkRequired('LINE_TOKEN', config.LINE_TOKEN);
    this.checkRequired('LINE_SECRET', config.LINE_SECRET);
    this.checkRequired('GOOGLE_APPLICATION_CREDENTIALS_BASE64', 
      process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64);
    
    // LINE Token validation
    if (config.LINE_TOKEN && !config.LINE_TOKEN.startsWith('Bearer ')) {
      // Auto-fix: add Bearer prefix if missing
      config.LINE_TOKEN = `Bearer ${config.LINE_TOKEN}`;
      this.info.push('✅ Auto-fixed: Added "Bearer " prefix to LINE_TOKEN');
    }
    
    // Sheet ID format validation
    if (config.SHEET_ID && !this.isValidSheetId(config.SHEET_ID)) {
      this.warnings.push('⚠️ SHEET_ID format looks unusual - verify it\'s correct');
    }
    
    // AI Provider validation
    const validProviders = ['groq', 'ollama', 'openrouter'];
    if (!validProviders.includes(config.AI_PROVIDER)) {
      this.errors.push(`❌ Invalid AI_PROVIDER: ${config.AI_PROVIDER}. Must be: ${validProviders.join(', ')}`);
    }
    
    // Provider-specific validation
    switch (config.AI_PROVIDER) {
      case 'groq':
        this.checkRequired('GROQ_API_KEY', config.GROQ_API_KEY);
        if (config.GROQ_API_KEY && !config.GROQ_API_KEY.startsWith('gsk_')) {
          this.warnings.push('⚠️ GROQ_API_KEY format looks incorrect (should start with "gsk_")');
        }
        break;
      
      case 'ollama':
        if (!config.OLLAMA_BASE_URL) {
          this.warnings.push('⚠️ OLLAMA_BASE_URL not set, using default: http://localhost:11434');
        }
        // Check if GROQ key available for audio fallback
        if (!config.GROQ_API_KEY) {
          this.warnings.push('⚠️ No GROQ_API_KEY - voice messages will not work with Ollama');
          this.info.push('💡 Add GROQ_API_KEY for free audio transcription');
        }
        break;
      
      case 'openrouter':
        this.checkRequired('OPENROUTER_API_KEY', config.OPENROUTER_API_KEY);
        break;
    }
    
    // Admin users
    if (!config.ADMIN_USER_IDS || config.ADMIN_USER_IDS.length === 0) {
      this.warnings.push('⚠️ No ADMIN_USER_IDS configured - no one will have admin access');
      this.info.push('💡 Add ADMIN_USER_IDS to .env (comma-separated LINE user IDs)');
    } else {
      this.info.push(`✅ ${config.ADMIN_USER_IDS.length} admin user(s) configured`);
    }
    
    // Environment check
    if (config.NODE_ENV === 'production') {
      // Production-specific checks
      if (!process.env.PORT) {
        this.warnings.push('⚠️ PORT not set in production - using default 3000');
      }
      
      // Security checks
      if (config.LINE_SECRET && config.LINE_SECRET.length < 20) {
        this.warnings.push('⚠️ LINE_SECRET seems too short');
      }
    } else {
      this.info.push(`ℹ️ Running in ${config.NODE_ENV} mode`);
    }
    
    // Cache duration
    if (config.CACHE_DURATION < 60000) {
      this.warnings.push('⚠️ Cache duration is very short - may cause excessive API calls');
    }
    
    return {
      valid: this.errors.length === 0,
      errors: this.errors,
      warnings: this.warnings,
      info: this.info
    };
  }

  checkRequired(name, value) {
    if (!value || (typeof value === 'string' && value.trim() === '')) {
      this.errors.push(`❌ Missing required: ${name}`);
      return false;
    }
    return true;
  }

  isValidSheetId(sheetId) {
    // Google Sheets IDs are typically 44 characters
    return /^[a-zA-Z0-9_-]{20,}$/.test(sheetId);
  }
}

// ============================================================================
// CONFIG MANAGER
// ============================================================================

class ConfigManager {
  constructor() {
    this._config = null;
    this._validated = false;
    this.validator = new ConfigValidator();
  }

  load() {
    if (this._config) return this._config;
    
    this._config = {
      // Google Sheets
      SHEET_ID: process.env.SHEET_ID?.trim(),
      
      // LINE Bot
      LINE_TOKEN: process.env.LINE_TOKEN?.trim(),
      LINE_SECRET: process.env.LINE_SECRET?.trim(),
      
      // AI Provider
      AI_PROVIDER: (process.env.AI_PROVIDER || 'groq').toLowerCase(),
      
      // AI Keys
      GROQ_API_KEY: process.env.GROQ_API_KEY?.trim(),
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434',
      OLLAMA_MODEL: process.env.OLLAMA_MODEL?.trim() || 'llama3.2:3b',
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY?.trim(),
      
      // Admin
      ADMIN_USER_IDS: (process.env.ADMIN_USER_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean),
      
      // System
      CACHE_DURATION: parseInt(process.env.CACHE_DURATION) || (5 * 60 * 1000),
      PORT: parseInt(process.env.PORT) || 3000,
      NODE_ENV: process.env.NODE_ENV || 'development',
      LOG_LEVEL: process.env.LOG_LEVEL || 'info'
    };
    
    return this._config;
  }

  get(key) {
    if (!this._config) this.load();
    return this._config[key];
  }

  getAll() {
    if (!this._config) this.load();
    return { ...this._config };
  }

  validate() {
    if (this._validated) return true;
    
    if (!this._config) this.load();
    
    const result = this.validator.validate(this._config);
    
    // Print validation results
    console.log('\n📋 Configuration Validation');
    console.log('='.repeat(50));
    
    if (result.errors.length > 0) {
      console.log('\n❌ ERRORS:');
      result.errors.forEach(err => console.log(`  ${err}`));
    }
    
    if (result.warnings.length > 0) {
      console.log('\n⚠️  WARNINGS:');
      result.warnings.forEach(warn => console.log(`  ${warn}`));
    }
    
    if (result.info.length > 0) {
      console.log('\nℹ️  INFO:');
      result.info.forEach(info => console.log(`  ${info}`));
    }
    
    console.log('\n' + '='.repeat(50) + '\n');
    
    if (!result.valid) {
      throw new Error(`Configuration validation failed: ${result.errors.length} error(s)`);
    }
    
    this._validated = true;
    console.log('✅ Configuration validated successfully\n');
    
    return true;
  }

  loadGoogleCredentials() {
    const base64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;
    
    if (!base64) {
      throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS_BASE64');
    }
    
    try {
      const json = Buffer.from(base64, 'base64').toString('utf-8');
      const credentials = JSON.parse(json);
      
      // Validate credential structure
      if (!credentials.private_key || !credentials.client_email) {
        throw new Error('Invalid Google credentials structure');
      }
      
      return credentials;
    } catch (error) {
      if (error.message.includes('Invalid')) {
        throw error;
      }
      throw new Error('Failed to decode Google credentials: ' + error.message);
    }
  }

  getAIProviderInfo() {
    const provider = this.get('AI_PROVIDER');
    
    const info = {
      groq: {
        name: 'Groq',
        cost: 'FREE',
        textModel: 'llama-3.3-70b-versatile',
        audioModel: 'whisper-large-v3',
        speed: 'Very Fast (⚡⚡⚡)',
        limits: '~30 req/min',
        quality: 'Excellent',
        features: ['Text Generation', 'Audio Transcription'],
        recommendation: 'Best overall choice - fast, free, reliable'
      },
      ollama: {
        name: 'Ollama (Local)',
        cost: 'FREE (runs on your machine)',
        textModel: this.get('OLLAMA_MODEL'),
        audioModel: this.get('GROQ_API_KEY') ? 'Groq Whisper (fallback)' : 'Not available',
        speed: 'Medium (⚡⚡)',
        limits: 'Unlimited',
        quality: 'Good (depends on model)',
        features: ['Text Generation', this.get('GROQ_API_KEY') ? 'Audio (via Groq)' : 'No Audio'],
        recommendation: 'Use if you want 100% privacy or offline capability'
      },
      openrouter: {
        name: 'OpenRouter',
        cost: 'FREE tier available',
        textModel: 'llama-3.2-3b-instruct:free',
        audioModel: 'Not available',
        speed: 'Fast (⚡⚡)',
        limits: 'Varies by tier',
        quality: 'Good',
        features: ['Text Generation'],
        recommendation: 'Groq is better for most use cases'
      }
    };
    
    return info[provider] || { name: 'Unknown', error: true };
  }

  printConfig() {
    const providerInfo = this.getAIProviderInfo();
    
    console.log('⚙️  Current Configuration:');
    console.log('─'.repeat(50));
    console.log(`📊 Sheet ID: ${this.get('SHEET_ID')?.substring(0, 20)}...`);
    console.log(`🤖 AI Provider: ${providerInfo.name}`);
    console.log(`   • Model: ${providerInfo.textModel}`);
    console.log(`   • Speed: ${providerInfo.speed}`);
    console.log(`   • Cost: ${providerInfo.cost}`);
    console.log(`👑 Admin Users: ${this.get('ADMIN_USER_IDS').length}`);
    console.log(`🌍 Environment: ${this.get('NODE_ENV')}`);
    console.log(`🔊 Log Level: ${this.get('LOG_LEVEL')}`);
    console.log('─'.repeat(50));
  }

  // For testing - reset validation state
  reset() {
    this._validated = false;
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

const configManager = new ConfigManager();

// ============================================================================
// BACKWARDS COMPATIBLE EXPORTS
// ============================================================================

module.exports = {
  CONFIG: configManager.getAll(),
  validateConfig: () => configManager.validate(),
  loadGoogleCredentials: () => configManager.loadGoogleCredentials(),
  configManager,
  ConfigValidator
};
