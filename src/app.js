// app.js - SIMPLIFIED: Using unified message handler service
const express = require('express');
const axios = require('axios');

const { configManager, validateConfig } = require('./config');
const { Logger } = require('./logger');

validateConfig();

const { initializeGoogleServices } = require('./googleServices');
const { initializeAIServices, transcribeAudio } = require('./aiServices');
const { initializeSheets } = require('./sheetInitializer');
const { loadStockCache, loadCustomerCache } = require('./cacheManager');
const { smartLearner } = require('./smartOrderLearning');
const { handleMessage } = require('./messageHandlerService'); // ← NEW UNIFIED SERVICE

const app = express();
app.use(express.json());

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
    
    // Load order history for smart learning
    await smartLearner.loadOrderHistory();
    const stats = smartLearner.getStats();
    Logger.success(`🧠 Smart Learning: ${stats.customersLearned} customers, ${stats.totalPatterns} patterns`);
    
    Logger.success('✅ System Ready with Smart Learning');
  } catch (error) {
    Logger.error('❌ Init failed', error);
    process.exit(1);
  }
}

// ============================================================================
// LINE API HELPERS
// ============================================================================

async function replyToLine(replyToken, text) {
  const token = configManager.get('LINE_TOKEN');
  try {
    await axios.post('https://api.line.me/v2/bot/message/reply', {
      replyToken,
      messages: [{ type: 'text', text }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });
  } catch (error) {
    Logger.error('Reply failed', error);
  }
}

async function pushToAdmin(text) {
  const adminIds = configManager.get('ADMIN_USER_IDS');
  const token = configManager.get('LINE_TOKEN');
  
  try {
    for (const adminId of adminIds) {
      await axios.post('https://api.line.me/v2/bot/message/push', {
        to: adminId,
        messages: [{ type: 'text', text }]
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });
    }
    Logger.success('✅ Admin notified');
  } catch (error) {
    Logger.error('pushToAdmin failed', error);
  }
}

async function fetchAudioFromLine(messageId) {
  const token = configManager.get('LINE_TOKEN');
  const response = await axios.get(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: { 'Authorization': `Bearer ${token}` },
      responseType: 'arraybuffer'
    }
  );
  return Buffer.from(response.data);
}

// ============================================================================
// MESSAGE HANDLERS - SIMPLIFIED
// ============================================================================

/**
 * Handle text message
 * Simply passes text to unified message handler
 */
async function handleTextMessage(text, replyToken, userId) {
  try {
    Logger.info(`📝 Text: "${text}"`);
    
    // Call unified handler
    const result = await handleMessage(text, userId);
    
    // Reply to LINE
    await replyToLine(replyToken, result.message);
    
  } catch (error) {
    Logger.error('Text handler error', error);
    await replyToLine(replyToken, '❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้ง');
  }
}

/**
 * Handle voice message
 * 1. Transcribe audio
 * 2. Pass to unified message handler
 */
async function handleVoiceMessage(messageId, replyToken, userId) {
  try {
    // Fetch and transcribe audio
    const audioBuffer = await fetchAudioFromLine(messageId);
    const { success, text } = await transcribeAudio(audioBuffer);
    
    if (!success || !text) {
      await replyToLine(replyToken, '❌ ฟังไม่ออก ลองใหม่หรือพิมพ์ข้อความมา');
      return;
    }

    Logger.info(`🎤 Voice transcribed: "${text}"`);
    
    // Call unified handler (same as text!)
    const result = await handleMessage(text, userId);
    
    // Reply to LINE
    await replyToLine(replyToken, result.message);
    
  } catch (error) {
    Logger.error('Voice handler error', error);
    await replyToLine(replyToken, '❌ เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง');
  }
}

// ============================================================================
// WEBHOOK
// ============================================================================

app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      if (event.type !== 'message') continue;

      const userId = event.source.userId;
      const replyToken = event.replyToken;

      if (event.message.type === 'audio') {
        await handleVoiceMessage(event.message.id, replyToken, userId);
      } else if (event.message.type === 'text') {
        await handleTextMessage(event.message.text, replyToken, userId);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    Logger.error('Webhook error', error);
    res.sendStatus(500);
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString() 
  });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  Logger.info(`🚀 Server running on port ${PORT}`);
  await initializeApp();
});

module.exports = { app, pushToAdmin };
