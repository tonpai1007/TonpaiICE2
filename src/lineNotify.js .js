// lineNotify.js - Admin notification via LINE Notify
const axios = require('axios');
const { configManager } = require('./config');
const { Logger } = require('./logger');

async function sendLineNotify(message) {
  const token = configManager.get('LINE_NOTIFY_TOKEN');
  
  if (!token) {
    Logger.warn('⚠️ LINE_NOTIFY_TOKEN not configured');
    return false;
  }

  try {
    await axios.post('https://notify-api.line.me/api/notify', 
      `message=${encodeURIComponent(message)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Bearer ${token}`
        }
      }
    );

    Logger.success('✅ LINE Notify sent');
    return true;
  } catch (error) {
    Logger.error('LINE Notify failed', error);
    return false;
  }
}

module.exports = { sendLineNotify };