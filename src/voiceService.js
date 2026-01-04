const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { getGroq } = require('./aiServices');

async function processVoiceMessage(audioBuffer) {
  const tempFilePath = path.join(os.tmpdir(), `voice_${Date.now()}.m4a`);
  try {
    fs.writeFileSync(tempFilePath, audioBuffer);
    const groq = getGroq();
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: "whisper-large-v3",
      language: "th",
      response_format: "json",
      temperature: 0.0
    });
    return { success: true, text: transcription.text.trim() };
  } catch (error) {
    Logger.error('Voice Error', error);
    return { success: false, error: 'ฟังไม่ออกค่ะ' };
  } finally {
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
  }
}

async function fetchAudioFromLine(messageId) {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const response = await axios({
    method: 'get', url,
    headers: { 'Authorization': `Bearer ${CONFIG.LINE_TOKEN}` },
    responseType: 'arraybuffer'
  });
  return Buffer.from(response.data);
}

module.exports = { processVoiceMessage, fetchAudioFromLine };
