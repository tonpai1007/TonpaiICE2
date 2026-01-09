// app.js - FIXED: Production-ready with proper error handling
const express = require('express');
const axios = require('axios');

const { configManager, validateConfig } = require('./config');
const { Logger } = require('./logger');

// Validate config before proceeding
validateConfig();

const { initializeGoogleServices } = require('./googleServices');
const { initializeAIServices, transcribeAudio } = require('./aiServices');
const { initializeSheets } = require('./sheetInitializer');
const { loadStockCache, loadCustomerCache } = require('./cacheManager');
const { smartLearner } = require('./smartOrderLearning');
const { handleMessage } = require('./messageHandlerService');
const { verifyLineSignature } = require('./middleware/webhook-security');

const app = express();
app.use(express.json());

// ============================================================================
// GLOBAL ERROR HANDLERS
// ============================================================================

process.on('unhandledRejection', (reason, promise) => {
  Logger.error('🔴 Unhandled Promise Rejection', {
    reason: reason?.message || reason,
    stack: reason?.stack
  });
  // Don't exit - log and continue
});

process.on('uncaughtException', (error) => {
  Logger.error('🔴 Uncaught Exception - CRITICAL', error);
  // Give time to log, then exit
  setTimeout(() => {
    Logger.error('Exiting due to uncaught exception');
    process.exit(1);
  }, 1000);
});

// Graceful shutdown
let isShuttingDown = false;

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  Logger.warn(`🛑 ${signal} received. Starting graceful shutdown...`);
  
  // Stop accepting new requests
  server.close(() => {
    Logger.info('✅ HTTP server closed');
    process.exit(0);
  });
  
  // Force shutdown after 10 seconds
  setTimeout(() => {
    Logger.error('⚠️ Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initializeApp() {
  try {
    Logger.info('🚀 Starting Order Bot...');
    
    initializeGoogleServices();
    initializeAIServices();
    
    await initializeSheets();
    await loadStockCache(true);
    await loadCustomerCache(true);
    
    await smartLearner.loadOrderHistory();
    const stats = smartLearner.getStats();
    Logger.success(`🧠 Smart Learning: ${stats.customersLearned} customers, ${stats.totalPatterns} patterns`);
    
    Logger.success('✅ System Ready');
  } catch (error) {
    Logger.error('❌ Init failed - CRITICAL', error);
    process.exit(1);
  }
}

// ============================================================================
// LINE API HELPERS - WITH RETRY LOGIC
// ============================================================================

async function replyToLine(replyToken, text, retries = 3) {
  const token = configManager.get('LINE_TOKEN');
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await axios.post('https://api.line.me/v2/bot/message/reply', {
        replyToken,
        messages: [{ type: 'text', text }]
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        timeout: 10000 // 10 second timeout
      });
      
      return { success: true };
    } catch (error) {
      Logger.error(`Reply attempt ${attempt}/${retries} failed`, error);
      
      if (attempt === retries) {
        return { success: false, error: error.message };
      }
      
      // Exponential backoff: 1s, 2s, 4s
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
    }
  }
}

async function pushToAdmin(text, retries = 3) {
  const adminIds = configManager.get('ADMIN_USER_IDS');
  const token = configManager.get('LINE_TOKEN');
  
  const promises = adminIds.map(async (adminId) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await axios.post('https://api.line.me/v2/bot/message/push', {
          to: adminId,
          messages: [{ type: 'text', text }]
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          timeout: 10000
        });
        
        return { success: true, adminId };
      } catch (error) {
        if (attempt === retries) {
          Logger.error(`Push to admin ${adminId} failed after ${retries} attempts`, error);
          return { success: false, adminId, error: error.message };
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
      }
    }
  });
  
  const results = await Promise.allSettled(promises);
  const succeeded = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
  
  Logger.info(`📤 Pushed to ${succeeded}/${adminIds.length} admins`);
  return { succeeded, total: adminIds.length };
}

async function fetchAudioFromLine(messageId) {
  const token = configManager.get('LINE_TOKEN');
  
  try {
    const response = await axios.get(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        responseType: 'arraybuffer',
        timeout: 30000 // 30 second timeout for audio
      }
    );
    return Buffer.from(response.data);
  } catch (error) {
    Logger.error('Failed to fetch audio from LINE', error);
    throw error;
  }
}

// ============================================================================
// MESSAGE HANDLERS - WITH ERROR BOUNDARIES
// ============================================================================

async function handleTextMessage(text, replyToken, userId) {
  try {
    Logger.info(`📝 Text from ${userId.substring(0, 8)}: "${text}"`);
    
    const result = await handleMessage(text, userId);
    
    const replyResult = await replyToLine(replyToken, result.message);
    
    if (!replyResult.success) {
      Logger.error('Failed to send reply to LINE', replyResult.error);
      // Still return success - message was processed
    }
    
  } catch (error) {
    Logger.error('Text handler error', error);
    
    // Try to inform user
    await replyToLine(replyToken, '❌ เกิดข้อผิดพลาด ระบบกำลังประมวลผล\nกรุณาลองใหม่อีกครั้ง').catch(() => {
      Logger.error('Failed to send error message to user');
    });
  }
}

async function handleVoiceMessage(messageId, replyToken, userId) {
  try {
    Logger.info(`🎤 Voice from ${userId.substring(0, 8)}`);
    
    // Fetch audio
    const audioBuffer = await fetchAudioFromLine(messageId);
    
    // Transcribe
    const { success, text } = await transcribeAudio(audioBuffer);
    
    if (!success || !text) {
      await replyToLine(replyToken, '❌ ฟังไม่ออก กรุณาลองใหม่หรือพิมพ์ข้อความมา');
      return;
    }

    Logger.info(`🎤 → 📝 Transcribed: "${text}"`);
    
    // Process transcribed text
    const result = await handleMessage(text, userId);
    
    await replyToLine(replyToken, result.message);
    
  } catch (error) {
    Logger.error('Voice handler error', error);
    
    await replyToLine(replyToken, '❌ ไม่สามารถประมวลผลเสียงได้\nกรุณาลองใหม่หรือพิมพ์ข้อความมา').catch(() => {
      Logger.error('Failed to send error message');
    });
  }
}

// ============================================================================
// WEBHOOK - WITH SIGNATURE VERIFICATION & ERROR BOUNDARIES
// ============================================================================

app.post('/webhook', verifyLineSignature, async (req, res) => {
  try {
    // Immediately respond 200 to LINE
    res.sendStatus(200);
    
    const events = req.body.events || [];
    
    if (events.length === 0) {
      Logger.warn('Received webhook with no events');
      return;
    }
    
    Logger.info(`📨 Processing ${events.length} event(s)`);
    
    // Process each event independently with error boundaries
    const results = await Promise.allSettled(
      events.map(event => processEvent(event))
    );
    
    // Log results
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    
    if (failed > 0) {
      Logger.warn(`⚠️ Processed: ${succeeded} success, ${failed} failed`);
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          Logger.error(`Event ${i} failed:`, r.reason);
        }
      });
    } else {
      Logger.success(`✅ All ${succeeded} events processed successfully`);
    }
    
  } catch (error) {
    Logger.error('Webhook error', error);
    // Already sent 200, so just log
  }
});

async function processEvent(event) {
  try {
    if (event.type !== 'message') {
      Logger.info(`Ignoring event type: ${event.type}`);
      return { processed: false, reason: 'not_message' };
    }

    const userId = event.source.userId;
    const replyToken = event.replyToken;

    if (event.message.type === 'audio') {
      await handleVoiceMessage(event.message.id, replyToken, userId);
      return { processed: true, type: 'audio' };
    } else if (event.message.type === 'text') {
      await handleTextMessage(event.message.text, replyToken, userId);
      return { processed: true, type: 'text' };
    } else {
      Logger.info(`Unsupported message type: ${event.message.type}`);
      await replyToLine(replyToken, 'ขณะนี้รองรับเฉพาะข้อความและเสียงเท่านั้น');
      return { processed: false, reason: 'unsupported_type' };
    }
  } catch (error) {
    Logger.error('Failed to process event', error);
    throw error; // Re-throw to be caught by Promise.allSettled
  }
}

// ============================================================================
// HEALTH CHECK - WITH DETAILED STATUS
// ============================================================================

app.get('/health', async (req, res) => {
  try {
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      checks: {}
    };
    
    // Check Google Sheets connectivity
    try {
      const { getSheetData } = require('./googleServices');
      await getSheetData(configManager.get('SHEET_ID'), 'สต็อก!A1:A1');
      health.checks.googleSheets = 'ok';
    } catch (error) {
      health.checks.googleSheets = 'error';
      health.status = 'degraded';
    }
    
    // Check cache
    const { getStockCache, getCustomerCache } = require('./cacheManager');
    health.checks.stockCache = getStockCache().length > 0 ? 'ok' : 'empty';
    health.checks.customerCache = getCustomerCache().length > 0 ? 'ok' : 'empty';
    
    // Check AI service
    const { getGroq } = require('./aiServices');
    health.checks.aiService = getGroq() ? 'ok' : 'not_initialized';
    
    const statusCode = health.status === 'ok' ? 200 : 503;
    res.status(statusCode).json(health);
    
  } catch (error) {
    Logger.error('Health check failed', error);
    res.status(503).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================================================
// MANUAL ADMIN ENDPOINTS (Optional - for debugging)
// ============================================================================

app.get('/admin/stats', async (req, res) => {
  try {
    const stats = {
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        nodeVersion: process.version
      },
      cache: {
        stock: require('./cacheManager').getStockCache().length,
        customers: require('./cacheManager').getCustomerCache().length
      },
      learning: smartLearner.getStats(),
      automation: require('./aggressiveAutoConfig').monitor.stats
    };
    
    res.json(stats);
  } catch (error) {
    Logger.error('Stats endpoint error', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// 404 HANDLER
// ============================================================================

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// ============================================================================
// GLOBAL ERROR HANDLER FOR EXPRESS
// ============================================================================

app.use((err, req, res, next) => {
  Logger.error('Express error handler', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, async () => {
  Logger.info(`🚀 Server running on port ${PORT}`);
  await initializeApp();
});

// Export for testing and admin notifications
module.exports = { app, pushToAdmin, server };
