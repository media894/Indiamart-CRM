const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

let client = null;
let qrCodeData = null;
let status = 'DISCONNECTED'; // DISCONNECTED, SCAN_REQUIRED, CONNECTED, CONNECTING

function initializeWhatsApp() {
  console.log('[WhatsApp] Initializing...');
  status = 'CONNECTING';

  // If there's an existing client, try to destroy it first to avoid memory leaks/multiple instances
  if (client) {
    try {
      client.destroy();
    } catch (e) {}
    client = null;
  }

  // Use a local folder in the workspace to persist sessions
  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(__dirname, '../.wwebjs_auth')
    }),
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html'
    },
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  client.on('qr', async (qr) => {
    console.log('[WhatsApp] QR Code received.');
    status = 'SCAN_REQUIRED';
    try {
      // Generate base64 QR code image
      qrCodeData = await qrcode.toDataURL(qr);
    } catch (err) {
      console.error('[WhatsApp] Failed to generate QR data URL:', err);
    }
  });

  client.on('ready', () => {
    console.log('[WhatsApp] Client is ready!');
    status = 'CONNECTED';
    qrCodeData = null;
  });

  client.on('authenticated', () => {
    console.log('[WhatsApp] Authenticated successfully!');
    status = 'CONNECTED';
    qrCodeData = null;
  });

  client.on('auth_failure', (msg) => {
    console.error('[WhatsApp] Authentication failure:', msg);
    status = 'DISCONNECTED';
    qrCodeData = null;
  });

  client.on('disconnected', (reason) => {
    console.log('[WhatsApp] Client was logged out:', reason);
    status = 'DISCONNECTED';
    qrCodeData = null;
    try {
      client.destroy();
    } catch (e) {}
    // Re-initialize after a delay
    setTimeout(() => initializeWhatsApp(), 5000);
  });

  try {
    client.initialize().catch(err => {
      console.error('[WhatsApp] Client initialization promise rejected:', err);
      status = 'DISCONNECTED';
      // Auto-retry in 30 seconds
      setTimeout(() => {
        if (status === 'DISCONNECTED') {
          console.log('[WhatsApp] Retrying client initialization...');
          initializeWhatsApp();
        }
      }, 30000);
    });
  } catch (err) {
    console.error('[WhatsApp] Init error:', err);
    status = 'DISCONNECTED';
    // Auto-retry in 30 seconds
    setTimeout(() => {
      if (status === 'DISCONNECTED') {
        console.log('[WhatsApp] Retrying client initialization after throw...');
        initializeWhatsApp();
      }
    }, 30000);
  }
}

function getWhatsAppStatus() {
  return { status, qrCodeData };
}

async function disconnectWhatsApp() {
  if (client) {
    try {
      await client.logout();
      await client.destroy();
      console.log('[WhatsApp] Client logged out and destroyed.');
    } catch (err) {
      console.error('[WhatsApp] Error logging out:', err);
    }
    status = 'DISCONNECTED';
    qrCodeData = null;
    // Re-initialize to get a new QR code for scanning
    setTimeout(() => initializeWhatsApp(), 2000);
  }
}

async function handleCriticalFailure() {
  if (status === 'DISCONNECTED') return; // Avoid duplicate failure handling
  console.error('[WhatsApp] Critical browser crash or detachment detected. Destroying client and scheduled to reinitialize...');
  status = 'DISCONNECTED';
  qrCodeData = null;
  if (client) {
    try {
      await client.destroy();
    } catch (e) {
      console.error('[WhatsApp] Error destroying client on critical failure:', e.message);
    }
    client = null;
  }
  // Re-initialize after a short delay
  setTimeout(() => initializeWhatsApp(), 5000);
}

async function sendWhatsAppMessage(toPhone, messageText) {
  if (status !== 'CONNECTED' || !client) {
    throw new Error('WhatsApp client is not connected. Please scan the QR code first.');
  }

  // Format phone number to WhatsApp format (e.g. 919999999999)
  let cleanNumber = String(toPhone).replace(/\D/g, '');
  if (!cleanNumber.startsWith('91') && cleanNumber.length === 10) {
    cleanNumber = '91' + cleanNumber;
  }
  
  if (cleanNumber.length < 10) {
    throw new Error('Invalid phone number for WhatsApp message.');
  }

  const chatId = cleanNumber + '@c.us';

  // Check if number is registered on WhatsApp first to avoid internal getChat crash
  try {
    const isRegistered = await client.isRegisteredUser(chatId);
    if (!isRegistered) {
      throw new Error('This phone number is not registered on WhatsApp.');
    }
  } catch (e) {
    if (e.message.includes('not registered')) {
      throw e;
    }
    console.warn('[WhatsApp] Registration check failed or skipped:', e.message);
  }

  try {
    const response = await client.sendMessage(chatId, messageText);
    return response;
  } catch (err) {
    const errMsg = err.message || '';
    if (
      errMsg.includes('detached Frame') || 
      errMsg.includes('Protocol error') || 
      errMsg.includes('Execution context') || 
      errMsg.includes('Session closed') ||
      errMsg.includes('Target closed')
    ) {
      handleCriticalFailure().catch(e => console.error('[WhatsApp] Error handling critical failure:', e.message));
    }
    throw err;
  }
}

async function reconnectWhatsApp(clearSession = true) {
  console.log(`[WhatsApp] Force reconnecting. Clear session: ${clearSession}`);
  status = 'DISCONNECTED';
  qrCodeData = null;

  if (client) {
    try {
      await client.destroy();
    } catch (e) {
      console.error('[WhatsApp] Error destroying client on reconnect:', e.message);
    }
    client = null;
  }

  if (clearSession) {
    const sessionPath = path.join(__dirname, '../.wwebjs_auth');
    try {
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log('[WhatsApp] Deleted session auth folder successfully.');
      }
    } catch (err) {
      console.error('[WhatsApp] Failed to delete session auth folder:', err.message);
    }
  }

  // Restart client initialization after a short delay
  setTimeout(() => initializeWhatsApp(), 1000);
>>>>>>> 3122eae (Add WhatsApp PDF portfolio auto-send feature)
}

async function reconnectWhatsApp(clearSession = true) {
  console.log(`[WhatsApp] Force reconnecting. Clear session: ${clearSession}`);
  status = 'DISCONNECTED';
  qrCodeData = null;

  if (client) {
    try {
      await client.destroy();
    } catch (e) {
      console.error('[WhatsApp] Error destroying client on reconnect:', e.message);
    }
    client = null;
  }

  if (clearSession) {
    const sessionPath = path.join(__dirname, '../.wwebjs_auth');
    try {
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log('[WhatsApp] Deleted session auth folder successfully.');
      }
    } catch (err) {
      console.error('[WhatsApp] Failed to delete session auth folder:', err.message);
    }
  }

  // Restart client initialization after a short delay
  setTimeout(() => initializeWhatsApp(), 1000);
}

module.exports = {
  initializeWhatsApp,
  getWhatsAppStatus,
  disconnectWhatsApp,
  sendWhatsAppMessage,
  sendWhatsAppMedia,
  reconnectWhatsApp
};
