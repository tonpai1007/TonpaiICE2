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
  ADMIN_USER_ID: process.env.ADMIN_USER_ID,
  
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
}

// Load and parse Google credentials
function loadGoogleCredentials() {
  try {
    const base64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;
    if (!base64) throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS_BASE64');
    
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'));
  } catch (error) {
    throw new Error(`Failed to load Google credentials: ${error.message}`);
  }
}

module.exports = {
  CONFIG,
  validateConfig,
  loadGoogleCredentials
};
