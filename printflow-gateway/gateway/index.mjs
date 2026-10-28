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
import express from 'express';
import cors from 'cors';

const INGRESS_BASE_DIR = process.env.INGRESS_DIR || path.resolve('../storage/ingress');
const FASTAPI_ENDPOINT = process.env.API_ENDPOINT || 'http://127.0.0.1:8000/api/v1/queue/inbound-document';
const FASTAPI_QR_ENDPOINT = process.env.QR_ENDPOINT || 'http://127.0.0.1:8000/api/v1/gateway/qr-state';
const AUTH_BASE_DIR = path.resolve('auth_info_baileys');
const GATEWAY_PORT = process.env.GATEWAY_PORT || 3001;

// Allowlist for PDFs, Images, Word, PowerPoint, and Excel
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.text',
  // Excel & Spreadsheet formats
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/csv'
]);

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff',
  '.doc', '.docx', '.odt', '.rtf', '.txt',
  '.ppt', '.pptx', '.odp', '.pps', '.ppsx',
  '.xls', '.xlsx', '.ods', '.csv'
]);

const activeSockets = new Map();

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

async function getOrInitSocket(shopId = 'default') {
  if (activeSockets.has(shopId)) {
    return activeSockets.get(shopId);
  }

  const shopAuthFolder = path.join(AUTH_BASE_DIR, shopId);
  if (!fs.existsSync(shopAuthFolder)) {
    fs.mkdirSync(shopAuthFolder, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(shopAuthFolder);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    logger: pino({ level: 'error' }),
    browser: ['PrintFlow POS', 'Desktop', '1.0.0'],
    keepAliveIntervalMs: 25000,
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 60000
  });

  activeSockets.set(shopId, sock);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, {
          margin: 1,
          scale: 8,
          color: { dark: '#000000', light: '#FFFFFF' }
        });
        await axios.post(FASTAPI_QR_ENDPOINT, {
          shop_id: shopId,
          status: 'SCAN_REQUIRED',
          qr_image: qrDataUrl
        });
        console.log(`[GATEWAY:${shopId}] Dispatched pairing QR code.`);
      } catch (err) {
        console.error(`[GATEWAY:${shopId}] Failed to relay QR data:`, err.message);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isExplicitLogout = statusCode === DisconnectReason.loggedOut;

      activeSockets.delete(shopId);

      axios.post(FASTAPI_QR_ENDPOINT, {
        shop_id: shopId,
        status: isExplicitLogout ? 'LOGGED_OUT' : 'DISCONNECTED',
        qr_image: null
      }).catch(() => {});

      if (!isExplicitLogout) {
        console.log(`[GATEWAY:${shopId}] Socket disconnected. Reconnecting in 3s...`);
        setTimeout(() => getOrInitSocket(shopId), 3000);
      } else {
        console.log(`[GATEWAY:${shopId}] Cleaned up session after logout.`);
      }
    } else if (connection === 'open') {
      console.log(`[GATEWAY:${shopId}] Connected to WhatsApp Web.`);
      axios.post(FASTAPI_QR_ENDPOINT, {
        shop_id: shopId,
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

      if (senderJid === 'status@broadcast' || senderJid.includes('broadcast') || senderJid.endsWith('@g.us')) {
        continue;
      }

      const msgTimestamp = Number(msg.messageTimestamp || 0);
      const nowTimestamp = Math.floor(Date.now() / 1000);
      if (msgTimestamp > 0 && nowTimestamp - msgTimestamp > 300) {
        continue;
      }

      const { type: mediaType, media, rootMsg } = unwrapMediaMessage(msg.message);
      if (!mediaType || !media || !media.mediaKey) continue;

      const rawMime = (media.mimetype || '').split(';')[0].toLowerCase();
      const detectedMime = rawMime || (mediaType === 'imageMessage' ? 'image/jpeg' : 'application/pdf');

      const originalFileName = media.fileName || '';
      const fileExt = path.extname(originalFileName).toLowerCase();

      const isAllowedMime = ALLOWED_MIME_TYPES.has(detectedMime);
      const isAllowedExt = ALLOWED_EXTENSIONS.has(fileExt);

      if (!isAllowedMime && !isAllowedExt) {
        console.log(`[GATEWAY:${shopId}] Ignored unsupported file format: mime=${detectedMime}, ext=${fileExt}`);
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

        let originalFilename = `${msg.key.id}`;
        if (mediaType === 'imageMessage') {
          originalFilename = `${msg.key.id}.jpg`;
        } else if (mediaType === 'documentMessage') {
          originalFilename = media.fileName || `${msg.key.id}.pdf`;
        }

        const safeFolder = `${shopId}_${customerPhone.replace(/[^a-zA-Z0-9]/g, '_')}`;
        const customerDir = path.join(INGRESS_BASE_DIR, safeFolder);
        if (!fs.existsSync(customerDir)) {
          fs.mkdirSync(customerDir, { recursive: true });
        }

        const destinationPath = path.join(customerDir, `${Date.now()}_${originalFilename}`);
        fs.writeFileSync(destinationPath, buffer);

        console.log(`[GATEWAY:${shopId}] Ingested file "${originalFilename}" from ${customerPhone}`);

        await axios.post(FASTAPI_ENDPOINT, {
          shop_id: shopId,
          customer_phone: customerPhone,
          message_id: msg.key.id,
          file_path: destinationPath,
          original_filename: originalFilename,
          mime_type: detectedMime,
          file_size: buffer.length,
          timestamp: Date.now() / 1000
        }, { timeout: 10000 });

      } catch (err) {
        console.error(`[GATEWAY:${shopId}] Download error on ${msg.key.id}:`, err.message);
      }
    }
  });

  return sock;
}

// Sidecar HTTP Controller
const server = express();
server.use(cors());
server.use(express.json());

server.post('/api/gateway/init', async (req, res) => {
  const shopId = req.body.shop_id || 'default';
  try {
    await getOrInitSocket(shopId);
    res.json({ status: 'INITIALIZING', shop_id: shopId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

server.post('/api/gateway/logout', async (req, res) => {
  const shopId = req.body.shop_id || 'default';
  console.log(`[GATEWAY:${shopId}] Explicit logout triggered.`);

  const sock = activeSockets.get(shopId);

  if (sock) {
    try {
      await sock.logout();
    } catch (e) {
      console.warn(`[GATEWAY:${shopId}] Socket logout warning:`, e.message);
    }
    try {
      sock.end(undefined);
    } catch (_) {}
    activeSockets.delete(shopId);
  }

  const shopAuthFolder = path.join(AUTH_BASE_DIR, shopId);
  if (fs.existsSync(shopAuthFolder)) {
    try {
      fs.rmSync(shopAuthFolder, { recursive: true, force: true });
      console.log(`[GATEWAY:${shopId}] Deleted credentials folder: ${shopAuthFolder}`);
    } catch (err) {
      console.error(`[GATEWAY:${shopId}] Error deleting auth directory:`, err.message);
    }
  }

  await axios.post(FASTAPI_QR_ENDPOINT, {
    shop_id: shopId,
    status: 'LOGGED_OUT',
    qr_image: null
  }).catch(() => {});

  setTimeout(() => {
    getOrInitSocket(shopId);
  }, 1000);

  return res.json({ status: 'LOGGED_OUT', shop_id: shopId });
});

server.listen(GATEWAY_PORT, () => {
  console.log(`[GATEWAY-SERVER] Listening on internal port ${GATEWAY_PORT}`);
  getOrInitSocket('default');
});