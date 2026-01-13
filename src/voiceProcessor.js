// src/voiceProcessor.js - ผ่าตัดใหม่: ตัด Logic ตัดคำทิ้ง ให้ AI จัดการ 100%
const { Logger } = require('./logger');
const { transcribeAudio } = require('./aiServices');
const { handleMessage } = require('./messageHandlerService');
const { saveToInbox } = require('./inboxService');

async function processVoiceMessage(audioBuffer, userId) {
  const startTime = Date.now();
  try {
    // Step 1: Transcribe - ให้ Whisper แปลงเสียงเป็นตัวอักษรดิบๆ
    const { success, text } = await transcribeAudio(audioBuffer);
    
    if (!success || !text) {
      await saveToInbox(userId, '🎤 [ฟังไม่ออก]', 'ไม่สามารถแปลงเสียง', 'voice_error');
      return { success: false, message: '❌ ฟังไม่ออกจริงๆ ค่ะ... ลองพูดใหม่ชัดๆ หรือพิมพ์มาเถอะนะ' };
    }
    
    Logger.success(`📝 Voice Raw Text: "${text}"`);

    // Step 2: อย่าพยายามฉลาดกว่า AI - ส่งข้อความดิบไปให้ handleMessage เลย
    // เพราะ handleMessage จะเรียก parseOrder (LLM) ซึ่งฉลาดกว่า Logic ตัดคำที่นายเขียนเยอะ
    const result = await handleMessage(text, userId);
    
    // Step 3: บันทึกข้อมูล
    await saveToInbox(userId, `🎤 "${text}"`, 'Processed via AI', 'voice');
    
    return {
      success: true,
      message: `🎤 ฉันได้ยินว่า: "${text}"\n\n${result.message}`,
      processingTime: Date.now() - startTime
    };
  } catch (error) {
    Logger.error('Voice processing failed', error);
    return { success: false, message: '❌ เกิดข้อผิดพลาดตอนประมวลผลเสียง... คงเป็นเพราะโค้ดเก่านายทำพิษล่ะมั้ง' };
  }
}

module.exports = { processVoiceMessage };
