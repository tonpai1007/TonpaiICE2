// aiServices.js - FIXED: Defensive OpenAI client initialization
const { CONFIG } = require('./config');
const { Logger } = require('./logger');
const { Readable } = require('stream');
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
// LAZY LOAD OPENAI (Prevents import issues)
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
// GROQ SETUP - WITH DEFENSIVE CHECKS
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
    // Load OpenAI SDK
    const OpenAIClass = loadOpenAI();
    
    // Create client with minimal config
    groqClient = new OpenAIClass({
      apiKey: apiKey.trim(),
      baseURL: 'https://api.groq.com/openai/v1',
      dangerouslyAllowBrowser: false,
      timeout: 30000,
      maxRetries: 2,
      defaultHeaders: {}
    });

    // Verify client was created
    if (!groqClient) {
      throw new Error('Failed to create Groq client instance');
    }

    Logger.success('✅ Groq AI initialized');
    Logger.info('   Model: llama-3.3-70b-versatile');
    Logger.info('   Audio: whisper-large-v3');
    Logger.info('   Client type:', groqClient.constructor.name);
    
    return { groq: groqClient };
  } catch (error) {
    Logger.error('Failed to initialize Groq client', error);
    Logger.error('API Key length:', apiKey ? apiKey.length : 0);
    Logger.error('API Key prefix:', apiKey ? apiKey.substring(0, 10) + '...' : 'none');
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
// UNIFIED GENERATION - WITH COMPREHENSIVE SAFETY
// ============================================================================

async function generateWithGroq(prompt, jsonMode = false) {
  // Pre-flight checks
  if (!isInitialized) {
    const error = new Error('AI service not initialized. Call initializeAIServices() first.');
    Logger.error('generateWithGroq called before initialization');
    throw error;
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
      
      default:
        Logger.warn(`Unknown provider ${AI_PROVIDER}, using Groq`);
        return await generateGroq(prompt, jsonMode);
    }
  } catch (error) {
    Logger.error(`${AI_PROVIDER} generation failed:`, error.message);
    Logger.error('Error type:', error.constructor.name);
    Logger.error('Error stack:', error.stack?.substring(0, 500));
    
    // Fallback to Groq if Ollama fails
    if (AI_PROVIDER === 'ollama' && groqClient) {
      Logger.warn('⚠️  Attempting fallback to Groq...');
      try {
        return await generateGroq(prompt, jsonMode);
      } catch (fallbackError) {
        Logger.error('Fallback also failed:', fallbackError.message);
        throw fallbackError;
      }
    }
    
    throw error;
  }
}

// ============================================================================
// GROQ IMPLEMENTATION - ULTRA DEFENSIVE
// ============================================================================

async function generateGroq(prompt, jsonMode) {
  if (!groqClient) {
    throw new Error('Groq client is null - initialization may have failed');
  }

  // Verify client has required methods
  if (typeof groqClient.chat?.completions?.create !== 'function') {
    Logger.error('Groq client structure:', Object.keys(groqClient));
    Logger.error('Chat object:', Object.keys(groqClient.chat || {}));
    throw new Error('Groq client missing chat.completions.create method');
  }

  try {
    Logger.debug(`📤 Groq request (${jsonMode ? 'JSON' : 'text'}): ${prompt.substring(0, 100)}...`);
    
    const requestOptions = {
      model: 'llama-3.3-70b-versatile',
      messages: [{ 
        role: 'user', 
        content: prompt 
      }],
      temperature: 0.1,
      max_tokens: 2000
    };

    if (jsonMode) {
      requestOptions.response_format = { type: 'json_object' };
    }

    const response = await groqClient.chat.completions.create(requestOptions);

    // Validate response structure
    if (!response) {
      throw new Error('Groq returned null/undefined response');
    }

    if (!response.choices || !Array.isArray(response.choices)) {
      Logger.error('Invalid response structure:', JSON.stringify(response));
      throw new Error('Groq response missing choices array');
    }

    if (response.choices.length === 0) {
      throw new Error('Groq returned empty choices array');
    }

    if (!response.choices[0].message?.content) {
      Logger.error('Choice structure:', JSON.stringify(response.choices[0]));
      throw new Error('Groq response missing message content');
    }

    const content = response.choices[0].message.content.trim();
    
    if (!content) {
      throw new Error('Groq returned empty content');
    }
    
    Logger.debug(`📥 Groq response (${content.length} chars)`);
    
    if (jsonMode) {
      try {
        const parsed = JSON.parse(content);
        return parsed;
      } catch (parseError) {
        Logger.error('JSON parse failed. Raw content:', content.substring(0, 500));
        throw new Error(`Failed to parse JSON response: ${parseError.message}`);
      }
    }
    
    return content;
    
  } catch (error) {
    // Enhanced error reporting
    if (error.response) {
      Logger.error('Groq API error response:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: JSON.stringify(error.response.data).substring(0, 500)
      });
    } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      Logger.error('Groq request timeout');
    } else if (error.message?.includes('checkLimit')) {
      Logger.error('Rate limit check error - this suggests OpenAI client initialization issue');
      Logger.error('Client state:', {
        exists: !!groqClient,
        type: groqClient?.constructor?.name,
        hasChat: !!groqClient?.chat,
        hasCompletions: !!groqClient?.chat?.completions
      });
    } else {
      Logger.error('Groq request failed:', error.message);
    }
    
    throw error;
  }
}

// ============================================================================
// OLLAMA IMPLEMENTATION
// ============================================================================



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
      try {
        return JSON.parse(content);
      } catch (parseError) {
        throw new Error('Failed to parse JSON from OpenRouter');
      }
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
    
    if (AI_PROVIDER === 'ollama') {
      Logger.warn('⚠️  No Groq available, trying Ollama Whisper...');
      return await transcribeWithOllamaWhisper(audioBuffer);
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

async function transcribeWithGroqWhisper(audioBuffer) {
  if (!groqClient) {
    throw new Error('Groq client not available');
  }

  Logger.info('🎤 Using Groq Whisper...');
  
  try {
    // ✅ FIX: Create a File-like object that OpenAI SDK expects
    const file = new File([audioBuffer], 'audio.m4a', {
      type: 'audio/m4a'
    });
    
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
    
  } catch (error) {
    Logger.error('Groq Whisper failed:', error.message);
    throw error;
  }
}


async function transcribeWithOllamaWhisper(audioBuffer) {
  Logger.info('🎤 Ollama Whisper not implemented');
  throw new Error('Ollama Whisper support coming soon. Use GROQ_API_KEY for audio.');
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
    audioSupport: groqClient !== null
  };
}

function isAudioSupported() {
  return groqClient !== null;
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