// src/middleware/webhook-security.js
const crypto = require('crypto');
const { CONFIG } = require('../config');
const { Logger } = require('../logger');

function verifyLineSignature(req, res, next) {
  const signature = req.headers['x-line-signature'];
  const channelSecret = CONFIG.LINE_SECRET;

  if (!signature) {
    Logger.error('❌ Missing x-line-signature header');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac('SHA256', channelSecret)
    .update(body)
    .digest('base64');

  if (signature !== expectedSignature) {
    Logger.error('❌ Invalid signature');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  Logger.info('✅ Signature verified');
  next();
}

function basicRateLimit(req, res, next) {
  // Simple rate limit - you can skip this if you want
  next();
}

module.exports = { verifyLineSignature, basicRateLimit };