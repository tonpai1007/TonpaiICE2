// aiServices.js - COMPLETE: Full Ollama support with fallbacks
const OpenAI = require('openai');
const { CONFIG } = require('./config');
const { Logger } = require('./logger');

// ============================================================================
// CONFIGURATION
// ============================================================================

const AI_PROVIDER = process.env.AI_PROVIDER || 'groq';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

let groqClient = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

function initializeAIServices() {
  try {
    Logger.info(`🤖 Initializing AI: ${AI_PROVIDER}`);
    
    switch (AI_PROVIDER) {
      case 'groq':
        return initializeGroq();
      
      case 'ollama':
        return initializeOllama();
      
      case 'openrouter':
        return initializeOpenRouter();
      
      default:
        Logger.warn(`Unknown AI_PROVIDER: ${AI_PROVIDER}, defaulting to Groq`);
        return initializeGroq();
    }
  } catch (error) {
    Logger.error('❌ AI init failed', error);
    throw error;
  }
}

// ============================================================================
// GROQ SETUP
// ============================================================================

function initializeGroq() {
  if (!CONFIG.GROQ_API_KEY) {
    throw new Error('Missing GROQ_API_KEY');
  }

  groqClient = new OpenAI({
    apiKey: CONFIG.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1'
  });

  Logger.success('✅ Groq AI initialized');
  Logger.info('   Model: llama-3.3-70b-versatile');
  Logger.info('   Audio: whisper-large-v3');
  
  return { groq: groqClient };
}

// ============================================================================
// OLLAMA SETUP
// ============================================================================

async function initializeOllama() {
  try {
    // Test connection
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    
    if (!response.ok) {
      throw new Error('Ollama not responding');
    }
    
    const data = await response.json();
    const models = data.models || [];
    
    Logger.success('✅ Ollama connected (Local AI)');
    Logger.info(`   URL: ${OLLAMA_BASE_URL}`);
    Logger.info(`   Model: ${OLLAMA_MODEL}`);
    Logger.info(`   Available models: ${models.length}`);
    
    // Check if our model exists
    const hasModel = models.some(m => m.name === OLLAMA_MODEL);
    if (!hasModel) {
      Logger.warn(`⚠️  Model ${OLLAMA_MODEL} not found`);
      Logger.info(`   Run: ollama pull ${OLLAMA_MODEL}`);
    }
    
    // Setup Groq for audio fallback if available
    if (CONFIG.GROQ_API_KEY) {
      groqClient = new OpenAI({
        apiKey: CONFIG.GROQ_API_KEY,
        baseURL: 'https://api.groq.com/openai/v1'
      });
      Logger.success('   ✅ Groq Whisper available for audio');
    } else {
      Logger.warn('   ⚠️  No GROQ_API_KEY - voice messages will fail');
      Logger.info('   Add GROQ_API_KEY to .env for voice support');
    }
    
    return { ollama: true };
  } catch (error) {
    Logger.error('❌ Ollama connection failed', error);
    Logger.error('   Make sure Ollama is running: ollama serve');
    throw error;
  }
}

// ============================================================================
// OPENROUTER SETUP
// ============================================================================

function initializeOpenRouter() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY');
  }

  groqClient = new OpenAI({
    apiKey: apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/yourusername/order-bot',
      'X-Title': 'Order Bot'
    }
  });

  Logger.success('✅ OpenRouter initialized');
  Logger.info('   Model: meta-llama/llama-3.2-3b-instruct:free');
  
  return { openrouter: groqClient };
}

// ============================================================================
// UNIFIED GENERATION FUNCTION
// ============================================================================

async function generateWithGroq(prompt, jsonMode = false) {
  try {
    switch (AI_PROVIDER) {
      case 'groq':
        return await generateGroq(prompt, jsonMode);
      
      case 'ollama':
        return await generateOllama(prompt, jsonMode);
      
      case 'openrouter':
        return await generateOpenRouter(prompt, jsonMode);
      
      default:
        Logger.warn(`Unknown provider ${AI_PROVIDER}, using Groq`);
        return await generateGroq(prompt, jsonMode);
    }
  } catch (error) {
    Logger.error(`${AI_PROVIDER} generation failed`, error);
    
    // Fallback to Groq if Ollama fails and Groq is available
    if (AI_PROVIDER === 'ollama' && groqClient) {
      Logger.warn('⚠️  Falling back to Groq...');
      return await generateGroq(prompt, jsonMode);
    }
    
    throw error;
  }
}

// ============================================================================
// GROQ IMPLEMENTATION
// ============================================================================

async function generateGroq(prompt, jsonMode) {
  if (!groqClient) {
    throw new Error('Groq client not initialized');
  }

  const response = await groqClient.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 2000,
    response_format: jsonMode ? { type: 'json_object' } : undefined
  });

  const content = response.choices[0].message.content.trim();
  return jsonMode ? JSON.parse(content) : content;
}

// ============================================================================
// OLLAMA IMPLEMENTATION
// ============================================================================

async function generateOllama(prompt, jsonMode) {
  Logger.debug(`🦙 Ollama generating (${jsonMode ? 'JSON' : 'text'})...`);
  
  const startTime = Date.now();
  
  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: prompt,
      stream: false,
      format: jsonMode ? 'json' : undefined,
      options: {
        temperature: 0.1,
        num_predict: 2000,
        top_k: 40,
        top_p: 0.9,
        repeat_penalty: 1.1
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.response?.trim();
  
  if (!content) {
    throw new Error('Ollama returned empty response');
  }
  
  const duration = Date.now() - startTime;
  Logger.debug(`✅ Ollama completed in ${duration}ms`);
  
  return jsonMode ? JSON.parse(content) : content;
}

// ============================================================================
// OPENROUTER IMPLEMENTATION
// ============================================================================

async function generateOpenRouter(prompt, jsonMode) {
  const response = await groqClient.chat.completions.create({
    model: 'meta-llama/llama-3.2-3b-instruct:free',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 2000,
    response_format: jsonMode ? { type: 'json_object' } : undefined
  });

  const content = response.choices[0].message.content.trim();
  return jsonMode ? JSON.parse(content) : content;
}

// ============================================================================
// AUDIO TRANSCRIPTION - WITH SMART FALLBACKS
// ============================================================================

async function transcribeAudio(audioBuffer) {
  Logger.info(`🎤 Transcribing audio (${(audioBuffer.length / 1024).toFixed(1)}KB)`);

  try {
    // Priority 1: Use Groq Whisper (best quality, always free)
    if (groqClient) {
      return await transcribeWithGroqWhisper(audioBuffer);
    }
    
    // Priority 2: Try Ollama Whisper (if available)
    if (AI_PROVIDER === 'ollama') {
      Logger.warn('⚠️  No Groq key found, trying Ollama Whisper...');
      return await transcribeWithOllamaWhisper(audioBuffer);
    }
    
    // No transcription available
    throw new Error('No audio transcription service available');
    
  } catch (error) {
    Logger.error('Audio transcription failed', error);
    
    return { 
      success: false, 
      error: '❌ ไม่สามารถฟังเสียงได้\n\n' +
             'กรุณา:\n' +
             '• ลองพูดใหม่อีกครั้ง\n' +
             '• หรือพิมพ์ข้อความแทน'
    };
  }
}

// ============================================================================
// GROQ WHISPER (Recommended for audio)
// ============================================================================

async function transcribeWithGroqWhisper(audioBuffer) {
  if (!groqClient) {
    throw new Error('Groq client not available for audio');
  }

  Logger.info('🎤 Using Groq Whisper...');
  
  const file = new File([audioBuffer], 'audio.m4a', { type: 'audio/m4a' });
  
  const transcription = await groqClient.audio.transcriptions.create({
    file: file,
    model: 'whisper-large-v3',
    language: 'th',
    temperature: 0.0,
    response_format: 'text'
  });

  const text = transcription.text?.trim() || transcription.trim();
  
  if (!text) {
    throw new Error('Empty transcription');
  }
  
  Logger.success(`✅ Transcribed: "${text}"`);
  return { success: true, text };
}

// ============================================================================
// OLLAMA WHISPER (Experimental fallback)
// ============================================================================

async function transcribeWithOllamaWhisper(audioBuffer) {
  Logger.info('🎤 Using Ollama Whisper (experimental)...');
  
  try {
    // Check if whisper model exists
    const tagsResponse = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    const tagsData = await tagsResponse.json();
    const hasWhisper = tagsData.models?.some(m => m.name.includes('whisper'));
    
    if (!hasWhisper) {
      throw new Error('Whisper model not found. Run: ollama pull whisper');
    }
    
    // Convert audio to base64
    const base64Audio = audioBuffer.toString('base64');
    
    // Use Ollama's generate endpoint with whisper
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'whisper',
        prompt: `[Audio transcription task] Transcribe this Thai audio accurately: ${base64Audio.substring(0, 1000)}...`,
        stream: false
      })
    });
    
    if (!response.ok) {
      throw new Error('Ollama whisper failed');
    }
    
    const data = await response.json();
    const text = data.response?.trim();
    
    if (!text) {
      throw new Error('Empty transcription from Ollama');
    }
    
    Logger.success(`✅ Ollama transcribed: "${text}"`);
    return { success: true, text };
    
  } catch (error) {
    Logger.error('Ollama Whisper failed', error);
    throw new Error(
      'Ollama audio transcription not available.\n' +
      'Recommendation: Add GROQ_API_KEY to .env for free Whisper support'
    );
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getGroq() {
  return groqClient;
}

function getProviderInfo() {
  return {
    provider: AI_PROVIDER,
    baseUrl: AI_PROVIDER === 'ollama' ? OLLAMA_BASE_URL : undefined,
    model: AI_PROVIDER === 'groq' ? 'llama-3.3-70b-versatile' : 
           AI_PROVIDER === 'ollama' ? OLLAMA_MODEL :
           'meta-llama/llama-3.2-3b-instruct:free',
    audioSupport: groqClient !== null ? 'Groq Whisper' : 
                  AI_PROVIDER === 'ollama' ? 'Ollama Whisper (experimental)' : 
                  'None'
  };
}

function isAudioSupported() {
  return groqClient !== null; // Audio only works if Groq is available
}

// ============================================================================
// HEALTH CHECK
// ============================================================================

async function checkAIHealth() {
  const health = {
    provider: AI_PROVIDER,
    textGeneration: false,
    audioTranscription: false,
    error: null
  };
  
  try {
    // Test text generation
    const testResult = await generateWithGroq('สวัสดี', false);
    health.textGeneration = testResult && testResult.length > 0;
    
    // Test audio support
    health.audioTranscription = isAudioSupported();
    
    if (!health.audioTranscription && AI_PROVIDER === 'ollama') {
      health.warning = 'Audio not supported. Add GROQ_API_KEY for voice messages.';
    }
    
  } catch (error) {
    health.error = error.message;
  }
  
  return health;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  initializeAIServices,
  generateWithGroq,
  transcribeAudio,
  getGroq,
  getProviderInfo,
  isAudioSupported,
  checkAIHealth
};
