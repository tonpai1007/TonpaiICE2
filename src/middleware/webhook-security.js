// src/middleware/webhook-security.js - FIXED: Complete security implementation
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
      Logger.warn(`Expected: ${expectedSignature.substring(0, 10)}...`);
      Logger.warn(`Received: ${signature.substring(0, 10)}...`);
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
// RATE LIMITING - IN-MEMORY IMPLEMENTATION
// ============================================================================

class RateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60000; // 1 minute
    this.maxRequests = options.maxRequests || 100;
    this.requests = new Map();
    
    // Cleanup old entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  check(identifier) {
    const now = Date.now();
    const key = identifier;
    
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
    for (const [key, timestamps] of this.requests.entries()) {
      const validTimestamps = timestamps.filter(t => now - t < this.windowMs);
      if (validTimestamps.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, validTimestamps);
      }
    }
    Logger.debug(`Rate limiter cleanup: ${this.requests.size} active keys`);
  }
}

// Global rate limiter instance
const webhookLimiter = new RateLimiter({
  windowMs: 60000,      // 1 minute
  maxRequests: 300      // 300 requests per minute (LINE's webhook rate)
});

const userLimiter = new RateLimiter({
  windowMs: 60000,      // 1 minute  
  maxRequests: 20       // 20 requests per user per minute (prevent spam)
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
    
    // Check per-user rate limit (if userId available)
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
    // Don't block on rate limiter errors
    next();
  }
}

// ============================================================================
// REQUEST VALIDATION
// ============================================================================

function validateWebhookRequest(req, res, next) {
  try {
    // Validate request body structure
    if (!req.body || typeof req.body !== 'object') {
      Logger.error('Invalid request body: not an object');
      return res.status(400).json({ error: 'Bad Request: Invalid body' });
    }
    
    // Validate events array
    if (!Array.isArray(req.body.events)) {
      Logger.error('Invalid request body: events is not an array');
      return res.status(400).json({ error: 'Bad Request: Invalid events' });
    }
    
    // Validate destination (bot userId)
    if (!req.body.destination || typeof req.body.destination !== 'string') {
      Logger.warn('Missing or invalid destination field');
      // Don't block - some webhooks might not have this
    }
    
    next();
  } catch (error) {
    Logger.error('Request validation error', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================================
// IP WHITELIST (OPTIONAL - LINE webhook IPs)
// ============================================================================

const LINE_WEBHOOK_IPS = [
  '147.92.128.0/17',  // LINE webhook IP range
  '127.0.0.1',        // Localhost for testing
  '::1'               // IPv6 localhost
];

function isIPInRange(ip, cidr) {
  if (cidr === ip) return true; // Exact match
  
  if (!cidr.includes('/')) return false;
  
  // Simple CIDR check (for production, use 'ip-range-check' or 'ipaddr.js')
  const [range, bits] = cidr.split('/');
  // Simplified - in production use proper CIDR library
  return ip.startsWith(range.split('.').slice(0, 2).join('.'));
}

function ipWhitelistMiddleware(req, res, next) {
  try {
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
                     req.socket.remoteAddress ||
                     req.connection.remoteAddress;
    
    Logger.debug(`Request from IP: ${clientIP}`);
    
    // Skip in development
    if (process.env.NODE_ENV !== 'production') {
      return next();
    }
    
    // Check if IP is whitelisted
    const isWhitelisted = LINE_WEBHOOK_IPS.some(range => 
      isIPInRange(clientIP, range)
    );
    
    if (!isWhitelisted) {
      Logger.warn(`⚠️ Request from non-whitelisted IP: ${clientIP}`);
      // Log but don't block - LINE IPs might change
      // In strict mode, you could return 403 here
    }
    
    next();
  } catch (error) {
    Logger.error('IP whitelist middleware error', error);
    // Don't block on errors
    next();
  }
}

// ============================================================================
// COMBINED SECURITY MIDDLEWARE
// ============================================================================

function fullSecurityMiddleware(req, res, next) {
  // Chain all security checks
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
  RateLimiter
};
