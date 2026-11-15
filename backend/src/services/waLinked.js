// Send WhatsApp messages from the owner's own number by linking the server as a WhatsApp
// "linked device" (like WhatsApp Web), using Baileys. No Meta templates needed.
// NOTE: this is an unofficial WhatsApp client — WhatsApp may restrict numbers that automate
// messages. We only ever message clients who booked, one message per event.
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket, initAuthCreds, BufferJSON, DisconnectReason, proto, fetchLatestBaileysVersion, Browsers,
} = require('@whiskeysockets/baileys');
const prisma = require('../lib/prisma');
const { logAction, logError } = require('../lib/logger');

const logger = pino({ level: 'silent' });

const state = {
  sock: null,
  status: 'disconnected', // disconnected | connecting | qr | connected | logged_out
  qr: null,               // raw QR string while waiting for a scan
  me: null,               // linked number, e.g. "919xxxxxxxxx"
  lastError: null,
  connecting: null,
};

// ── Auth state stored in Postgres ──────────────────────────────────────────────────────────
async function readKey(key) {
  const row = await prisma.waSession.findUnique({ where: { key } });
  return row ? JSON.parse(row.value, BufferJSON.reviver) : null;
}
async function writeKey(key, value) {
  const json = JSON.stringify(value, BufferJSON.replacer);
  await prisma.waSession.upsert({ where: { key }, update: { value: json }, create: { key, value: json } });
}
async function removeKey(key) {
  await prisma.waSession.deleteMany({ where: { key } });
}

async function usePostgresAuthState() {
  const creds = (await readKey('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readKey(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            out[id] = value;
          }));
          return out;
        },
        set: async (data) => {
          const tasks = [];
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const value = data[type][id];
              tasks.push(value ? writeKey(`${type}-${id}`, value) : removeKey(`${type}-${id}`));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeKey('creds', creds),
  };
}

async function hasSession() {
  const creds = await readKey('creds');
  return Boolean(creds?.registered || creds?.me);
}

// ── Connection ────────────────────────────────────────────────────────────────────────────
async function connect() {
  if (state.connecting) return state.connecting;
  state.connecting = (async () => {
    state.status = 'connecting';
    state.lastError = null;
    const { state: auth, saveCreds } = await usePostgresAuthState();
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined; // fall back to the library default
    }
    const sock = makeWASocket({
      version,
      auth,
      logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Infinity Dashboard'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    state.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        state.qr = u.qr;
        state.status = 'qr';
      }
      if (u.connection === 'open') {
        state.status = 'connected';
        state.qr = null;
        state.me = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
        await logAction(null, 'WHATSAPP_LINKED', `Your WhatsApp (${state.me ? `+${state.me}` : 'number'}) is linked — messages send automatically`);
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        state.sock = null;
        state.connecting = null;
        if (code === DisconnectReason.loggedOut) {
          state.status = 'logged_out';
          state.me = null;
          await prisma.waSession.deleteMany({});
          await logAction(null, 'WHATSAPP_UNLINKED', 'WhatsApp was unlinked from your phone — link it again from the WhatsApp page');
        } else {
          state.status = 'disconnected';
          state.lastError = u.lastDisconnect?.error?.message || null;
          // Reconnect after transient drops (restart required after pairing, network blips, etc.)
          if (await hasSession() || code === DisconnectReason.restartRequired) {
            setTimeout(() => connect().catch((err) => logError(null, 'WHATSAPP_RECONNECT', err)), 3000);
          }
        }
      }
    });
    return sock;
  })();
  try {
    return await state.connecting; // stays set until the socket closes (cleared in the close handler)
  } catch (err) {
    state.connecting = null;
    state.status = 'disconnected';
    state.lastError = err.message;
    throw err;
  }
}

/** Start linking: returns current status (QR appears shortly after). */
async function startLinking() {
  if (state.status === 'connected') return getStatus();
  if (!state.sock) await connect();
  return getStatus();
}

/** Alternative to QR: an 8-character code typed on the phone ("Link with phone number instead"). */
async function requestPairingCode(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) throw Object.assign(new Error('Enter your WhatsApp number with country code, e.g. 916360471652'), { status: 400 });
  if (!state.sock) await connect();
  // Wait for the socket to be ready to request a code
  for (let i = 0; i < 20 && state.status === 'connecting'; i++) await new Promise((r) => setTimeout(r, 500));
  const code = await state.sock.requestPairingCode(digits);
  return code.match(/.{1,4}/g).join('-');
}

async function getStatus() {
  return {
    status: state.status,
    linked_number: state.me ? `+${state.me}` : null,
    qr: state.status === 'qr' && state.qr ? await QRCode.toDataURL(state.qr, { margin: 1, width: 280 }) : null,
    error: state.lastError,
  };
}

function isReady() {
  return state.status === 'connected' && Boolean(state.sock);
}

/** Make sure we're connected (e.g. after the free Render instance woke up). */
async function ensureConnected(timeoutMs = 15000) {
  if (isReady()) return true;
  if (!(await hasSession())) return false;
  if (!state.sock) await connect();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && !isReady()) await new Promise((r) => setTimeout(r, 300));
  return isReady();
}

/** Send a text from the linked WhatsApp. Returns the message id. */
async function sendText(phone, text) {
  if (!(await ensureConnected())) throw new Error('Your WhatsApp is not linked — open the WhatsApp page in the dashboard and link it');
  const digits = String(phone).replace(/\D/g, '');
  const [exists] = await state.sock.onWhatsApp(digits);
  if (!exists?.exists) throw new Error(`+${digits} is not on WhatsApp`);
  // Behave like a person: short "typing…" before sending.
  await state.sock.presenceSubscribe(exists.jid).catch(() => {});
  await state.sock.sendPresenceUpdate('composing', exists.jid).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
  await state.sock.sendPresenceUpdate('paused', exists.jid).catch(() => {});
  const sent = await state.sock.sendMessage(exists.jid, { text });
  return sent?.key?.id || null;
}

async function unlink() {
  try {
    if (state.sock) await state.sock.logout();
  } catch {
    // already gone
  }
  await prisma.waSession.deleteMany({});
  state.sock = null;
  state.connecting = null;
  state.status = 'logged_out';
  state.me = null;
  state.qr = null;
  await logAction(null, 'WHATSAPP_UNLINKED', 'WhatsApp unlinked from the dashboard');
}

/** On server start: reconnect if a session was linked before. */
async function resumeIfLinked() {
  if (await hasSession()) await connect();
}

module.exports = {
  startLinking, requestPairingCode, getStatus, isReady, ensureConnected, sendText, unlink, resumeIfLinked, hasSession,
};
