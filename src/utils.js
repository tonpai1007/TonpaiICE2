// utils.js - FIXED: Consistent date handling across system
// ============================================================================
// TEXT PROCESSING
// ============================================================================

function normalizeText(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[^\u0E00-\u0E7F0-9a-z]/g, '')
    .trim();
}
function normalizeToGregorian(dateStr) {
  if (!dateStr) return null;
  
  // Handle "DD/MM/YYYY HH:MM:SS"
  if (dateStr.includes('/')) {
    const [datePart] = dateStr.split(' ');
    const [day, month, year] = datePart.split('/');
    return `${year}-${month}-${day}`;
  }
  
  // Handle "YYYY-MM-DD"
  return dateStr.split(' ')[0];
}
function extractDigits(str) {
  const match = String(str).match(/\d+/g);
  return match ? match.join('') : '';
}

function levenshteinDistance(s1, s2) {
  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

function longestCommonSubstring(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  
  const dp = Array(m + 1).fill(0);
  let max = 0;
  
  for (let i = 1; i <= n; i++) {
    let prev = 0;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev + 1;
        if (dp[j] > max) max = dp[j];
      } else {
        dp[j] = 0;
      }
      prev = tmp;
    }
  }
  return max;
}

function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length) || 1;
  return 1 - (levenshteinDistance(a, b) / maxLen);
}

function calculateAdvancedSimilarity(str1, str2) {
  const lev = 1 - (levenshteinDistance(str1, str2) / Math.max(str1.length, str2.length));
  const lcs = longestCommonSubstring(str1, str2) / Math.max(str1.length, str2.length);
  return (lev * 0.6) + (lcs * 0.4);
}

// ============================================================================
// DATE & TIME - FIXED: Consistent Gregorian format
// ============================================================================

/**
 * Get current date in YYYY-MM-DD format (Gregorian)
 * Used for: Date comparisons, Dashboard, filtering
 */
function getThaiDateString() {
  const now = new Date();
  const bangkokTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  return bangkokTime.toISOString().split('T')[0]; // Returns: "2026-01-07"
}

/**
 * Get current datetime in display format
 * Used for: Order timestamps, user-facing displays
 * Returns: "07/01/2026 14:30:00" (Thai format for readability)
 */
function getThaiDateTimeString() {
  const now = new Date();
  const bangkokTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  
  const day = String(bangkokTime.getDate()).padStart(2, '0');
  const month = String(bangkokTime.getMonth() + 1).padStart(2, '0');
  const year = bangkokTime.getFullYear();
  const hours = String(bangkokTime.getHours()).padStart(2, '0');
  const minutes = String(bangkokTime.getMinutes()).padStart(2, '0');
  const seconds = String(bangkokTime.getSeconds()).padStart(2, '0');
  
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

/**
 * Extract Gregorian date from Thai datetime string
 * Converts: "07/01/2026 14:30:00" → "2026-01-07"
 * Used for: Date comparisons in reports
 */
function extractGregorianDate(thaiDateTimeStr) {
  if (!thaiDateTimeStr) return null;
  
  // Handle format: "07/01/2026 14:30:00"
  if (thaiDateTimeStr.includes('/')) {
    const datePart = thaiDateTimeStr.split(' ')[0]; // "07/01/2026"
    const [day, month, year] = datePart.split('/');
    return `${year}-${month}-${day}`; // "2026-01-07"
  }
  
  // Handle format: "2026-01-07 14:30:00"
  return thaiDateTimeStr.split(' ')[0];
}

/**
 * Convert Thai Buddhist year date to Gregorian
 * Converts: "07/01/2569" → "2026-01-07"
 */
function convertThaiDateToGregorian(thaiDateStr) {
  const match = thaiDateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  
  const day = match[1];
  const month = match[2];
  const buddhistYear = parseInt(match[3]);
  
  // Check if it's already Gregorian (year < 2500)
  if (buddhistYear < 2500) {
    return `${buddhistYear}-${month}-${day}`;
  }
  
  // Convert from Buddhist to Gregorian
  const gregorianYear = buddhistYear - 543;
  return `${gregorianYear}-${month}-${day}`;
}

/**
 * Check if two dates are the same day
 */
function isSameDay(dateStr1, dateStr2) {
  const date1 = extractGregorianDate(dateStr1) || dateStr1;
  const date2 = extractGregorianDate(dateStr2) || dateStr2;
  return date1 === date2;
}

// ============================================================================
// VALIDATION
// ============================================================================

const Validator = {
  isValidOrderNumber: (orderNo) => {
    return Number.isInteger(orderNo) && orderNo > 0 && orderNo < 1000000;
  },
  
  isValidQuantity: (quantity) => {
    return Number.isInteger(quantity) && quantity > 0 && quantity <= 10000;
  },
  
  isValidDate: (dateStr) => {
    const date = new Date(dateStr);
    return date instanceof Date && !isNaN(date);
  },
  
  sanitizeText: (text) => {
    if (!text) return '';
    return String(text)
      .trim()
      .replace(/[<>]/g, '')
      .substring(0, 500);
  },
  
  sanitizeCustomerName: (name) => {
    if (!name) return 'ไม่ระบุ';
    return String(name)
      .trim()
      .replace(/[^\u0E00-\u0E7Fa-zA-Z\s]/g, '')
      .substring(0, 100);
  },
  
  sanitizeNumber: (num, defaultValue = 0) => {
    const parsed = parseFloat(num);
    return isNaN(parsed) ? defaultValue : Math.max(0, parsed);
  }
};

// ============================================================================
// RETRY LOGIC
// ============================================================================

async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      const isQuotaError = error.message?.includes('429') || 
                           error.message?.includes('quota') ||
                           error.message?.includes('Too Many Requests');
      
      let retryDelay = initialDelay * Math.pow(2, i);
      const retryMatch = error.message?.match(/retry in (\d+\.?\d*)/i);
      if (retryMatch) {
        retryDelay = Math.ceil(parseFloat(retryMatch[1]) * 1000);
      }
      
      if (isQuotaError && i < maxRetries - 1) {
        console.warn(`⏳ Rate limit hit. Retrying in ${retryDelay/1000}s... (${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      
      throw error;
    }
  }
}

// ============================================================================
// SKU GENERATION
// ============================================================================

function generateSKU(name, unit) {
  const n = (name || '').replace(/\s+/g, '').substring(0, 4).toUpperCase();
  const u = (unit || '').substring(0, 2).toUpperCase();
  const rand = Math.floor(100 + Math.random() * 900);
  return `${n}-${u}-${rand}`;
}

module.exports = {
  normalizeText,
  extractDigits,
  levenshteinDistance,
  longestCommonSubstring,
  similarity,
  calculateAdvancedSimilarity,
  getThaiDateString,
  getThaiDateTimeString,
  extractGregorianDate,
  convertThaiDateToGregorian,
  isSameDay,
  Validator,
  retryWithBackoff,
  generateSKU
};
