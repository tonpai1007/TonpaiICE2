const OpenAI = require('openai');
const { CONFIG } = require('./config');
const { Logger } = require('./logger');

let groq = null;
let serviceHealth = {
  groq: false,
  lastCheck: null
};

function initializeAIServices() {
  try {
    if (CONFIG.GROQ_API_KEY) {
      groq = new OpenAI({
        apiKey: CONFIG.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1" // เชื่อมต่อกับ Groq
      });
      serviceHealth.groq = true;
      Logger.success('✅ Groq Cloud initialized');
    } else {
      Logger.warn('⚠️ Missing GROQ_API_KEY');
    }
    
    serviceHealth.lastCheck = new Date().toISOString();
    return { groq, serviceHealth };
  } catch (error) {
    Logger.error('❌ AI Initialization failed', error);
    throw error;
  }
}

async function generateWithGroq(prompt, isJson = false) {
  if (!groq) throw new Error('GROQ_NOT_INITIALIZED');

  try {
    const options = {
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.3-70b-versatile", // รุ่นที่แนะนำสำหรับงานภาษาไทย
      temperature: 0.1,
    };

    if (isJson) {
      options.response_format = { type: "json_object" };
    }

    const completion = await groq.chat.completions.create(options);
    const content = completion.choices[0].message.content;

    return isJson ? JSON.parse(content) : content;
  } catch (error) {
    Logger.error('❌ Groq Error', error);
    throw error;
  }
}

module.exports = {
  initializeAIServices,
  generateWithGroq, // ใช้แทน generateWithGemini
  isAIReady: () => serviceHealth.groq
};