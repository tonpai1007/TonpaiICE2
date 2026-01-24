// src/utils.js - FIXED: Consistent date handling

// ============================================================================
// DATE & TIME - STANDARDIZED GREGORIAN FORMAT
// ============================================================================

/**
 * Get current date in YYYY-MM-DD format (Gregorian)
 * Used for: Date comparisons, Dashboard, filtering
 * @returns {string} "2026-01-24"
 */
function getThaiDateString() {
  const now = new Date();
  const bangkokTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  return bangkokTime.toISOString().split('T')[0]; // Returns: "2026-01-24"
}

/**
 * Get current datetime in display format
 * Used for: Order timestamps, user-facing displays
 * @returns {string} "24/01/2026 14:30:00" (Thai format for readability)
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
 * ✅ FIX #3: Extract Gregorian date from ANY format
 * Handles both Thai display format and Gregorian format
 * 
 * Input examples:
 *   "24/01/2026 14:30:00" → "2026-01-24"
 *   "2026-01-24 14:30:00" → "2026-01-24"
 *   "24/01/2569"          → "2026-01-24" (Buddhist year conversion)
 * 
 * @param {string} dateStr - Date string in any format
 * @returns {string|null} "YYYY-MM-DD" or null if invalid
 */
function extractGregorianDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  
  const trimmed = dateStr.trim();
  
  // Handle format: "24/01/2026 14:30:00" or "24/01/2026"
  if (trimmed.includes('/')) {
    const datePart = trimmed.split(' ')[0]; // "24/01/2026"
    const parts = datePart.split('/');
    
    if (parts.length !== 3) return null;
    
    const [day, month, year] = parts;
    const yearNum = parseInt(year);
    
    // Check if Buddhist year (> 2500)
    if (yearNum > 2500) {
      const gregorianYear = yearNum - 543;
      return `${gregorianYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    
    // Already Gregorian
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  
  // Handle format: "2026-01-24 14:30:00" or "2026-01-24"
  if (trimmed.includes('-')) {
    return trimmed.split(' ')[0]; // "2026-01-24"
  }
  
  // Invalid format
  return null;
}

/**
 * Convert Thai Buddhist year date to Gregorian
 * @param {string} thaiDateStr - "24/01/2569"
 * @returns {string|null} "2026-01-24"
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
  return `${gregorianYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * ✅ FIX #3: Format Gregorian date for display
 * @param {string} gregorianDate - "2026-01-24"
 * @returns {string} "24/01/2026"
 */
function formatDateForDisplay(gregorianDate) {
  if (!gregorianDate) return '';
  
  const parts = gregorianDate.split('-');
  if (parts.length !== 3) return gregorianDate;
  
  const [year, month, day] = parts;
  return `${day}/${month}/${year}`;
}

/**
 * Check if two dates are the same day
 * @param {string} dateStr1 - Any date format
 * @param {string} dateStr2 - Any date format
 * @returns {boolean}
 */
function isSameDay(dateStr1, dateStr2) {
  const date1 = extractGregorianDate(dateStr1);
  const date2 = extractGregorianDate(dateStr2);
  
  if (!date1 || !date2) return false;
  
  return date1 === date2;
}

/**
 * ✅ FIX #3: Get date range for filtering
 * @param {'today'|'yesterday'|'week'|'month'} period
 * @returns {{startDate: string, endDate: string}} Gregorian dates "YYYY-MM-DD"
 */
function getDateRange(period) {
  const now = new Date();
  const bangkokTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  
  const startDate = new Date(bangkokTime);
  const endDate = new Date(bangkokTime);
  
  switch (period) {
    case 'today':
      startDate.setHours(0, 0, 0, 0);
      endDate.setHours(23, 59, 59, 999);
      break;
    
    case 'yesterday':
      startDate.setDate(startDate.getDate() - 1);
      startDate.setHours(0, 0, 0, 0);
      endDate.setDate(endDate.getDate() - 1);
      endDate.setHours(23, 59, 59, 999);
      break;
    
    case 'week':
      startDate.setDate(startDate.getDate() - 7);
      startDate.setHours(0, 0, 0, 0);
      endDate.setHours(23, 59, 59, 999);
      break;
    
    case 'month':
      startDate.setMonth(startDate.getMonth() - 1);
      startDate.setHours(0, 0, 0, 0);
      endDate.setHours(23, 59, 59, 999);
      break;
    
    default:
      startDate.setHours(0, 0, 0, 0);
      endDate.setHours(23, 59, 59, 999);
  }
  
  return {
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0]
  };
}

/**
 * ✅ FIX #3: Check if date is within range
 * @param {string} dateStr - Any format
 * @param {string} startDate - "YYYY-MM-DD"
 * @param {string} endDate - "YYYY-MM-DD"
 * @returns {boolean}
 */
function isDateInRange(dateStr, startDate, endDate) {
  const date = extractGregorianDate(dateStr);
  if (!date) return false;
  
  return date >= startDate && date <= endDate;
}

/**
 * ✅ FIX #3: Parse any date to Date object
 * @param {string} dateStr - Any format
 * @returns {Date|null}
 */
function parseToDate(dateStr) {
  const gregorian = extractGregorianDate(dateStr);
  if (!gregorian) return null;
  
  const date = new Date(gregorian);
  return isNaN(date.getTime()) ? null : date;
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
  
  /**
   * ✅ FIX #3: Validate date in any format
   */
  isValidDate: (dateStr) => {
    const parsed = parseToDate(dateStr);
    return parsed !== null;
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
// TEXT PROCESSING (unchanged)
// ============================================================================

function normalizeText(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[^\u0E00-\u0E7F0-9a-z]/g, '')
    .trim();
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
// RETRY LOGIC (unchanged)
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
// SKU GENERATION (unchanged)
// ============================================================================

function generateSKU(name, unit) {
  const n = (name || '').replace(/\s+/g, '').substring(0, 4).toUpperCase();
  const u = (unit || '').substring(0, 2).toUpperCase();
  const rand = Math.floor(100 + Math.random() * 900);
  return `${n}-${u}-${rand}`;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Text processing
  normalizeText,
  extractDigits,
  levenshteinDistance,
  longestCommonSubstring,
  similarity,
  calculateAdvancedSimilarity,
  
  // ✅ FIX #3: Improved date handling
  getThaiDateString,
  getThaiDateTimeString,
  extractGregorianDate,
  convertThaiDateToGregorian,
  formatDateForDisplay,
  isSameDay,
  getDateRange,
  isDateInRange,
  parseToDate,
  
  // Validation
  Validator,
  
  // Utilities
  retryWithBackoff,
  generateSKU
};