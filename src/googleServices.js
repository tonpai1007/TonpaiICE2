// src/googleServices.js
const { google } = require('googleapis');
const { loadGoogleCredentials } = require('./config');
const { Logger } = require('./logger');

let auth = null;
let sheets = null;
let drive = null;

// ============================================================================
// RATE LIMITER (THE FIX)
// ============================================================================

class RequestQueue {
  constructor(delayMs = 500) {
    this.queue = [];
    this.isProcessing = false;
    this.delayMs = delayMs;
  }

  add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.isProcessing) return;
    if (this.queue.length === 0) return;

    this.isProcessing = true;
    const { fn, resolve, reject } = this.queue.shift();

    try {
      const result = await fn();
      resolve(result);
    } catch (error) {
      reject(error);
    }

    // Wait before processing next item
    setTimeout(() => {
      this.isProcessing = false;
      this.process();
    }, this.delayMs);
  }
}

// Global queue instance
const apiQueue = new RequestQueue(600); // 600ms buffer between write requests

// ============================================================================
// INITIALIZATION
// ============================================================================

function initializeGoogleServices() {
  try {
    const credentials = loadGoogleCredentials();
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
    });
    sheets = google.sheets({ version: 'v4', auth });
    drive = google.drive({ version: 'v3', auth });
    Logger.success('Google services initialized');
    return { sheets, drive };
  } catch (error) {
    Logger.error('Failed to initialize Google services', error);
    throw error;
  }
}

// ============================================================================
// SHEETS OPERATIONS (WRAPPED IN QUEUE)
// ============================================================================

async function getSheetData(spreadsheetId, range) {
  // Reads are usually fine, but we can queue them if needed. 
  // For now, let's keep reads direct for speed, unless you hit quotas.
  try {
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return response.data.values || [];
  } catch (error) {
    Logger.error(`Failed to get sheet data: ${range}`, error);
    throw error;
  }
}

async function appendSheetData(spreadsheetId, range, values) {
  return apiQueue.add(async () => {
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values }
      });
      Logger.success(`Appended data to ${range}`);
    } catch (error) {
      Logger.error(`Failed to append to ${range}`, error);
      throw error;
    }
  });
}

async function updateSheetData(spreadsheetId, range, values) {
  return apiQueue.add(async () => {
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values }
      });
      Logger.success(`Updated ${range}`);
    } catch (error) {
      Logger.error(`Failed to update ${range}`, error);
      throw error;
    }
  });
}

async function batchUpdateSheet(spreadsheetId, data) {
  return apiQueue.add(async () => {
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'USER_ENTERED', data }
      });
      Logger.success(`Batch updated ${data.length} ranges`);
    } catch (error) {
      Logger.error('Batch update failed', error);
      throw error;
    }
  });
}

async function createSheet(spreadsheetId, sheetName) {
  return apiQueue.add(async () => {
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] }
      });
      Logger.success(`Created sheet: ${sheetName}`);
    } catch (error) {
      Logger.error(`Failed to create sheet: ${sheetName}`, error);
      throw error;
    }
  });
}

async function getSheetsList(spreadsheetId) {
  try {
    const response = await sheets.spreadsheets.get({ spreadsheetId });
    return response.data.sheets.map(s => s.properties.title);
  } catch (error) {
    Logger.error('Failed to get sheets list', error);
    throw error;
  }
}

module.exports = {
  initializeGoogleServices,
  getSheets: () => sheets,
  getDrive: () => drive,
  getSheetData,
  appendSheetData,
  updateSheetData,
  batchUpdateSheet,
  createSheet,
  getSheetsList
};
