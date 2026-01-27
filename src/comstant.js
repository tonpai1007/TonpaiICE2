// constants.js - NEW: Centralize all magic numbers
module.exports = {
  // Stock limits
  STOCK: {
    MIN_QUANTITY: 0,
    MAX_QUANTITY: 10000,
    LOW_STOCK_THRESHOLD: 5,
    MEDIUM_STOCK_THRESHOLD: 20,
    HIGH_STOCK_THRESHOLD: 100,
    CRITICAL_STOCK: 0
  },
  
  // Order limits
  ORDER: {
    MAX_ITEMS_PER_ORDER: 50,
    MAX_QUANTITY_PER_ITEM: 100,
    MIN_QUANTITY_PER_ITEM: 1,
    MAX_ORDER_VALUE: 100000, // 100k baht
    UNUSUAL_QUANTITY_THRESHOLD: 50 // Flag for review
  },
  
  // Cache durations (milliseconds)
  CACHE: {
    STOCK_DURATION: 5 * 60 * 1000,      // 5 minutes
    CUSTOMER_DURATION: 5 * 60 * 1000,   // 5 minutes
    SMART_LEARNING_DURATION: 10 * 60 * 1000, // 10 minutes
    PREDICTION_DURATION: 5 * 60 * 1000  // 5 minutes
  },
  
  // AI limits
  AI: {
    MAX_REQUESTS_PER_MINUTE: 30,
    MAX_REQUESTS_PER_DAY: 14400,
    MAX_PROMPT_LENGTH: 8000,
    MAX_CATALOG_ITEMS: 20, // Don't send more than 20 items
    MAX_CUSTOMERS_IN_PROMPT: 20
  },
  
  // Rate limiting
  RATE_LIMIT: {
    WEBHOOK_PER_MINUTE: 300,
    USER_PER_MINUTE: 20,
    MAX_TRACKED_KEYS: 10000
  },
  
  // Stock matching scores
  MATCHING: {
    EXACT_MATCH_SCORE: 1000,
    SUBSTRING_MATCH_SCORE: 500,
    PREFIX_BONUS: 100,
    REVERSE_SUBSTRING_SCORE: 300,
    KEYWORD_OVERLAP_MULTIPLIER: 50,
    PRICE_EXACT_MATCH_BONUS: 200,
    PRICE_FUZZY_MATCH_BONUS: 100,
    UNIT_MATCH_BONUS: 150,
    STOCK_AVAILABLE_BONUS: 10,
    AMBIGUITY_THRESHOLD: 100 // If score diff < 100, it's ambiguous
  },
  
  // Similarity thresholds
  SIMILARITY: {
    CUSTOMER_NAME_THRESHOLD: 0.7,
    PRODUCT_NAME_THRESHOLD: 0.6,
    FUZZY_PRICE_TOLERANCE: 0.15 // 15%
  },
  
  // Lock timeouts
  LOCKS: {
    STOCK_TRANSACTION_TIMEOUT: 10000, // 10 seconds
    MAX_CONCURRENT_LOCKS: 100
  },
  
  // Text limits
  TEXT: {
    MAX_INPUT_LENGTH: 500,
    MAX_CUSTOMER_NAME_LENGTH: 100,
    MIN_CUSTOMER_NAME_LENGTH: 2,
    MAX_PRODUCT_NAME_LENGTH: 200
  },
  
  // Customer prefixes
  CUSTOMER_PREFIXES: [
    'คุณ', 'พี่', 'น้อง', 'เจ๊', 'ร้าน', 'ป้า', 
    'ลุง', 'อา', 'เจ้า', 'คุณแม่', 'คุณพ่อ'
  ],
  
  // Stock keywords
  STOCK_KEYWORDS: ['เหลือ', 'มี', 'เติม', 'ลด', 'เพิ่ม', 'ปรับ'],
  ORDER_KEYWORDS: ['สั่ง', 'ซื้อ', 'เอา', 'ขอ', 'จอง'],
  
  // Sheet names
  SHEETS: {
    ORDERS: 'คำสั่งซื้อ',
    STOCK: 'สต็อก',
    CUSTOMERS: 'ลูกค้า',
    CREDIT: 'เครดิต',
    DASHBOARD: 'Dashboard',
    INBOX: 'Inbox',
    VARIANCE: 'VarianceLog'
  },
  
  // Date formats
  DATE: {
    DISPLAY_FORMAT: 'DD/MM/YYYY HH:mm:ss',
    ISO_FORMAT: 'YYYY-MM-DD',
    BUDDHIST_YEAR_OFFSET: 543
  },
  
  // Credit settings
  CREDIT: {
    DEFAULT_DUE_DAYS: 30,
    OVERDUE_WARNING_DAYS: 7
  },
  
  // Cleanup settings
  CLEANUP: {
    PAID_ORDER_RETENTION_DAYS: 30,
    RUN_HOUR: 3 // 3 AM
  }
};