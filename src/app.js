// app.js - Context-Aware Order Bot with RAG
const express = require('express');
const axios = require('axios');

const { configManager, validateConfig } = require('./config');
const { Logger } = require('./logger');

validateConfig();

const { initializeGoogleServices } = require('./googleServices');
const { initializeAIServices, transcribeAudio } = require('./aiServices');
const { initializeSheets } = require('./sheetInitializer');
const { loadStockCache, loadCustomerCache } = require('./cacheManager');
const { parseOrder } = require('./orderParser');
const { createOrderTransaction } = require('./orderService');
const { saveToInbox, cancelOrder } = require('./inboxService');
const { adjustStock, parseAdjustmentCommand, generateVarianceReport, viewCurrentStock } = require('./stockAdjustment');
const { shouldAutoProcess, applySmartCorrection, monitor } = require('./aggressiveAutoConfig');

const app = express();
app.use(express.json());
const { verifyLineSignature, basicRateLimit } = require('./middleware/webhook-security');
app.use('/webhook', basicRateLimit);
app.use('/webhook', verifyLineSignature);
// ============================================================================
// INITIALIZATION
// ============================================================================

async function initializeApp() {
  try {
    Logger.info('🚀 Starting Context-Aware Order Bot...');
    
    initializeGoogleServices();
    initializeAIServices();
    
    // Initialize sheets structure
    await initializeSheets();
    
    // Load caches with RAG
    await loadStockCache(true);
    await loadCustomerCache(true);
    
    Logger.success('✅ System Ready: RAG-Powered Admin Mode 🎯');
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
// VOICE HANDLER - RAG + AUTO PROCESSING
// ============================================================================

async function handleVoiceMessage(messageId, replyToken, userId) {
  try {
    // Step 1: Save raw audio input to Inbox
    await saveToInbox(userId, '[🎤 Voice Input]', 'voice_raw', { messageId });

    // Step 2: Fetch and transcribe audio
    const audioBuffer = await fetchAudioFromLine(messageId);
    const { success, text } = await transcribeAudio(audioBuffer);
    
    if (!success || !text) {
      await saveToInbox(userId, '[ฟังไม่ออก]', 'voice_error');
      await replyToLine(replyToken, '❌ ฟังไม่ออกค่ะ ลองใหม่หรือพิมพ์ข้อความมาค่ะ');
      return;
    }

    Logger.info(`📝 Transcribed: "${text}"`);

    // Step 3: Save transcribed text to Inbox (raw data)
    await saveToInbox(userId, text, 'voice_transcribed', { 
      transcription: text,
      timestamp: new Date().toISOString()
    });

    // Step 4: Parse with RAG context
    const parsed = await parseOrder(text);
    parsed.rawInput = text;

    if (!parsed.success) {
      await saveToInbox(userId, text, 'parse_failed', { error: parsed.error });
      await replyToLine(replyToken, `❌ ${parsed.error}\n\nลองพูดใหม่หรือพิมพ์ "help" ดูวิธีใช้ค่ะ`);
      return;
    }

    // Step 5: Apply smart corrections
    const corrected = applySmartCorrection(parsed);

    // Step 6: Calculate order value
    const orderValue = corrected.items.reduce((sum, item) => 
      sum + (item.quantity * item.stockItem.price), 0
    );

    // Step 7: Decision Engine - Should we auto-process?
    const decision = shouldAutoProcess(corrected, orderValue);

    if (decision.shouldAuto) {
      // ✅ AUTO MODE: Create order immediately
      const result = await createOrderTransaction({
        customer: corrected.customer,
        items: corrected.items,
        paymentStatus: corrected.paymentStatus || 'unpaid'
      });

      if (result.success) {
        // Save success to Inbox for tracking
        await saveToInbox(userId, text, 'order_auto_success', { 
          orderNo: result.orderNo,
          customer: result.customer,
          totalAmount: result.totalAmount,
          confidence: corrected.confidence
        });

        // Reply to admin
        const summary = result.items.map(i => 
          `• ${i.productName} x${i.quantity} (${i.newStock} เหลือ)`
        ).join('\n');
        
        await replyToLine(replyToken, 
          `✅ บันทึกออเดอร์สำเร็จ!\n\n` +
          `📋 คำสั่งซื้อ #${result.orderNo}\n` +
          `👤 ${result.customer}\n\n` +
          `${summary}\n\n` +
          `💰 รวม: ${result.totalAmount.toLocaleString()}฿\n` +
          `🎯 ความมั่นใจ: ${corrected.confidence}\n\n` +
          `💡 ยกเลิกได้ด้วย: "ยกเลิก #${result.orderNo}"`
        );

        monitor.recordDecision(decision, result.orderNo);
        Logger.success(`✅ Auto-order #${result.orderNo} created (${corrected.confidence})`);
      } else {
        // Auto failed - save error to Inbox
        await saveToInbox(userId, text, 'order_auto_failed', { 
          error: result.error,
          confidence: corrected.confidence
        });
        
        await replyToLine(replyToken, `❌ ไม่สามารถสร้างออเดอร์ได้\n\n${result.error}`);
        Logger.error(`❌ Auto-order failed: ${result.error}`);
      }
    } else {
      // 📝 MANUAL REVIEW MODE: Save to Inbox for admin review
      const guess = corrected.items && corrected.items.length > 0 
        ? corrected.items.map(i => `${i.stockItem.item} x${i.quantity}`).join(', ')
        : '-';

      await saveToInbox(userId, text, 'pending_review', { 
        summary: guess,
        customer: corrected.customer,
        confidence: corrected.confidence,
        blockReason: decision.reason,
        orderValue: orderValue
      });

      await replyToLine(replyToken, 
        `📝 รับคำสั่งแล้ว (รอตรวจสอบ)\n\n` +
        `"${text}"\n\n` +
        `🤖 ระบบเดา:\n` +
        `• ลูกค้า: ${corrected.customer}\n` +
        `• สินค้า: ${guess}\n` +
        `• ยอดรวม: ${orderValue.toLocaleString()}฿\n\n` +
        `⚠️ เหตุผล: ${decision.reason}\n` +
        `📊 Confidence: ${corrected.confidence}\n\n` +
        `💡 แอดมินจะตรวจสอบและบันทึกให้ค่ะ`
      );

      monitor.recordDecision(decision, 'pending');
      Logger.info(`📥 Pending review: "${text}" (${decision.reason})`);
    }

  } catch (error) {
    Logger.error('Voice handler error', error);
    await saveToInbox(userId, '[System Error]', 'voice_error', { error: error.message });
    await replyToLine(replyToken, '❌ เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้งค่ะ');
  }
}

// ============================================================================
// TEXT HANDLER - COMMANDS
// ============================================================================

async function handleTextMessage(text, replyToken, userId) {
  try {
    const lower = text.toLowerCase().trim();

    // 🚫 CANCEL ORDER: "ยกเลิก #123"
    const cancelMatch = text.match(/ยกเลิก\s*#?(\d+)/i);
    if (cancelMatch) {
      const orderNo = cancelMatch[1];
      const result = await cancelOrder(orderNo);

      if (result.success) {
        const restoredList = result.stockRestored
          .map(s => `• ${s.item} +${s.restored} (${s.newStock} เหลือ)`)
          .join('\n');

        await replyToLine(replyToken, 
          `✅ ยกเลิกออเดอร์สำเร็จ\n\n` +
          `📋 คำสั่งซื้อ #${orderNo}\n` +
          `👤 ${result.customer}\n\n` +
          `📦 คืนสต็อก:\n${restoredList}`
        );

        await saveToInbox(userId, text, 'cancel_success', { orderNo });
        monitor.recordCancellation(orderNo, true);
        Logger.success(`✅ Cancelled order #${orderNo}`);
      } else {
        await replyToLine(replyToken, `❌ ยกเลิกไม่สำเร็จ: ${result.error}`);
      }
      return;
    }

    // 🔧 STOCK ADJUSTMENT: Enhanced with +/-
    const adjCommand = await parseAdjustmentCommand(text);
    if (adjCommand.isAdjustment) {
      const result = await adjustStock(
        adjCommand.item, 
        adjCommand.value, 
        adjCommand.operation,
        'voice_adjustment'
      );

      if (result.success) {
        const icon = result.difference === 0 ? '➖' : result.difference > 0 ? '📈' : '📉';
        
        await replyToLine(replyToken,
          `✅ ปรับสต็อกสำเร็จ\n\n` +
          `📦 ${result.item}\n` +
          `━━━━━━━━━━━━━━\n` +
          `เดิม: ${result.oldStock} ${result.unit}\n` +
          `ใหม่: ${result.newStock} ${result.unit}\n` +
          `${icon} ส่วนต่าง: ${result.difference >= 0 ? '+' : ''}${result.difference}\n\n` +
          `💡 ${result.operationText}\n` +
          `📊 บันทึก VarianceLog แล้ว`
        );

        await saveToInbox(userId, text, 'stock_adjusted', { 
          item: result.item,
          oldStock: result.oldStock,
          newStock: result.newStock,
          operation: result.operation
        });

        Logger.success(`✅ Stock adjusted: ${result.item} (${result.operation})`);
      } else {
        await replyToLine(replyToken, result.error);
      }
      return;
    }

    // 📊 AUTOMATION STATS: "สถิติ"
    if (lower.includes('สถิติ') || lower === 'stats') {
      const report = monitor.getReport();
      await replyToLine(replyToken, report);
      return;
    }

    // 📦 VIEW STOCK: "สต็อก" or "ดูสต็อก"
    if (lower.includes('สต็อก') && !lower.includes('รายงาน') && !lower.includes('ปรับ')) {
      const searchTerm = text.replace(/สต็อก|ดู/gi, '').trim();
      const stockList = await viewCurrentStock(searchTerm || null);
      await replyToLine(replyToken, stockList);
      return;
    }

    // 📊 VARIANCE REPORT: "รายงานสต็อก"
    if (lower.includes('รายงานสต็อก') || lower.includes('variance')) {
      const report = await generateVarianceReport('today');
      await replyToLine(replyToken, report);
      return;
    }

    // 🔄 REFRESH CACHE: "รีเฟรช"
    if (lower === 'รีเฟรช' || lower === 'refresh') {
      await loadStockCache(true);
      await loadCustomerCache(true);
      await replyToLine(replyToken, '✅ รีเฟรชข้อมูลสำเร็จ\n\nโหลดสต็อกและลูกค้าใหม่แล้วค่ะ');
      return;
    }

    // ❓ HELP: "help"
    if (lower === 'help' || lower === 'ช่วยเหลือ') {
      await replyToLine(replyToken, 
        `🤖 คำสั่งที่ใช้ได้\n` +
        `${'='.repeat(30)}\n\n` +
        `📦 รับออเดอร์:\n` +
        `• กดไมค์พูดสั่งซื้อ (แนะนำ)\n` +
        `• พิมพ์: "น้ำแข็ง 5 ถุง ร้านเจ๊แดง"\n\n` +
        `🔧 จัดการสต็อก:\n` +
        `• "เติมน้ำแข็ง 20" - เพิ่มสต็อก\n` +
        `• "ลดน้ำแข็ง 10" - ลดสต็อก\n` +
        `• "น้ำแข็งเหลือ 50" - ตั้งค่าเป๊ะ\n` +
        `• "สต็อก" - ดูสต็อกทั้งหมด\n` +
        `• "สต็อกน้ำแข็ง" - ดูเฉพาะสินค้า\n\n` +
        `📊 รายงาน:\n` +
        `• "รายงานสต็อก" - ดูการปรับสต็อกวันนี้\n` +
        `• "สถิติ" - ดู automation stats\n\n` +
        `⚙️ อื่นๆ:\n` +
        `• "ยกเลิก #123" - ยกเลิกออเดอร์\n` +
        `• "รีเฟรช" - โหลดข้อมูลใหม่\n\n` +
        `💡 Tip: ใช้เสียงจะแม่นและเร็วกว่าค่ะ!`
      );
      return;
    }

    // DEFAULT: Try to parse as order (text input)
    await saveToInbox(userId, text, 'text_input');
    
    const parsed = await parseOrder(text);
    if (parsed.success) {
      const summary = parsed.items.map(i => 
        `${i.stockItem.item} x${i.quantity}`
      ).join(', ');
      
      await replyToLine(replyToken, 
        `📝 เข้าใจแล้ว:\n` +
        `👤 ${parsed.customer}\n` +
        `📦 ${summary}\n\n` +
        `💬 ยืนยันด้วย "ยืนยัน" หรือกดไมค์พูดใหม่ค่ะ`
      );
    } else {
      await replyToLine(replyToken, 
        `💡 ไม่เข้าใจคำสั่งค่ะ\n\n` +
        `ลองใช้:\n` +
        `• กดไมค์พูดสั่งซื้อ\n` +
        `• พิมพ์ "help" ดูวิธีใช้`
      );
    }

  } catch (error) {
    Logger.error('Text handler error', error);
    await saveToInbox(userId, text, 'text_error', { error: error.message });
    await replyToLine(replyToken, '❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้งค่ะ');
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
    mode: 'rag-powered-admin',
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