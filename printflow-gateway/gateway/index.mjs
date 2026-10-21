import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  jidNormalizedUser
} from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import QRCode from 'qrcode';
import pino from 'pino';

const INGRESS_BASE_DIR = process.env.INGRESS_DIR || path.resolve('../storage/ingress');
const FASTAPI_ENDPOINT = process.env.API_ENDPOINT || 'http://127.0.0.1:8000/api/v1/queue/inbound-document';
const FASTAPI_QR_ENDPOINT = process.env.QR_ENDPOINT || 'http://127.0.0.1:8000/api/v1/gateway/qr-state';
const AUTH_FOLDER = path.resolve('auth_info_baileys');

// Allowed document & image types for counter printing
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword' // .doc
]);

function extractPhoneNumber(msg) {
  const key = msg.key || {};
  const candidates = [key.participant, key.remoteJidAlt, key.remoteJid];

  for (const jid of candidates) {
    if (!jid) continue;
    const cleanJid = jidNormalizedUser(jid);
    if (cleanJid.includes('@s.whatsapp.net')) {
      const digits = cleanJid.split('@')[0].replace(/[^0-9]/g, '');
      if (digits.startsWith('91') && digits.length === 12) {
        return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
      }
      if (digits.length >= 10) {
        return `+${digits}`;
      }
    }
  }

  if (msg.pushName) return msg.pushName;
  const raw = (key.remoteJid || '').replace(/[^0-9]/g, '');
  return `Customer ${raw.slice(-4)}`;
}

function unwrapMediaMessage(rawMessage) {
  if (!rawMessage) return { type: null, media: null, rootMsg: null };
  let m = rawMessage;

  while (
    m.ephemeralMessage ||
    m.viewOnceMessage ||
    m.viewOnceMessageV2 ||
    m.viewOnceMessageV2Extension ||
    m.documentWithCaptionMessage
  ) {
    m = (
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.viewOnceMessageV2Extension?.message ||
      m.documentWithCaptionMessage?.message ||
      m
    );
  }

  if (m.documentMessage) return { type: 'documentMessage', media: m.documentMessage, rootMsg: m };
  if (m.imageMessage) return { type: 'imageMessage', media: m.imageMessage, rootMsg: m };
  return { type: null, media: null, rootMsg: null };
}

async function startWhatsAppGateway() {
  if (!fs.existsSync(INGRESS_BASE_DIR)) {
    fs.mkdirSync(INGRESS_BASE_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    logger: pino({ level: 'error' }),
    browser: ['PrintFlow Counter POS', 'Chrome', '1.0.0'],
    keepAliveIntervalMs: 25000,
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 60000
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Relay fresh QR code as a base64 image data URL to FastAPI
    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, {
          margin: 1,
          scale: 8,
          color: { dark: '#000000', light: '#FFFFFF' }
        });
        await axios.post(FASTAPI_QR_ENDPOINT, {
          status: 'SCAN_REQUIRED',
          qr_image: qrDataUrl
        });
        console.log('[GATEWAY] Fresh pairing QR code dispatched to web UI.');
      } catch (err) {
        console.error('[GATEWAY] Failed to relay QR data:', err.message);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isExplicitLogout = statusCode === DisconnectReason.loggedOut;

      // Broadcast disconnected state to the browser
      axios.post(FASTAPI_QR_ENDPOINT, {
        status: isExplicitLogout ? 'LOGGED_OUT' : 'DISCONNECTED',
        qr_image: null
      }).catch(() => {});

      if (!isExplicitLogout) {
        setTimeout(startWhatsAppGateway, 3000);
      } else {
        if (fs.existsSync(AUTH_FOLDER)) {
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        }
        setTimeout(startWhatsAppGateway, 1000);
      }
    } else if (connection === 'open') {
      console.log('[GATEWAY] Connected to WhatsApp Web socket.');
      // Notify web browser that the pairing succeeded
      axios.post(FASTAPI_QR_ENDPOINT, {
        status: 'CONNECTED',
        qr_image: null
      }).catch(() => {});
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!['notify', 'append'].includes(type)) return;

    for (const msg of messages) {
      if (!msg.message || msg.key?.fromMe) continue;

      const senderJid = msg.key?.remoteJid || '';

      // 1. FILTER: Ignore WhatsApp Status / Stories updates completely
      if (senderJid === 'status@broadcast' || senderJid.includes('broadcast')) {
        continue;
      }

      // 2. FILTER: Ignore group chats (only process direct 1-to-1 customer messages)
      if (senderJid.endsWith('@g.us')) {
        continue;
      }

      const { type: mediaType, media, rootMsg } = unwrapMediaMessage(msg.message);
      if (!mediaType || !media) continue;

      // 3. FILTER: Check MIME type against allowed list
      const rawMime = (media.mimetype || '').split(';')[0].toLowerCase();
      const detectedMime = rawMime || (mediaType === 'imageMessage' ? 'image/jpeg' : 'application/pdf');

      if (!ALLOWED_MIME_TYPES.has(detectedMime)) {
        console.log(`[GATEWAY] Skipping unsupported media type: ${detectedMime}`);
        continue;
      }

      const customerPhone = extractPhoneNumber(msg);

      try {
        const buffer = await downloadMediaMessage(
          { ...msg, message: rootMsg },
          'buffer',
          {},
          { reuploadRequest: sock.updateMediaMessage }
        );

        if (!buffer || buffer.length === 0) continue;

        let extension = '.bin';
        let originalFilename = `${msg.key.id}`;

        if (mediaType === 'imageMessage') {
          extension = '.jpg';
          originalFilename = `${msg.key.id}.jpg`;
        } else if (mediaType === 'documentMessage') {
          originalFilename = media.fileName || `${msg.key.id}.pdf`;
          extension = path.extname(originalFilename) || '.pdf';
        }

        const safeFolder = customerPhone.replace(/[^a-zA-Z0-9]/g, '_');
        const customerDir = path.join(INGRESS_BASE_DIR, safeFolder);
        if (!fs.existsSync(customerDir)) {
          fs.mkdirSync(customerDir, { recursive: true });
        }

        const destinationPath = path.join(customerDir, `${Date.now()}_${originalFilename}`);
        fs.writeFileSync(destinationPath, buffer);

        console.log(`[GATEWAY] Ingested print file: "${originalFilename}" from ${customerPhone}`);

        await axios.post(FASTAPI_ENDPOINT, {
          customer_phone: customerPhone,
          message_id: msg.key.id,
          file_path: destinationPath,
          original_filename: originalFilename,
          mime_type: detectedMime,
          file_size: buffer.length,
          timestamp: Date.now() / 1000
        }, { timeout: 10000 });

      } catch (err) {
        console.error(`[GATEWAY] Error processing msg ${msg.key.id}:`, err.message);
      }
    }
  });
}

startWhatsAppGateway();