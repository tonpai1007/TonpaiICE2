// aiServices.js - Groq-powered AI (Whisper + Llama3)
const OpenAI = require('openai');
const { CONFIG } = require('./config');
const { Logger } = require('./logger');

let groq = null;

function initializeAIServices() {
  try {
    if (!CONFIG.GROQ_API_KEY) {
      throw new Error('Missing GROQ_API_KEY');
    }

    groq = new OpenAI({
      apiKey: CONFIG.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1'
    });

    Logger.success('✅ Groq AI initialized');
    return { groq };
  } catch (error) {
    Logger.error('❌ AI init failed', error);
    throw error;
  }
}

async function generateWithGroq(prompt, jsonMode = false) {
  if (!groq) throw new Error('Groq not initialized');

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      response_format: jsonMode ? { type: 'json_object' } : undefined
    });

    const content = response.choices[0].message.content.trim();
    return jsonMode ? JSON.parse(content) : content;
  } catch (error) {
    Logger.error('Groq generation failed', error);
    throw error;
  }
}

async function transcribeAudio(audioBuffer) {
  if (!groq) throw new Error('Groq not initialized');

  try {
    Logger.info(`🎤 Transcribing audio (${(audioBuffer.length / 1024).toFixed(1)}KB)`);

    const file = new File([audioBuffer], 'audio.m4a', { type: 'audio/m4a' });
    
    const transcription = await groq.audio.transcriptions.create({
      file: file,
      model: 'whisper-large-v3',
      language: 'th',
      temperature: 0.0
    });

    const text = transcription.text.trim();
    Logger.success(`✅ Transcribed: "${text}"`);

    return { success: true, text };
  } catch (error) {
    Logger.error('Transcription failed', error);
    return { success: false, error: 'ฟังไม่ออก' };
  }
}

function getGroq() {
  return groq;
}

module.exports = {
  initializeAIServices,
  generateWithGroq,
  transcribeAudio,
  getGroq
};