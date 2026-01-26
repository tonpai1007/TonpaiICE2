const { Logger } = require('./logger');
const { transcribeAudio } = require('./aiServices');
const { handleMessage } = require('./messageHandlerService');

async function processVoiceMessage(audioBuffer, userId) {
  try {
    const { success, text } = await transcribeAudio(audioBuffer);
    if (!success || !text) {
      return { 
        success: false, 
        message: '❌ ไม่สามารถฟังเสียงได้ชัดเจน\n\n💡 ลองพูดใหม่อีกครั้ง หรือพิมพ์ข้อความแทน' 
      };
    }

    Logger.info(`🎤 Voice Raw Text: "${text}"`);
    
    const result = await handleMessage(text, userId);
    
    if (!result || !result.message) {
      return {
        success: false,
        message: `🎤 ฉันได้ยินว่า: "${text}"\n\n❌ แต่ไม่เข้าใจคำสั่ง กรุณาลองใหม่`
      };
    }
    
    return {
      success: true,
      message: `🎤 ฉันได้ยินว่า: "${text}"\n\n${result.message}`
    };
    
  } catch (error) {
    Logger.error('Voice system failure', error);
    
    // ✅ ADD: Better error message for connection issues
    if (error.message?.includes('Connection error') || 
        error.code === 'ECONNREFUSED') {
      return {
        success: false,
        message: '❌ ขณะนี้ระบบเสียงขัดข้อง (ปัญหาการเชื่อมต่อ)\n\n' +
                 '💡 กรุณา:\n' +
                 '• พิมพ์ข้อความแทน\n' +
                 '• หรือลองอีกครั้งในอีกสักครู่\n\n' +
                 'ทีมงานกำลังแก้ไข 🔧'
      };
    }
    
    return { 
      success: false, 
      message: '❌ ระบบประมวลผลเสียงขัดข้อง\n\nกรุณาลองใหม่อีกครั้ง หรือพิมพ์ข้อความแทน' 
    };
  }
}
module.exports = { processVoiceMessage };
