const express = require('express');
const waLinked = require('../services/waLinked');
const { logAction } = require('../lib/logger');
const config = require('../lib/config');

const router = express.Router();

// GET /api/whatsapp — link status (+ QR image while waiting for a scan)
router.get('/', async (req, res, next) => {
  try {
    res.json({ ...(await waLinked.getStatus()), session_saved: await waLinked.hasSession() });
  } catch (err) { next(err); }
});

// POST /api/whatsapp/link — start linking (QR appears in GET within a few seconds)
router.post('/link', async (req, res, next) => {
  try { res.json(await waLinked.startLinking()); } catch (err) { next(err); }
});

// POST /api/whatsapp/pair { phone } — pairing code alternative to the QR
router.post('/pair', async (req, res, next) => {
  try { res.json({ code: await waLinked.requestPairingCode(req.body?.phone) }); } catch (err) { next(err); }
});

// POST /api/whatsapp/test — send a test message to the owner's own number
router.post('/test', async (req, res, next) => {
  try {
    const to = req.body?.to || config.ownerPhone;
    if (!to) return res.status(400).json({ error: 'No number to test with (set HARSHAVARDHAN_PHONE)' });
    const text = String(req.body?.text || '').trim().slice(0, 2000)
      || '✅ Infinity dashboard test: your WhatsApp is linked and can send messages automatically.';
    const id = await waLinked.sendText(to, text);
    await logAction(null, 'WHATSAPP_TEST_SENT', `Test message sent to ${to}`);
    res.json({ ok: true, message_id: id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/whatsapp/unlink
router.post('/unlink', async (req, res, next) => {
  try { await waLinked.unlink(); res.json({ ok: true }); } catch (err) { next(err); }
});

module.exports = router;
