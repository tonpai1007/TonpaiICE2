// aiServices.js - FLEXIBLE: Supports Groq, Ollama, and OpenRouter
const OpenAI = require('openai');
const { CONFIG } = require('./config');
const { Logger } = require('./logger');

// ============================================================================
// CONFIGURATION
// ============================================================================

const AI_PROVIDER = process.env.AI_PROVIDER || 'groq'; // 'groq' | 'ollama' | 'openrouter'
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

let aiClient = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

function initializeAIServices() {
  try {
    switch (AI_PROVIDER) {
      case 'groq':
        return initializeGroq();
      
      case 'ollama':
        return initializeOllama();
      
      case 'openrouter':
        return initializeOpenRouter();
      
      default:
        throw new Error(`Unknown AI provider: ${AI_PROVIDER}`);
    }
  } catch (error) {
    Logger.error('❌ AI init failed', error);
    throw error;
  }
}

// ============================================================================
// GROQ SETUP (FREE - Recommended)
// ============================================================================

function initializeGroq() {
  if (!CONFIG.GROQ_API_KEY) {
    throw new Error('Missing GROQ_API_KEY');
  }

  aiClient = new OpenAI({
    apiKey: CONFIG.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1'
  });

  Logger.success('✅ Groq AI initialized (FREE tier)');
  Logger.info('   Model: llama-3.3-70b-versatile');
  Logger.info('   Audio: whisper-large-v3');
  
  return { groq: aiClient };
}

// ============================================================================
// OLLAMA SETUP (100% Local & Free)
// ============================================================================

function initializeOllama() {
  // Ollama doesn't need initialization, just check connection
  fetch(`${OLLAMA_BASE_URL}/api/tags`)
    .then(res => res.json())
    .then(data => {
      Logger.success('✅ Ollama connected (Local)');
      Logger.info(`   Models available: ${data.models?.length || 0}`);
      Logger.info(`   URL: ${OLLAMA_BASE_URL}`);
    })
    .catch(err => {
      Logger.error('❌ Ollama not running. Start it with: ollama serve');
      throw err;
    });

  aiClient = { provider: 'ollama' };
  return { ollama: aiClient };
}

// ============================================================================
// OPENROUTER SETUP (Free tier available)
// ============================================================================

function initializeOpenRouter() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY');
  }

  aiClient = new OpenAI({
    apiKey: apiKey,
    baseURL: 'https://openrouter.ai/api/v1'
  });

  Logger.success('✅ OpenRouter initialized');
  Logger.info('   Using free tier models');
  
  return { openrouter: aiClient };
}

// ============================================================================
// UNIFIED GENERATION FUNCTION
// ============================================================================

async function generateWithGroq(prompt, jsonMode = false) {
  if (!aiClient) throw new Error('AI client not initialized');

  try {
    switch (AI_PROVIDER) {
      case 'groq':
        return await generateGroq(prompt, jsonMode);
      
      case 'ollama':
        return await generateOllama(prompt, jsonMode);
      
      case 'openrouter':
        return await generateOpenRouter(prompt, jsonMode);
      
      default:
        throw new Error(`Unknown provider: ${AI_PROVIDER}`);
    }
  } catch (error) {
    Logger.error(`${AI_PROVIDER} generation failed`, error);
    throw error;
  }
}

// ============================================================================
// PROVIDER-SPECIFIC IMPLEMENTATIONS
// ============================================================================

async function generateGroq(prompt, jsonMode) {
  const response = await aiClient.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    response_format: jsonMode ? { type: 'json_object' } : undefined
  });

  const content = response.choices[0].message.content.trim();
  return jsonMode ? JSON.parse(content) : content;
}

async function generateOllama(prompt, jsonMode) {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama3.2:3b', // or 'llama3:8b' for better quality
      prompt: prompt,
      stream: false,
      format: jsonMode ? 'json' : undefined,
      options: {
        temperature: 0.1
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.statusText}`);
  }

  const data = await response.json();
  const content = data.response.trim();
  
  return jsonMode ? JSON.parse(content) : content;
}

async function generateOpenRouter(prompt, jsonMode) {
  // Use free models from OpenRouter
  const model = 'meta-llama/llama-3.2-3b-instruct:free'; // Free tier
  
  const response = await aiClient.chat.completions.create({
    model: model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    response_format: jsonMode ? { type: 'json_object' } : undefined
  });

  const content = response.choices[0].message.content.trim();
  return jsonMode ? JSON.parse(content) : content;
}

// ============================================================================
// AUDIO TRANSCRIPTION
// ============================================================================

async function transcribeAudio(audioBuffer) {
  Logger.info(`🎤 Transcribing audio (${(audioBuffer.length / 1024).toFixed(1)}KB)`);

  try {
    switch (AI_PROVIDER) {
      case 'groq':
        return await transcribeGroq(audioBuffer);
      
      case 'ollama':
        return await transcribeOllama(audioBuffer);
      
      case 'openrouter':
        // OpenRouter doesn't support audio, fallback to Groq
        Logger.warn('OpenRouter doesn\'t support audio, using Groq Whisper');
        return await transcribeGroqWhisper(audioBuffer);
      
      default:
        throw new Error('Audio transcription not supported');
    }
  } catch (error) {
    Logger.error('Transcription failed', error);
    return { success: false, error: 'ฟังไม่ออก' };
  }
}

async function transcribeGroq(audioBuffer) {
  const file = new File([audioBuffer], 'audio.m4a', { type: 'audio/m4a' });
  
  const transcription = await aiClient.audio.transcriptions.create({
    file: file,
    model: 'whisper-large-v3',
    language: 'th',
    temperature: 0.0
  });

  const text = transcription.text.trim();
  Logger.success(`✅ Transcribed: "${text}"`);

  return { success: true, text };
}

async function transcribeOllama(audioBuffer) {
  // Ollama with whisper model
  // Note: You need to have whisper model installed
  // Run: ollama pull whisper
  
  try {
    // Convert audio to base64
    const base64Audio = audioBuffer.toString('base64');
    
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'whisper',
        prompt: `Transcribe this Thai audio: ${base64Audio}`,
        stream: false
      })
    });

    const data = await response.json();
    const text = data.response.trim();
    
    Logger.success(`✅ Transcribed (Ollama): "${text}"`);
    return { success: true, text };
    
  } catch (error) {
    Logger.error('Ollama whisper failed', error);
    return { success: false, error: 'ฟังไม่ออก' };
  }
}

async function transcribeGroqWhisper(audioBuffer) {
  // Fallback to Groq Whisper (always free)
  const groqKey = process.env.GROQ_API_KEY;
  
  if (!groqKey) {
    throw new Error('Need GROQ_API_KEY for audio transcription');
  }

  const groqClient = new OpenAI({
    apiKey: groqKey,
    baseURL: 'https://api.groq.com/openai/v1'
  });

  const file = new File([audioBuffer], 'audio.m4a', { type: 'audio/m4a' });
  
  const transcription = await groqClient.audio.transcriptions.create({
    file: file,
    model: 'whisper-large-v3',
    language: 'th',
    temperature: 0.0
  });

  const text = transcription.text.trim();
  Logger.success(`✅ Transcribed (Groq Whisper): "${text}"`);

  return { success: true, text };
}

// ============================================================================
// GETTERS
// ============================================================================

function getGroq() {
  return aiClient;
}

function getProviderInfo() {
  return {
    provider: AI_PROVIDER,
    baseUrl: AI_PROVIDER === 'ollama' ? OLLAMA_BASE_URL : undefined,
    model: AI_PROVIDER === 'groq' ? 'llama-3.3-70b-versatile' : 
           AI_PROVIDER === 'ollama' ? 'llama3.2:3b' :
           'meta-llama/llama-3.2-3b-instruct:free'
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  initializeAIServices,
  generateWithGroq,
  transcribeAudio,
  getGroq,
  getProviderInfo
};
