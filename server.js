const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_DIR = path.join(__dirname, 'session');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

let sock = null;
let currentQrRaw = null;
let currentQrDataUrl = null;
let connectionStatus = 'initializing'; // initializing | scanning | connected | disconnected
let connectedUser = null;
let lastError = null;
let isConnecting = false;
let reconnectTimer = null;

// Ensure session directory exists
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Phone Number Normalizer for Sri Lanka & International
function normalizePhoneNumber(input) {
  if (!input) return '';
  let cleaned = String(input).replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '94' + cleaned.substring(1);
  } else if (cleaned.length === 9 && cleaned.startsWith('7')) {
    cleaned = '94' + cleaned;
  }
  return cleaned;
}

function scheduleReconnect(delayMs = 3000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connectToWhatsApp();
  }, delayMs);
}

// Connect & Manage Baileys WhatsApp Socket
async function connectToWhatsApp() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (isConnecting) return;
  isConnecting = true;

  try {
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end(undefined);
      } catch (e) {}
      sock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`\n==================================================`);
    console.log(`🐠 KULATHOOR FISH FARM - LOCAL WHATSAPP GATEWAY`);
    console.log(`🚀 Baileys Engine Version: ${version.join('.')} (Latest: ${isLatest})`);
    console.log(`==================================================\n`);

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['Kulathoor Fish Farm', 'Chrome', '124.0.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
      generateHighQualityLinkPreview: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQrRaw = qr;
        connectionStatus = 'scanning';
        try {
          currentQrDataUrl = await qrcode.toDataURL(qr, {
            width: 300,
            margin: 2,
            color: { dark: '#0f172a', light: '#ffffff' }
          });
        } catch (qrErr) {
          console.error('Failed to create QR Data URL:', qrErr);
        }

        console.log(`📲 [QR Ready] Scan at: http://localhost:${PORT}/qr`);
      }

      if (connection === 'close') {
        isConnecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        connectionStatus = 'disconnected';
        currentQrRaw = null;
        currentQrDataUrl = null;
        connectedUser = null;
        lastError = lastDisconnect?.error?.message || 'Connection closed';

        console.log(`⚠️ WhatsApp connection closed (Status: ${statusCode || 'unknown'}).`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('❌ Device logged out. Deleting old session...');
          try {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
            fs.mkdirSync(SESSION_DIR, { recursive: true });
          } catch (e) {}
          scheduleReconnect(3000);
        } else if (shouldReconnect) {
          console.log('🔄 Reconnecting to WhatsApp in 3 seconds...');
          scheduleReconnect(3000);
        }
      } else if (connection === 'open') {
        isConnecting = false;
        connectionStatus = 'connected';
        currentQrRaw = null;
        currentQrDataUrl = null;
        lastError = null;
        const jid = sock.user?.id || '';
        const phone = jid.split(':')[0] || jid.split('@')[0];
        connectedUser = {
          name: sock.user?.name || 'Farm Phone',
          phone: phone,
          jid: jid
        };

        console.log(`\n✅ WHATSAPP CONNECTED & READY!`);
        console.log(`📱 Linked Phone: +${phone}`);
        console.log(`🌐 Gateway REST API: http://localhost:${PORT}/send\n`);
      }
    });

  } catch (err) {
    isConnecting = false;
    console.error('Error in connectToWhatsApp:', err);
    connectionStatus = 'disconnected';
    lastError = err.message;
    scheduleReconnect(5000);
  }
}

// ==========================================
// REST API ENDPOINTS
// ==========================================

// 1. Health & Status (Pure Inspector, No Side Effects)
app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    connected: connectionStatus === 'connected',
    user: connectedUser,
    error: lastError,
    qr: currentQrDataUrl,
    timestamp: new Date().toISOString()
  });
});

// 2. Explicit Reconnect
app.get('/reconnect', (req, res) => {
  scheduleReconnect(100);
  res.redirect('/qr');
});

// 3. Visual Web Dashboard & QR Scanner
app.get(['/', '/qr'], (req, res) => {
  const isConnected = (connectionStatus === 'connected');
  const isScanning = (connectionStatus === 'scanning' && currentQrDataUrl);

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Kulathoor Fish Farm • WhatsApp Gateway</title>
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
      <style>
        body { background: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1e293b; }
        .gateway-card { max-width: 580px; margin: 40px auto; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; background: #ffffff; }
        .qr-box { width: 300px; height: 300px; margin: 0 auto; display: flex; align-items: center; justify-content: center; background: #f1f5f9; border-radius: 16px; border: 2px dashed #cbd5e1; position: relative; }
        .qr-box img { width: 280px; height: 280px; display: block; border-radius: 10px; }
      </style>
    </head>
    <body>
      <div class="container py-4">
        <div class="gateway-card p-4 p-md-5">
          <div class="text-center mb-4">
            <span class="d-inline-flex align-items-center justify-content-center bg-success bg-opacity-10 text-success rounded-circle shadow-sm mb-2" style="width: 64px; height: 64px; font-size: 2rem;">
              <i class="fab fa-whatsapp"></i>
            </span>
            <h4 class="fw-bold mb-1">Local WhatsApp Automation Gateway</h4>
            <p class="text-muted small mb-0">Kulathoor Fish Farm • Direct Self-Hosted Engine</p>
          </div>

          <div id="statusContainer" class="mb-4">
            ${isConnected ? `
              <div class="alert alert-success border-0 rounded-4 p-4 text-center">
                <i class="fas fa-circle-check fa-3x mb-2 text-success"></i>
                <h5 class="fw-bold text-success mb-1">Connected &amp; Ready!</h5>
                <p class="small text-muted mb-2">WhatsApp session is live. Automated messages will dispatch instantly.</p>
                <div class="badge bg-white text-dark border px-3 py-2 font-monospace fs-6">
                  <i class="fas fa-phone me-1 text-primary"></i> +${connectedUser?.phone || 'Connected'}
                </div>
              </div>
            ` : isScanning ? `
              <div class="text-center">
                <div class="alert alert-info py-2 px-3 small rounded-pill mb-3 d-inline-block">
                  <i class="fas fa-qrcode me-1"></i> Open WhatsApp ➡️ Linked Devices ➡️ Link a Device ➡️ Scan QR
                </div>
                <div class="qr-box mb-3">
                  <img id="qrImg" src="${currentQrDataUrl}" alt="Scan QR Code">
                </div>
                <small class="text-muted d-block">QR Code refreshes automatically when scanned or expired.</small>
              </div>
            ` : `
              <div class="alert alert-warning border-0 rounded-4 p-4 text-center">
                <div class="spinner-border text-warning mb-2" role="status"></div>
                <h5 class="fw-bold text-dark mb-1">Initializing WhatsApp Socket...</h5>
                <p class="small text-muted mb-0">Starting connection with WhatsApp network. Please wait...</p>
              </div>
            `}
          </div>

          <!-- Quick Test Message Form -->
          <div class="p-3 bg-light rounded-3 border">
            <h6 class="fw-bold text-dark mb-2 small text-uppercase">
              <i class="fas fa-paper-plane text-primary me-1"></i> Send Quick Test Message
            </h6>
            <form onsubmit="handleSendTest(event)">
              <div class="mb-2">
                <input type="text" id="testPhone" class="form-control form-control-sm font-monospace" placeholder="Phone (e.g. 0772012205 or 94772012205)" required>
              </div>
              <div class="mb-2">
                <textarea id="testMsg" class="form-control form-control-sm" rows="2" placeholder="Message content..." required>🐠 Test message from Kulathoor Fish Farm Local Gateway! ✅</textarea>
              </div>
              <button type="submit" id="btnSendTest" class="btn btn-sm btn-primary rounded-pill px-3 fw-bold w-100" ${!isConnected ? 'disabled' : ''}>
                <i class="fas fa-paper-plane me-1"></i> Send Test Message
              </button>
            </form>
            <div id="testResult" class="mt-2 small d-none"></div>
          </div>

          <!-- Footer Info -->
          <div class="mt-4 pt-3 border-top text-center text-muted small d-flex justify-content-between align-items-center">
            <span>REST API: <code class="text-primary">POST /send</code></span>
            <span>Port: <strong class="text-dark">3000</strong></span>
            <a href="/reconnect" class="btn btn-sm btn-outline-secondary py-0 px-2 rounded-pill" style="font-size: 0.75rem;">
              <i class="fas fa-arrows-rotate me-1"></i> Reload Socket
            </a>
          </div>
        </div>
      </div>

      <script>
        // Smooth polling to update QR image or switch to connected state without flickering
        let lastConnected = ${isConnected ? 'true' : 'false'};

        setInterval(async () => {
          try {
            const res = await fetch('/status');
            const data = await res.json();

            if (data.connected !== lastConnected) {
              window.location.reload();
              return;
            }

            const imgEl = document.getElementById('qrImg');
            if (imgEl && data.qr && imgEl.src !== data.qr) {
              imgEl.src = data.qr;
            }
          } catch (e) {}
        }, 2500);

        async function handleSendTest(e) {
          e.preventDefault();
          const phone = document.getElementById('testPhone').value.trim();
          const message = document.getElementById('testMsg').value.trim();
          const resBox = document.getElementById('testResult');
          const btn = document.getElementById('btnSendTest');

          btn.disabled = true;
          btn.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i> Sending...';
          resBox.className = 'mt-2 small d-none';

          try {
            const res = await fetch('/send', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ to: phone, message: message })
            });
            const data = await res.json();
            resBox.classList.remove('d-none');
            if (res.ok && data.success) {
              resBox.className = 'mt-2 small alert alert-success py-1.5 px-2.5 rounded-3 mb-0';
              resBox.innerHTML = '<i class="fas fa-check-circle me-1"></i> Message sent successfully to +' + data.to;
            } else {
              resBox.className = 'mt-2 small alert alert-danger py-1.5 px-2.5 rounded-3 mb-0';
              resBox.innerHTML = '<i class="fas fa-exclamation-circle me-1"></i> Failed: ' + (data.error || 'Unknown error');
            }
          } catch (err) {
            resBox.className = 'mt-2 small alert alert-danger py-1.5 px-2.5 rounded-3 mb-0';
            resBox.innerHTML = '<i class="fas fa-exclamation-circle me-1"></i> Error: ' + err.message;
          } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-paper-plane me-1"></i> Send Test Message';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// 4. Send Message API Endpoint (Accepts { to, message } or { phone, message })
app.post(['/send', '/send-message'], async (req, res) => {
  try {
    const rawTo = req.body.to || req.body.phone || req.body.chatId;
    const message = req.body.message || req.body.body || req.body.text;

    if (!rawTo || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: "to" (phone number) and "message"'
      });
    }

    if (!sock || connectionStatus !== 'connected') {
      return res.status(503).json({
        success: false,
        error: `WhatsApp is not connected (Current status: ${connectionStatus}). Please scan QR code at http://localhost:${PORT}/qr`
      });
    }

    const cleanPhone = normalizePhoneNumber(rawTo);
    if (!cleanPhone || cleanPhone.length < 8) {
      return res.status(400).json({
        success: false,
        error: `Invalid phone number: ${rawTo}`
      });
    }

    const jid = `${cleanPhone}@s.whatsapp.net`;
    const result = await sock.sendMessage(jid, { text: String(message) });

    console.log(`📤 [SENT] To: +${cleanPhone} | ID: ${result.key.id}`);

    return res.json({
      success: true,
      message: 'WhatsApp message dispatched successfully via local gateway',
      messageId: result.key.id,
      to: cleanPhone,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('Send message error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to send WhatsApp message'
    });
  }
});

// 5. Logout / Disconnect Endpoint
app.post(['/logout', '/disconnect'], async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    connectionStatus = 'disconnected';
    connectedUser = null;
    scheduleReconnect(2000);
    return res.json({ success: true, message: 'Logged out successfully. Re-authenticating...' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Start Express Server & Connect to Baileys
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 WhatsApp Gateway Server listening on http://localhost:${PORT}`);
  console.log(`==================================================`);
  connectToWhatsApp();
});
