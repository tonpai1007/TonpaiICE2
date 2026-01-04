// app.js - Hybrid Automation Mode
const express = require('express');
const axios = require('axios');

const { configManager, validateConfig } = require('./config');
const { Logger } = require('./logger');

validateConfig();

const { initializeGoogleServices } = require('./googleServices');
const { initializeAIServices, transcribeAudio } = require('./aiServices');
const { loadStockCache, loadCustomerCache } = require('./cacheManager');
const { parseOrder } = require('./orderParser');
const { createOrderTransaction } = require('./orderService');
const { saveToInbox, cancelOrder } = require('./inboxService');
const { sendLineNotify } = require('./lineNotify');
const { adjustStock, parseAdjustmentCommand, generateVarianceReport } = require('./stockAdjustment');
const { shouldAutoProcess, applySmartCorrection, monitor } = require('./aggressiveAutoConfig');

const app = express();
app.use(express.json());

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initializeApp() {
  try {
    Logger.info('🚀 Starting Hybrid Order Bot...');
    
    initializeGoogleServices();
    initializeAIServices();
    
    await loadStockCache(true);
    await loadCustomerCache(true);
    
    Logger.success('✅ System Ready: Hybrid Mode 🎯');
  } catch (error) {
    Logger.error('❌ Init failed', error);
    process.exit(1);
  }
}

// ============================================================================
// LINE MESSAGING
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
// VOICE HANDLER - HYBRID LOGIC
// ============================================================================

async function handleVoiceMessage(messageId, replyToken, userId) {
  try {
    // 1. Fetch audio
    const audioBuffer = await fetchAudioFromLine(messageId);
    
    // 2. Transcribe with Groq Whisper
    const { success, text } = await transcribeAudio(audioBuffer);
    
    if (!success || !text) {
      await saveToInbox(userId, '[ฟังไม่ออก]', 'voice_error');
      await replyToLine(replyToken, '❌ ฟังไม่ออกค่ะ ลองใหม่');
      return;
    }

    // 3. Parse order with smart parser
    const parsed = await parseOrder(text);
    parsed.rawInput = text; // Keep for smart correction

    // 4. Apply smart corrections (if enabled)
    const corrected = applySmartCorrection(parsed);

    // 5. Calculate order value
    const orderValue = corrected.items.reduce((sum, item) => 
      sum + (item.quantity * item.stockItem.price), 0
    );

    // 6. 🎯 SMART DECISION: Should we auto-process?
    const decision = shouldAutoProcess(corrected, orderValue);

    if (decision.shouldAuto) {
      // ✅ AUTO-PILOT MODE
      const result = await createOrderTransaction({
        customer: corrected.customer,
        items: corrected.items,
        paymentStatus: corrected.paymentStatus || 'unpaid'
      });

      if (result.success) {
        // Save to inbox with success flag
        await saveToInbox(userId, text, 'voice_auto', { 
          orderNo: result.orderNo,
          status: 'completed',
          confidence: corrected.confidence
        });

        // Reply to user
        const summary = result.items.map(i => 
          `${i.productName} x${i.quantity}`
        ).join('\n');
        
        await replyToLine(replyToken, 
          `✅ บันทึกออเดอร์สำเร็จ!\n\n` +
          `📋 #${result.orderNo}\n` +
          `👤 ${corrected.customer}\n` +
          `${summary}\n` +
          `💰 ${result.totalAmount.toLocaleString()}฿\n\n` +
          `🔄 ยกเลิกได้: "ยกเลิก #${result.orderNo}"`
        );

        // Notify admin
        await sendLineNotify(
          `🤖 AUTO ORDER [${corrected.confidence.toUpperCase()}]\n` +
          `#${result.orderNo} - ${corrected.customer}\n` +
          `${summary}\n` +
          `💰 ${result.totalAmount.toLocaleString()}฿\n` +
          `📊 Reason: ${decision.reason}`
        );

        monitor.recordDecision(decision, result.orderNo);
        Logger.success(`✅ Auto-order #${result.orderNo} (${corrected.confidence})`);
      } else {
        // Failed to create order
        await saveToInbox(userId, text, 'voice_error', { 
          error: result.error,
          confidence: corrected.confidence
        });
        await replyToLine(replyToken, `⚠️ ระบบขัดข้อง: ${result.error}`);
        await sendLineNotify(`❌ Auto-order FAILED\n${text}\nError: ${result.error}`);
      }
    } else {
      // 📝 MANUAL REVIEW MODE
      const guess = corrected.items && corrected.items.length > 0 
        ? corrected.items.map(i => `${i.stockItem.item} x${i.quantity}`).join(', ')
        : '-';

      await saveToInbox(userId, text, 'voice_pending', { 
        summary: guess,
        confidence: corrected.confidence,
        blockReason: decision.reason
      });

      await replyToLine(replyToken, 
        `📝 รับคำสั่งแล้ว (รอตรวจสอบ)\n\n` +
        `ข้อความ: "${text}"\n` +
        `ระบบเดา: ${guess}\n\n` +
        `⏳ เหตุผล: ${decision.reason}\n` +
        `💡 แอดมินจะตรวจสอบให้ค่ะ`
      );

      await sendLineNotify(
        `📥 MANUAL REVIEW NEEDED\n` +
        `Text: ${text}\n` +
        `Guess: ${guess}\n` +
        `Confidence: ${corrected.confidence}\n` +
        `Block reason: ${decision.reason}\n` +
        `Amount: ${orderValue.toLocaleString()}฿`
      );

      monitor.recordDecision(decision, 'pending');
      Logger.info(`📥 Manual review: ${text} (${decision.reason})`);
    }

  } catch (error) {
    Logger.error('Voice handler error', error);
    await saveToInbox(userId, '[System Error]', 'voice_error', { error: error.message });
    await replyToLine(replyToken, '❌ เกิดข้อผิดพลาด ลองใหม่');
  }
}

// ============================================================================
// TEXT HANDLER - WITH CANCEL LOGIC
// ============================================================================

async function handleTextMessage(text, replyToken, userId) {
  try {
    const lower = text.toLowerCase().trim();

    // 🚫 UNDO LOGIC: "ยกเลิก #123"
    const cancelMatch = text.match(/ยกเลิก\s*#?(\d+)/i);
    if (cancelMatch) {
      const orderNo = cancelMatch[1];
      const result = await cancelOrder(orderNo);

      if (result.success) {
        const restoredList = result.stockRestored
          .map(s => `${s.item} +${s.restored}`)
          .join('\n');

        await replyToLine(replyToken, 
          `✅ ยกเลิกออเดอร์สำเร็จ\n\n` +
          `📋 #${orderNo}\n` +
          `👤 ${result.customer}\n\n` +
          `📦 คืนสต็อก:\n${restoredList}`
        );

        await sendLineNotify(
          `🚨 ORDER CANCELLED\n` +
          `#${orderNo} - ${result.customer}\n` +
          `Stock restored:\n${restoredList}`
        );

        // Track cancellation for accuracy monitoring
        monitor.recordCancellation(orderNo, true);
        Logger.success(`✅ Cancelled #${orderNo}`);
      } else {
        await replyToLine(replyToken, `❌ ยกเลิกไม่ได้: ${result.error}`);
      }
      return;
    }

    // 🔧 STOCK ADJUSTMENT: "ปรับน้ำแข็งเหลือ 50"
    const adjCommand = await parseAdjustmentCommand(text);
    if (adjCommand.isAdjustment) {
      const result = await adjustStock(adjCommand.item, adjCommand.actualStock, 'voice_adjustment');

      if (result.success) {
        const icon = result.difference === 0 ? '=' : result.difference > 0 ? '📈' : '📉';
        
        await replyToLine(replyToken,
          `✅ ปรับสต็อกแล้ว\n\n` +
          `📦 ${result.item}\n` +
          `${result.oldStock} → ${result.newStock}\n` +
          `${icon} ${result.difference >= 0 ? '+' : ''}${result.difference} ${result.unit}`
        );

        await sendLineNotify(
          `🔧 STOCK ADJUSTED\n` +
          `${result.item}: ${result.oldStock} → ${result.newStock}\n` +
          `Diff: ${result.difference >= 0 ? '+' : ''}${result.difference}`
        );

        Logger.success(`✅ Stock adjusted: ${result.item}`);
      } else {
        await replyToLine(replyToken, `❌ ปรับไม่ได้: ${result.error}`);
      }
      return;
    }

    // 📊 STATS: "สถิติ" or "stats"
    if (lower.includes('สถิติ') || lower === 'stats') {
      const report = monitor.getReport();
      await replyToLine(replyToken, report);
      return;
    }

    // 📊 VARIANCE REPORT: "รายงานสต็อก"
    if (lower.includes('รายงานสต็อก') || lower.includes('variance')) {
      const report = await generateVarianceReport('today');
      await replyToLine(replyToken, report);
      return;
    }

    // Other text commands (help, status, etc.)
    if (lower === 'help' || lower === 'ช่วยเหลือ') {
      await replyToLine(replyToken, 
        `🎤 วิธีใช้งาน\n` +
        `━━━━━━━━━━━━━━\n\n` +
        `📦 สั่งซื้อ:\n` +
        `• กดไมค์พูดสั่งซื้อ\n\n` +
        `🔧 จัดการ:\n` +
        `• "ยกเลิก #123" - ยกเลิกออเดอร์\n` +
        `• "ปรับน้ำแข็งเหลือ 50" - ปรับสต็อก\n` +
        `• "รายงานสต็อก" - ดูการเปลี่ยนแปลง\n` +
        `• "สถิติ" - ดู automation stats`
      );
      return;
    }

    // Default: try to parse as order
    await replyToLine(replyToken, '💡 กรุณาใช้เสียงสั่งซื้อค่ะ หรือพิมพ์ "help"');

  } catch (error) {
    Logger.error('Text handler error', error);
    await replyToLine(replyToken, '❌ เกิดข้อผิดพลาด');
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

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    mode: 'hybrid',
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

module.exports = app;