// googleServices.js - Google Sheets and Drive API integration

const { google } = require('googleapis');
const { loadGoogleCredentials } = require('./config');
const { Logger } = require('./logger');

let auth = null;
let sheets = null;
let drive = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

function initializeGoogleServices() {
  try {
    const credentials = loadGoogleCredentials();
    
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
      ]
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
// SHEETS OPERATIONS
// ============================================================================

async function getSheetData(spreadsheetId, range) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range
    });
    return response.data.values || [];
  } catch (error) {
    Logger.error(`Failed to get sheet data: ${range}`, error);
    throw error;
  }
}

async function appendSheetData(spreadsheetId, range, values) {
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
}

async function updateSheetData(spreadsheetId, range, values) {
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
}

async function batchUpdateSheet(spreadsheetId, data) {
  try {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data
      }
    });
    Logger.success(`Batch updated ${data.length} ranges`);
  } catch (error) {
    Logger.error('Batch update failed', error);
    throw error;
  }
}

async function createSheet(spreadsheetId, sheetName) {
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: { title: sheetName }
          }
        }]
      }
    });
    Logger.success(`Created sheet: ${sheetName}`);
  } catch (error) {
    Logger.error(`Failed to create sheet: ${sheetName}`, error);
    throw error;
  }
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

// ============================================================================
// EXPORTS
// ============================================================================

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
