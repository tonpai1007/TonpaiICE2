// app.js - FIXED: Complete with all integrations
const express = require('express');
const axios = require('axios');

const { configManager, validateConfig } = require('./config');
const { Logger } = require('./logger');

validateConfig();

const { initializeGoogleServices } = require('./googleServices');
const { initializeAIServices } = require('./aiServices');
const { initializeSheets } = require('./sheetInitializer');
const { loadStockCache, loadCustomerCache } = require('./cacheManager');
const { smartLearner } = require('./smartOrderLearning');
const { handleMessage } = require('./messageHandlerService');
const { processVoiceMessage } = require('./voiceProcessor');
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
});

process.on('uncaughtException', (error) => {
  Logger.error('🔴 Uncaught Exception - CRITICAL', error);
  setTimeout(() => {
    Logger.error('Exiting due to uncaught exception');
    process.exit(1);
  }, 1000);
});

let isShuttingDown = false;

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  Logger.warn(`🛑 ${signal} received. Starting graceful shutdown...`);
  
  server.close(() => {
    Logger.info('✅ HTTP server closed');
    process.exit(0);
  });
  
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
    
    // Initialize services
    initializeGoogleServices();
    initializeAIServices();
    
    // Initialize sheets
    await initializeSheets();
    
    // Initialize inbox sheet structure
    const { initializeInboxSheet } = require('./inboxService');
    await initializeInboxSheet();
    
    // Load caches
    await loadStockCache(true);
    await loadCustomerCache(true);
    
    // Initialize smart learning
    await smartLearner.loadOrderHistory();
    const stats = smartLearner.getStats();
    Logger.success(`🧠 Smart Learning: ${stats.customersLearned} customers, ${stats.totalPatterns} patterns`);
    
    // Start cleanup scheduler
    const { scheduleCleanup } = require('./cleanupService');
    scheduleCleanup();
    Logger.success('✅ Cleanup scheduler initialized (runs at 3 AM daily)');
    
    Logger.success('✅ System Ready');
  } catch (error) {
    Logger.error('❌ Init failed - CRITICAL', error);
    process.exit(1);
  }
}

// ============================================================================
// LINE API HELPERS
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
        timeout: 10000
      });
      
      return { success: true };
    } catch (error) {
      Logger.error(`Reply attempt ${attempt}/${retries} failed`, error);
      
      if (attempt === retries) {
        return { success: false, error: error.message };
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
    }
  }
}

async function pushToAdmin(text, retries = 3) {
  const adminIds = configManager.get('ADMIN_USER_IDS');
  const token = configManager.get('LINE_TOKEN');
  
  if (!adminIds || adminIds.length === 0) {
    Logger.warn('No admin users configured');
    return { succeeded: 0, total: 0 };
  }
  
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
          Logger.error(`Push to admin ${adminId.substring(0, 8)}... failed after ${retries} attempts`, error);
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
        timeout: 30000
      }
    );
    return Buffer.from(response.data);
  } catch (error) {
    Logger.error('Failed to fetch audio from LINE', error);
    throw error;
  }
}

// ============================================================================
// MESSAGE HANDLERS
// ============================================================================

async function handleTextMessage(text, replyToken, userId) {
  try {
    Logger.info(`📝 Text from ${userId.substring(0, 8)}: "${text}"`);
    
    const result = await handleMessage(text, userId);
    
    const replyResult = await replyToLine(replyToken, result.message);
    
    if (!replyResult.success) {
      Logger.error('Failed to send reply to LINE', replyResult.error);
    }
    
  } catch (error) {
    Logger.error('Text handler error', error);
    
    await replyToLine(replyToken, 
      '❌ เกิดข้อผิดพลาด\n\nกรุณาลองใหม่อีกครั้ง'
    ).catch(() => {
      Logger.error('Failed to send error message to user');
    });
  }
}

async function handleVoiceMessageEvent(messageId, replyToken, userId) {
  try {
    Logger.info(`🎤 Voice message from ${userId.substring(0, 8)}`);
    
    const audioBuffer = await fetchAudioFromLine(messageId);
    const result = await processVoiceMessage(audioBuffer, userId);
    // Send response
    await replyToLine(replyToken, result.message);
    
    // Log performance
    if (result.processingTime) {
      Logger.info(`⏱️ Voice processed in ${result.processingTime}ms`);
    }
    
  } catch (error) {
    Logger.error('Voice message handler error', error);
    
    await replyToLine(replyToken, 
      '❌ ไม่สามารถประมวลผลเสียงได้\n\n' +
      '💡 วิธีแก้:\n' +
      '• ลองพูดใหม่อีกครั้ง\n' +
      '• พูดช้าๆ ชัดๆ\n' +
      '• หรือพิมพ์ข้อความมาแทน'
    ).catch(() => {
      Logger.error('Failed to send error message');
    });
  }
}

// ============================================================================
// WEBHOOK
// ============================================================================

app.post('/webhook', verifyLineSignature, async (req, res) => {
  try {
    res.sendStatus(200);
    
    const events = req.body.events || [];
    
    if (events.length === 0) {
      Logger.warn('Received webhook with no events');
      return;
    }
    
    Logger.info(`📨 Processing ${events.length} event(s)`);
    
    const results = await Promise.allSettled(
      events.map(event => processEvent(event))
    );
    
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
      await handleVoiceMessageEvent(event.message.id, replyToken, userId);
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
    throw error;
  }
}

// ============================================================================
// HEALTH CHECK
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
    
    // Check Google Sheets
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
// ADMIN ENDPOINTS
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
// 404 & ERROR HANDLERS
// ============================================================================

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use((err, req, res, next) => {
  Logger.error('Express error handler', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;

// แก้บรรทัดนี้: เติม '0.0.0.0' เพื่อบังคับใช้ IPv4
const server = app.listen(PORT, '0.0.0.0', async () => {
  Logger.info(`🚀 Server running on port ${PORT} (IPv4)`);
  await initializeApp();
});
// ============================================================================
// EXPORTS
// ============================================================================

module.exports = { 
  app, 
  pushToAdmin,
  notifyAdmin: pushToAdmin, // Alias for cleanup service
  server 
};
