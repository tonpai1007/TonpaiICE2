// config.js - Centralized configuration management
require('dotenv').config();

const CONFIG = {
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
  
  // Admin
  ADMIN_USER_IDS: (process.env.ADMIN_USER_IDS || '').split(',').filter(Boolean),
  
  
  // Feature flags
  ALLOW_USER_ORDERS: true,
  ALLOW_USER_STOCK_VIEW: false, // Only admin can view stock
  ALLOW_USER_REFRESH: false,
  LOW_STOCK_THRESHOLD: 10,
  MAX_ORDER_QUANTITY: 1000,
  
  // Voice settings - ADDED
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

// Validate required environment variables
function validateConfig() {
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
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  const recommended = ['ADMIN_USER_ID', 'VOICE_FOLDER_ID'];
  const missingRecommended = recommended.filter(key => !process.env[key]);
  
  if (missingRecommended.length > 0) {
    console.warn(`⚠️ Warning: Missing recommended variables: ${missingRecommended.join(', ')}`);
    console.warn('Some features may not work properly without these.');
  }
}

// Load and parse Google credentials
function loadGoogleCredentials() {
  try {
    const base64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;
    if (!base64) throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS_BASE64');
    
    const jsonString = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(jsonString);
  } catch (error) {
    throw new Error(`Failed to load Google credentials: ${error.message}`);
  }
}
function getEnvironmentInfo() {
  return {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: process.env.PORT || 3000,
    hasAdmin: !!CONFIG.ADMIN_USER_ID,
    hasVoiceFolder: !!CONFIG.VOICE_FOLDER_ID,
    hasPromptPay: !!CONFIG.PROMPTPAY_ID,
    cacheEnabled: CONFIG.CACHE_DURATION > 0,
    lowStockAlert: CONFIG.LOW_STOCK_THRESHOLD,
    maxOrderQty: CONFIG.MAX_ORDER_QUANTITY
  };
}
module.exports = {
  CONFIG,
  validateConfig,
  loadGoogleCredentials,
  getEnvironmentInfo
};
