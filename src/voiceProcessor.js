const { Logger } = require('./logger');
const { transcribeAudio } = require('./aiServices');
const { handleMessage } = require('./messageHandlerService');

async function processVoiceMessage(audioBuffer, userId) {
  try {
    const { success, text } = await transcribeAudio(audioBuffer);
    if (!success || !text) return { success: false, message: '❌ ฟังไม่ออกค่ะ... พยายามพูดให้เหมือนมนุษย์กว่านี้หน่อยนะ' };

    Logger.info(`🎤 Voice Raw Text: "${text}"`);
    // ส่งข้อความดิบไปให้ระบบจัดการข้อความหลักจัดการต่อ
    const result = await handleMessage(text, userId); 
    
    return {
      success: true,
      message: `🎤 ฉันได้ยินว่า: "${text}"\n\n${result.message}`
    };
  } catch (error) {
    Logger.error('Voice system failure', error);
    return { success: false, message: '❌ ระบบเอ๋อไปแล้วค่ะ คงเพราะโค้ดเก่านายทำพิษล่ะมั้ง' };
  }
}

module.exports = { processVoiceMessage };
