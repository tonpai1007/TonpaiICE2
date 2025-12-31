// aiServices.js - Resilient AI Service Layer with Health Checks

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { AssemblyAI } = require('assemblyai');
const { CONFIG } = require('./config');
const { Logger } = require('./logger');

// ============================================================================
// SERVICE STATE MANAGEMENT
// ============================================================================

let genAI = null;
let assemblyClient = null;
let serviceHealth = {
  gemini: false,
  assemblyAI: false,
  lastCheck: null
};

// ============================================================================
// INITIALIZATION WITH VALIDATION
// ============================================================================

function initializeAIServices() {
  try {
    // Initialize Gemini with validation
    if (CONFIG.GEMINI_API_KEY && CONFIG.GEMINI_API_KEY.length > 20) {
      try {
        genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);
        serviceHealth.gemini = true;
        Logger.success('✅ Gemini initialized and validated');
      } catch (geminiError) {
        Logger.error('❌ Gemini initialization failed', geminiError);
        serviceHealth.gemini = false;
      }
    } else {
      Logger.warn('⚠️ Gemini API key invalid or missing - RAG fallback only');
      serviceHealth.gemini = false;
    }

    // Initialize AssemblyAI with validation
    if (CONFIG.ASSEMBLYAI_API_KEY && CONFIG.ASSEMBLYAI_API_KEY.length > 20) {
      try {
        assemblyClient = new AssemblyAI({ apiKey: CONFIG.ASSEMBLYAI_API_KEY });
        serviceHealth.assemblyAI = true;
        Logger.success('✅ AssemblyAI initialized and validated');
      } catch (assemblyError) {
        Logger.error('❌ AssemblyAI initialization failed', assemblyError);
        serviceHealth.assemblyAI = false;
      }
    } else {
      Logger.warn('⚠️ AssemblyAI API key invalid or missing - voice disabled');
      serviceHealth.assemblyAI = false;
    }

    serviceHealth.lastCheck = new Date().toISOString();
    
    // System Status Report
    Logger.info('🔍 AI Services Health Check:');
    Logger.info(`   Gemini: ${serviceHealth.gemini ? '✅ Ready' : '❌ Unavailable'}`);
    Logger.info(`   AssemblyAI: ${serviceHealth.assemblyAI ? '✅ Ready' : '❌ Unavailable'}`);
    
    return { genAI, assemblyClient, serviceHealth };
  } catch (error) {
    Logger.error('❌ CRITICAL: AI Services initialization failed', error);
    throw error;
  }
}

// ============================================================================
// HEALTH CHECK API
// ============================================================================

function getServiceHealth() {
  return {
    ...serviceHealth,
    timestamp: new Date().toISOString(),
    geminiAvailable: genAI !== null && serviceHealth.gemini,
    assemblyAvailable: assemblyClient !== null && serviceHealth.assemblyAI
  };
}

function isGeminiAvailable() {
  return genAI !== null && serviceHealth.gemini;
}

function isAssemblyAvailable() {
  return assemblyClient !== null && serviceHealth.assemblyAI;
}

// ============================================================================
// GEMINI OPERATIONS - WITH RESILIENCE
// ============================================================================

async function generateWithGemini(prompt, schema = null, temperature = 0.1) {
  // Pre-flight check
  if (!isGeminiAvailable()) {
    const error = new Error('GEMINI_UNAVAILABLE: Service not initialized or API key invalid');
    error.code = 'SERVICE_UNAVAILABLE';
    throw error;
  }

  try {
    const config = {
      model: 'gemini-1.5-flash',
      generationConfig: {
        temperature,
        topP: 0.9,
        topK: 40,
      }
    };

    if (schema) {
      config.generationConfig.responseMimeType = 'application/json';
      config.generationConfig.responseSchema = schema;
    }

    const model = genAI.getGenerativeModel(config);
    
    // Add timeout
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('GEMINI_TIMEOUT: Request exceeded 30s')), 30000)
    );
    
    const generationPromise = model.generateContent(prompt);
    
    const result = await Promise.race([generationPromise, timeoutPromise]);
    const responseText = result.response.text().trim();

    if (schema) {
      try {
        return JSON.parse(responseText);
      } catch (parseError) {
        Logger.error('❌ Gemini JSON parse failed', parseError);
        Logger.debug('Raw response:', responseText);
        throw new Error('GEMINI_PARSE_ERROR: Invalid JSON response');
      }
    }

    return responseText;
  } catch (error) {
    Logger.error('❌ Gemini generation failed', error);
    
    // Enhanced error context
    if (error.message?.includes('quota') || error.message?.includes('429')) {
      error.code = 'QUOTA_EXCEEDED';
      error.retryable = true;
    } else if (error.message?.includes('timeout') || error.code === 'GEMINI_TIMEOUT') {
      error.code = 'TIMEOUT';
      error.retryable = true;
    } else {
      error.code = 'UNKNOWN_ERROR';
      error.retryable = false;
    }
    
    throw error;
  }
}

// ============================================================================
// ASSEMBLYAI OPERATIONS - WITH RESILIENCE
// ============================================================================

async function transcribeAudio(audioBuffer, boostWords = []) {
  // Pre-flight check
  if (!isAssemblyAvailable()) {
    const error = new Error('ASSEMBLY_UNAVAILABLE: Service not initialized or API key invalid');
    error.code = 'SERVICE_UNAVAILABLE';
    throw error;
  }

  try {
    Logger.info(`🎤 Transcribing audio (${(audioBuffer.length / 1024).toFixed(1)}KB)`);

    const transcript = await assemblyClient.transcripts.transcribe({
      audio: audioBuffer,
      language_code: 'th',
      speech_model: 'best',
      punctuate: true,
      format_text: true,
      word_boost: boostWords,
      boost_param: 'high',
      dual_channel: false,
      speaker_labels: false,
      language_detection: false
    });

    if (transcript.status === 'error') {
      throw new Error(`ASSEMBLY_ERROR: ${transcript.error}`);
    }

    const transcribed = transcript.text || '';
    const confidence = transcript.confidence || 0;

    Logger.info(`✅ Transcribed: "${transcribed}" (${(confidence * 100).toFixed(1)}%)`);

    return {
      text: transcribed,
      confidence
    };
  } catch (error) {
    Logger.error('❌ AssemblyAI transcription failed', error);
    
    if (error.message?.includes('quota') || error.message?.includes('429')) {
      error.code = 'QUOTA_EXCEEDED';
      error.retryable = true;
    }
    
    throw error;
  }
}

// ============================================================================
// GRACEFUL DEGRADATION HELPERS
// ============================================================================

function shouldUseGemini() {
  return isGeminiAvailable();
}

function shouldUseAssembly() {
  return isAssemblyAvailable();
}

function getServiceStatus() {
  return {
    gemini: {
      available: isGeminiAvailable(),
      status: serviceHealth.gemini ? 'operational' : 'degraded'
    },
    assembly: {
      available: isAssemblyAvailable(),
      status: serviceHealth.assemblyAI ? 'operational' : 'degraded'
    },
    mode: isGeminiAvailable() ? 'AI-Enhanced' : 'RAG-Only'
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  initializeAIServices,
  getGemini: () => genAI,
  getAssembly: () => assemblyClient,
  generateWithGemini,
  transcribeAudio,
  
  // Health Check API
  getServiceHealth,
  isGeminiAvailable,
  isAssemblyAvailable,
  shouldUseGemini,
  shouldUseAssembly,
  getServiceStatus
};