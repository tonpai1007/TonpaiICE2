// src/voiceService.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getGroq } = require('./aiServices');

// ฟังก์ชันหลัก: รับ Buffer -> แปลงเป็น Text
async function processVoiceMessage(audioBuffer) {
  // 1. สร้างไฟล์ชั่วคราว (Whisper ต้องการไฟล์จริง)
  const tempFilePath = path.join(os.tmpdir(), `voice_${Date.now()}.m4a`);
  
  try {
    fs.writeFileSync(tempFilePath, audioBuffer);
    
    // 2. ส่งให้ Groq Whisper (Model: whisper-large-v3)
    const groq = getGroq();
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: "whisper-large-v3", // 🚀 พระเอกของเรา
      language: "th",            // บังคับภาษาไทย
      response_format: "json",
      temperature: 0.0           // เอาความแม่นยำสูงสุด
    });

    const text = transcription.text.trim();
    
    if (!text) throw new Error('No speech detected');
    
    return {
      success: true,
      text: text,     // Whisper ส่ง text กลับมา
      original: text  // ใช้ค่าเดิม (ไม่ต้องมี AI แก้คำผิดซ้ำซ้อน)
    };

  } catch (error) {
    Logger.error('❌ Voice processing failed', error);
    return { success: false, error: 'ฟังไม่ออกค่ะ ลองพูดใหม่นะคะ' };
  } finally {
    // 3. ลบไฟล์ทิ้งเสมอเพื่อคืนพื้นที่
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }
}

// ฟังก์ชันดึงไฟล์จาก LINE (อันนี้ต้องเก็บไว้ ของเดิม Logic นี้ใช้ได้)
async function fetchAudioFromLine(messageId) {
  try {
    const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
    const response = await axios({
      method: 'get',
      url: url,
      headers: { 'Authorization': `Bearer ${CONFIG.LINE_TOKEN}` },
      responseType: 'arraybuffer'
    });
    return Buffer.from(response.data);
  } catch (error) {
    Logger.error(`Failed to fetch audio ${messageId}`, error);
    throw new Error('LINE_AUDIO_FETCH_FAILED');
  }
}

module.exports = {
  processVoiceMessage,
  fetchAudioFromLine
};