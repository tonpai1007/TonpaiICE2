// aiServices.js - Gemini and AssemblyAI integration

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { AssemblyAI } = require('assemblyai');
const { CONFIG } = require('./config');
const { Logger } = require('./logger');

let genAI = null;
let assemblyClient = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

function initializeAIServices() {
  try {
    // Initialize Gemini
    if (CONFIG.GEMINI_API_KEY) {
      genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);
      Logger.success('Gemini initialized');
    } else {
      Logger.warn('Gemini API key not provided');
    }

    // Initialize AssemblyAI
    if (CONFIG.ASSEMBLYAI_API_KEY) {
      assemblyClient = new AssemblyAI({ apiKey: CONFIG.ASSEMBLYAI_API_KEY });
      Logger.success('AssemblyAI initialized');
    } else {
      Logger.warn('AssemblyAI API key not provided');
    }

    return { genAI, assemblyClient };
  } catch (error) {
    Logger.error('Failed to initialize AI services', error);
    throw error;
  }
}

// ============================================================================
// GEMINI OPERATIONS
// ============================================================================

async function generateWithGemini(prompt, schema = null, temperature = 0.1) {
  if (!genAI) {
    throw new Error('Gemini not initialized');
  }

  try {
    const config = {
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        temperature,
        topP: 0.9,
        topK: 40
      }
    };

    if (schema) {
      config.generationConfig.responseMimeType = 'application/json';
      config.generationConfig.responseSchema = schema;
    }

    const model = genAI.getGenerativeModel(config);
    const result = await model.generateContent(prompt);
    const responseText = result.response.text().trim();

    if (schema) {
      return JSON.parse(responseText);
    }

    return responseText;
  } catch (error) {
    Logger.error('Gemini generation failed', error);
    throw error;
  }
}

// ============================================================================
// ASSEMBLYAI OPERATIONS
// ============================================================================

async function transcribeAudio(audioBuffer, boostWords = []) {
  if (!assemblyClient) {
    throw new Error('AssemblyAI not initialized');
  }

  try {
    Logger.info(`Transcribing audio (${(audioBuffer.length / 1024).toFixed(1)}KB)`);

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
      throw new Error(transcript.error);
    }

    const transcribed = transcript.text || '';
    const confidence = transcript.confidence || 0;

    Logger.info(`Transcribed: "${transcribed}" (${(confidence * 100).toFixed(1)}%)`);

    return {
      text: transcribed,
      confidence
    };
  } catch (error) {
    Logger.error('AssemblyAI transcription failed', error);
    throw error;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  initializeAIServices,
  getGemini: () => genAI,
  getAssembly: () => assemblyClient,
  generateWithGemini,
  transcribeAudio
};
