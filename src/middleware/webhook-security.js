// src/middleware/webhook-security.js - FIXED: Memory leak prevention
const crypto = require('crypto');
const { CONFIG } = require('../config');
const { Logger } = require('../logger');

// ============================================================================
// SIGNATURE VERIFICATION
// ============================================================================

function verifyLineSignature(req, res, next) {
  const signature = req.headers['x-line-signature'];
  const channelSecret = CONFIG.LINE_SECRET;

  if (!signature) {
    Logger.error('❌ Missing x-line-signature header');
    return res.status(401).json({ error: 'Unauthorized: Missing signature' });
  }

  try {
    const body = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('SHA256', channelSecret)
      .update(body)
      .digest('base64');

    if (signature !== expectedSignature) {
      Logger.error('❌ Invalid signature');
      return res.status(401).json({ error: 'Unauthorized: Invalid signature' });
    }

    Logger.info('✅ Signature verified');
    next();
  } catch (error) {
    Logger.error('Signature verification error', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================================
// RATE LIMITING - FIXED: Memory leak prevention
// ============================================================================

class RateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60000; // 1 minute
    this.maxRequests = options.maxRequests || 100;
    this.maxKeys = options.maxKeys || 10000; // ✅ NEW: Prevent unbounded growth
    this.requests = new Map();
    
    // Cleanup old entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  check(identifier) {
    const now = Date.now();
    const key = identifier;
    
    // ✅ FIX: Enforce max keys limit
    if (!this.requests.has(key) && this.requests.size >= this.maxKeys) {
      Logger.warn(`⚠️ Rate limiter at max capacity (${this.maxKeys} keys), cleaning old entries`);
      this.forceCleanup();
    }
    
    if (!this.requests.has(key)) {
      this.requests.set(key, []);
    }
    
    const timestamps = this.requests.get(key);
    
    // Remove old timestamps outside the window
    const validTimestamps = timestamps.filter(t => now - t < this.windowMs);
    this.requests.set(key, validTimestamps);
    
    // Check if limit exceeded
    if (validTimestamps.length >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetIn: Math.ceil((validTimestamps[0] + this.windowMs - now) / 1000)
      };
    }
    
    // Add current timestamp
    validTimestamps.push(now);
    
    return {
      allowed: true,
      remaining: this.maxRequests - validTimestamps.length,
      resetIn: Math.ceil(this.windowMs / 1000)
    };
  }

  cleanup() {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [key, timestamps] of this.requests.entries()) {
      const validTimestamps = timestamps.filter(t => now - t < this.windowMs);
      
      if (validTimestamps.length === 0) {
        this.requests.delete(key);
        cleanedCount++;
      } else {
        this.requests.set(key, validTimestamps);
      }
    }
    
    if (cleanedCount > 0) {
      Logger.debug(`Rate limiter cleanup: Removed ${cleanedCount} inactive keys, ${this.requests.size} active`);
    }
  }

  // ✅ NEW: Force cleanup when at max capacity
  forceCleanup() {
    const now = Date.now();
    
    // Sort by oldest activity
    const entries = Array.from(this.requests.entries())
      .map(([key, timestamps]) => ({
        key,
        lastActivity: timestamps.length > 0 ? Math.max(...timestamps) : 0
      }))
      .sort((a, b) => a.lastActivity - b.lastActivity);
    
    // Remove oldest 20% of entries
    const removeCount = Math.floor(entries.length * 0.2);
    
    for (let i = 0; i < removeCount; i++) {
      this.requests.delete(entries[i].key);
    }
    
    Logger.info(`⚡ Force cleanup: Removed ${removeCount} oldest entries`);
  }

  // ✅ NEW: Get stats for monitoring
  getStats() {
    const now = Date.now();
    let totalRequests = 0;
    
    for (const timestamps of this.requests.values()) {
      totalRequests += timestamps.filter(t => now - t < this.windowMs).length;
    }
    
    return {
      activeKeys: this.requests.size,
      totalRequests: totalRequests,
      maxKeys: this.maxKeys,
      utilizationPercent: (this.requests.size / this.maxKeys * 100).toFixed(1)
    };
  }
}

// Global rate limiter instances
const webhookLimiter = new RateLimiter({
  windowMs: 60000,      // 1 minute
  maxRequests: 300,     // 300 requests per minute
  maxKeys: 5000         // ✅ Limit total keys
});

const userLimiter = new RateLimiter({
  windowMs: 60000,      // 1 minute  
  maxRequests: 20,      // 20 requests per user per minute
  maxKeys: 10000        // ✅ Limit total users tracked
});

function rateLimitMiddleware(req, res, next) {
  try {
    // Check global webhook rate limit
    const globalCheck = webhookLimiter.check('global');
    
    if (!globalCheck.allowed) {
      Logger.warn(`⚠️ Global rate limit exceeded. Reset in ${globalCheck.resetIn}s`);
      return res.status(429).json({ 
        error: 'Too Many Requests',
        retryAfter: globalCheck.resetIn
      });
    }
    
    // Check per-user rate limit
    const userId = req.body?.events?.[0]?.source?.userId;
    
    if (userId) {
      const userCheck = userLimiter.check(userId);
      
      if (!userCheck.allowed) {
        Logger.warn(`⚠️ User ${userId.substring(0, 8)} rate limit exceeded`);
        return res.status(429).json({ 
          error: 'Too Many Requests',
          retryAfter: userCheck.resetIn
        });
      }
      
      // Add rate limit headers
      res.setHeader('X-RateLimit-Limit', userLimiter.maxRequests);
      res.setHeader('X-RateLimit-Remaining', userCheck.remaining);
      res.setHeader('X-RateLimit-Reset', userCheck.resetIn);
    }
    
    next();
  } catch (error) {
    Logger.error('Rate limit middleware error', error);
    next(); // Don't block on errors
  }
}

// ============================================================================
// REQUEST VALIDATION
// ============================================================================

function validateWebhookRequest(req, res, next) {
  try {
    if (!req.body || typeof req.body !== 'object') {
      Logger.error('Invalid request body: not an object');
      return res.status(400).json({ error: 'Bad Request: Invalid body' });
    }
    
    if (!Array.isArray(req.body.events)) {
      Logger.error('Invalid request body: events is not an array');
      return res.status(400).json({ error: 'Bad Request: Invalid events' });
    }
    
    next();
  } catch (error) {
    Logger.error('Request validation error', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================================
// IP WHITELIST (OPTIONAL)
// ============================================================================

const LINE_WEBHOOK_IPS = [
  '147.92.128.0/17',
  '127.0.0.1',
  '::1'
];

function isIPInRange(ip, cidr) {
  if (cidr === ip) return true;
  if (!cidr.includes('/')) return false;
  
  const [range, bits] = cidr.split('/');
  return ip.startsWith(range.split('.').slice(0, 2).join('.'));
}

function ipWhitelistMiddleware(req, res, next) {
  try {
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                     req.socket.remoteAddress ||
                     req.connection.remoteAddress;
    
    Logger.debug(`Request from IP: ${clientIP}`);
    
    if (process.env.NODE_ENV !== 'production') {
      return next();
    }
    
    const isWhitelisted = LINE_WEBHOOK_IPS.some(range => 
      isIPInRange(clientIP, range)
    );
    
    if (!isWhitelisted) {
      Logger.warn(`⚠️ Request from non-whitelisted IP: ${clientIP}`);
    }
    
    next();
  } catch (error) {
    Logger.error('IP whitelist middleware error', error);
    next();
  }
}

// ============================================================================
// COMBINED SECURITY MIDDLEWARE
// ============================================================================

function fullSecurityMiddleware(req, res, next) {
  validateWebhookRequest(req, res, (err) => {
    if (err) return next(err);
    
    verifyLineSignature(req, res, (err) => {
      if (err) return next(err);
      
      rateLimitMiddleware(req, res, (err) => {
        if (err) return next(err);
        
        ipWhitelistMiddleware(req, res, next);
      });
    });
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  verifyLineSignature,
  rateLimitMiddleware,
  validateWebhookRequest,
  ipWhitelistMiddleware,
  fullSecurityMiddleware,
  RateLimiter,
  webhookLimiter, // ✅ Export for monitoring
  userLimiter     // ✅ Export for monitoring
};
