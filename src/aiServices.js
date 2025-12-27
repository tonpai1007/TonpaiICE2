// ============================================================================
// AI SERVICES - Gemini Only (AssemblyAI Removed)
// ============================================================================

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { CONFIG } = require('./config');
const { Logger } = require('./logger');

let genAI = null;

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

    return { genAI };
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
      model: 'gemini-2.5-flash',
      generationConfig: {
        temperature,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 8192,
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
// EXPORTS
// ============================================================================

module.exports = {
  initializeAIServices,
  getGemini: () => genAI,
  generateWithGemini
};