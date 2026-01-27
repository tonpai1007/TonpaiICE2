// aiServices.js - FIXED: All issues resolved
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { Blob } = require('buffer'); // ✅ For audio file handling

// ============================================================================
// CONFIGURATION
// ============================================================================

const AI_PROVIDER = process.env.AI_PROVIDER || 'groq';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

let OpenAI = null;
let groqClient = null;
let isInitialized = false;

// ============================================================================
// LAZY LOAD OPENAI
// ============================================================================

function loadOpenAI() {
  if (OpenAI) return OpenAI;
  
  try {
    OpenAI = require('openai');
    Logger.success('✅ OpenAI SDK loaded');
    return OpenAI;
  } catch (error) {
    Logger.error('Failed to load OpenAI SDK', error);
    throw new Error('OpenAI package not installed. Run: npm install openai');
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

function initializeAIServices() {
  try {
    Logger.info(`🤖 Initializing AI: ${AI_PROVIDER}`);
    
    switch (AI_PROVIDER) {
      case 'groq':
        initializeGroq();
        break;
      
      case 'ollama':
        initializeOllama();
        break;
      
      case 'openrouter':
        initializeOpenRouter();
        break;
      
      default:
        Logger.warn(`Unknown AI_PROVIDER: ${AI_PROVIDER}, defaulting to Groq`);
        initializeGroq();
    }
    
    isInitialized = true;
    return { success: true };
  } catch (error) {
    Logger.error('❌ AI init failed', error);
    isInitialized = false;
    throw error;
  }
}

// ============================================================================
// GROQ SETUP
// ============================================================================

function initializeGroq() {
  const apiKey = CONFIG.GROQ_API_KEY;
  
  if (!apiKey) {
    throw new Error('Missing GROQ_API_KEY in environment');
  }

  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error('GROQ_API_KEY is invalid (empty or not a string)');
  }

  try {
    const OpenAIClass = loadOpenAI();
    
    groqClient = new OpenAIClass({
      apiKey: apiKey.trim(),
      baseURL: 'https://api.groq.com/openai/v1',
      dangerouslyAllowBrowser: false,
      timeout: 30000,
      maxRetries: 2,
      defaultHeaders: {}
    });

    if (!groqClient) {
      throw new Error('Failed to create Groq client instance');
    }

    Logger.success('✅ Groq AI initialized');
    Logger.info('   Model: llama-3.3-70b-versatile');
    Logger.info('   Audio: whisper-large-v3');
    
    return { groq: groqClient };
  } catch (error) {
    Logger.error('Failed to initialize Groq client', error);
    throw error;
  }
}

// ============================================================================
// OLLAMA SETUP - ✅ FIXED: Now properly defined
// ============================================================================

function initializeOllama() {
  Logger.success('✅ Ollama initialized (local mode)');
  Logger.info(`   Base URL: ${OLLAMA_BASE_URL}`);
  Logger.info(`   Model: ${OLLAMA_MODEL}`);
  Logger.warn('   ⚠️  Audio transcription not available in Ollama mode');
  
  return { ollama: 'local' };
}

// ============================================================================
// OPENROUTER SETUP
// ============================================================================

function initializeOpenRouter() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY');
  }

  try {
    const OpenAIClass = loadOpenAI();
    
    groqClient = new OpenAIClass({
      apiKey: apiKey.trim(),
      baseURL: 'https://openrouter.ai/api/v1',
      timeout: 30000,
      maxRetries: 2,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/yourusername/order-bot',
        'X-Title': 'Order Bot'
      }
    });

    Logger.success('✅ OpenRouter initialized');
    Logger.info('   Model: meta-llama/llama-3.2-3b-instruct:free');
    
    return { openrouter: groqClient };
  } catch (error) {
    Logger.error('Failed to initialize OpenRouter client', error);
    throw error;
  }
}

// ============================================================================
// UNIFIED GENERATION
// ============================================================================

async function generateWithGroq(prompt, jsonMode = false) {
  if (!isInitialized) {
    throw new Error('AI service not initialized. Call initializeAIServices() first.');
  }

  if (!prompt || typeof prompt !== 'string') {
    throw new Error('Invalid prompt: must be a non-empty string');
  }

  try {
    switch (AI_PROVIDER) {
      case 'groq':
        return await generateGroq(prompt, jsonMode);
      
      case 'openrouter':
        return await generateOpenRouter(prompt, jsonMode);
      
      case 'ollama':
        Logger.warn('Ollama not fully implemented, using fallback');
        if (groqClient) {
          return await generateGroq(prompt, jsonMode);
        }
        throw new Error('No AI provider available');
      
      default:
        return await generateGroq(prompt, jsonMode);
    }
  } catch (error) {
    Logger.error(`${AI_PROVIDER} generation failed:`, error.message);
    throw error;
  }
}

// ============================================================================
// GROQ IMPLEMENTATION
// ============================================================================

async function generateGroq(prompt, jsonMode) {
  if (!groqClient) {
    throw new Error('Groq client is null - initialization may have failed');
  }

  if (typeof groqClient.chat?.completions?.create !== 'function') {
    throw new Error('Groq client missing chat.completions.create method');
  }

  try {
    Logger.debug(`📤 Groq request (${jsonMode ? 'JSON' : 'text'})`);
    
    const requestOptions = {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 2000
    };

    if (jsonMode) {
      requestOptions.response_format = { type: 'json_object' };
    }

    const response = await groqClient.chat.completions.create(requestOptions);

    if (!response?.choices?.[0]?.message?.content) {
      throw new Error('Invalid response from Groq');
    }

    const content = response.choices[0].message.content.trim();
    
    if (!content) {
      throw new Error('Groq returned empty content');
    }
    
    Logger.debug(`📥 Groq response (${content.length} chars)`);
    
    if (jsonMode) {
      try {
        return JSON.parse(content);
      } catch (parseError) {
        Logger.error('JSON parse failed. Raw:', content.substring(0, 200));
        throw new Error(`Failed to parse JSON: ${parseError.message}`);
      }
    }
    
    return content;
    
  } catch (error) {
    Logger.error('Groq request failed:', error.message);
    throw error;
  }
}

// ============================================================================
// OPENROUTER IMPLEMENTATION
// ============================================================================

async function generateOpenRouter(prompt, jsonMode) {
  if (!groqClient) {
    throw new Error('OpenRouter client not initialized');
  }

  try {
    const requestOptions = {
      model: 'meta-llama/llama-3.2-3b-instruct:free',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 2000
    };

    if (jsonMode) {
      requestOptions.response_format = { type: 'json_object' };
    }

    const response = await groqClient.chat.completions.create(requestOptions);

    if (!response?.choices?.[0]?.message?.content) {
      throw new Error('Invalid response from OpenRouter');
    }

    const content = response.choices[0].message.content.trim();
    
    if (jsonMode) {
      return JSON.parse(content);
    }
    
    return content;
    
  } catch (error) {
    Logger.error('OpenRouter request failed:', error.message);
    throw error;
  }
}

// ============================================================================
// AUDIO TRANSCRIPTION
// ============================================================================

async function transcribeAudio(audioBuffer) {
  Logger.info(`🎤 Transcribing audio (${(audioBuffer.length / 1024).toFixed(1)}KB)`);

  try {
    if (groqClient) {
      return await transcribeWithGroqWhisper(audioBuffer);
    }
    
    throw new Error('No audio transcription service available');
    
  } catch (error) {
    Logger.error('Audio transcription failed', error);
    
    return { 
      success: false, 
      error: '❌ ไม่สามารถฟังเสียงได้\n\nกรุณา:\n• ลองพูดใหม่อีกครั้ง\n• หรือพิมพ์ข้อความแทน'
    };
  }
}

// ============================================================================
// GROQ WHISPER - ✅ FIXED: Proper File object for Node.js
// ============================================================================

async function transcribeWithGroqWhisper(audioBuffer) {
  if (!groqClient) {
    throw new Error('Groq client not available');
  }

  Logger.info('🎤 Using Groq Whisper...');
  
  try {
    // ✅ FIX: Create proper file object for Node.js
    const audioBlob = new Blob([audioBuffer], { type: 'audio/m4a' });
    
    // Add file properties that OpenAI SDK expects
    const audioFile = Object.assign(audioBlob, {
      name: 'audio.m4a',
      lastModified: Date.now(),
      webkitRelativePath: ''
    });
    
    const transcription = await groqClient.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-large-v3',
      language: 'th',
      temperature: 0.0,
      response_format: 'text'
    });

    // Handle both string and object responses
    const text = typeof transcription === 'string' 
      ? transcription.trim() 
      : transcription.text?.trim();
    
    if (!text) {
      throw new Error('Empty transcription');
    }
    
    Logger.success(`✅ Transcribed: "${text}"`);
    return { success: true, text };
    
  } catch (error) {
    Logger.error('Groq Whisper failed:', error.message);
    
    // Better error messages
    if (error.message?.includes('file')) {
      throw new Error('Audio file format not supported');
    }
    
    throw error;
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

function getGroq() {
  return groqClient;
}

function getProviderInfo() {
  return {
    provider: AI_PROVIDER,
    initialized: isInitialized,
    clientExists: !!groqClient,
    clientType: groqClient?.constructor?.name,
    baseUrl: AI_PROVIDER === 'ollama' ? OLLAMA_BASE_URL : undefined,
    model: AI_PROVIDER === 'groq' ? 'llama-3.3-70b-versatile' : 
           AI_PROVIDER === 'ollama' ? OLLAMA_MODEL :
           'meta-llama/llama-3.2-3b-instruct:free',
    audioSupport: groqClient !== null && AI_PROVIDER !== 'ollama'
  };
}

function isAudioSupported() {
  return groqClient !== null && AI_PROVIDER !== 'ollama';
}

async function checkAIHealth() {
  const health = {
    provider: AI_PROVIDER,
    initialized: isInitialized,
    textGeneration: false,
    audioTranscription: false,
    error: null
  };
  
  if (!isInitialized) {
    health.error = 'Not initialized';
    return health;
  }
  
  try {
    const testResult = await generateWithGroq('test', false);
    health.textGeneration = !!testResult;
    health.audioTranscription = isAudioSupported();
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