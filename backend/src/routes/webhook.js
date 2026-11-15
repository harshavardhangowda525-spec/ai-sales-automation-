const express = require('express');
const config = require('../lib/config');
const { logError } = require('../lib/logger');
const { recordCall, processCall } = require('../services/pipeline');
const { handleOwnerWebhook, buildJarvisContext } = require('../services/ownerCalls');
const prisma = require('../lib/prisma');
const { logAction } = require('../lib/logger');
const { toE164 } = require('../lib/phone');

const router = express.Router();

/**
 * Optional shared-secret check. Sarvam does not sign webhooks, so we put a secret in the URL
 * (…/webhook/sarvam?secret=XYZ) or accept it in an x-webhook-secret header.
 */
function verifySecret(req, res, next) {
  if (!config.webhookSecret) return next();
  const provided = req.query.secret || req.get('x-webhook-secret');
  if (provided !== config.webhookSecret) return res.status(401).json({ error: 'invalid webhook secret' });
  return next();
}

// POST /webhook/sarvam — call outcome from Sarvam AI after every call.
// ACKs immediately (202) and processes in the background so Sarvam never times out.
// Add ?sync=1 to wait for the full pipeline and get the result back (handy for testing).
router.post('/sarvam', verifySecret, async (req, res) => {
  let recorded;
  try {
    recorded = await recordCall(req.body);
  } catch (err) {
    await logError(null, 'WEBHOOK', err);
    return res.status(err.status || 500).json({ error: err.message });
  }

  if (req.query.sync === '1' || req.query.sync === 'true') {
    try {
      const result = await processCall(recorded);
      return res.json({ ok: true, client_id: recorded.client.id, result });
    } catch (err) {
      await logError(recorded.client.id, 'PIPELINE', err);
      return res.status(500).json({ error: err.message, client_id: recorded.client.id });
    }
  }

  res.status(202).json({ ok: true, client_id: recorded.client.id });
  processCall(recorded).catch((err) => logError(recorded.client.id, 'PIPELINE', err));
});

// POST /webhook/sarvam/owner — result of a call to Harshavardhan (summary / approval).
router.post('/sarvam/owner', verifySecret, async (req, res) => {
  try {
    const result = await handleOwnerWebhook(req.body);
    res.json({ ok: true, ...result });
  } catch (err) {
    await logError(null, 'OWNER_WEBHOOK', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * On-start hook for INBOUND calls to the Jarvis agent (configure it on the agent in Sarvam).
 * Sarvam calls this when someone rings the Jarvis number, before the agent speaks.
 * - Caller is the owner (HARSHAVARDHAN_PHONE): returns his latest picture in jarvis_context and
 *   harsha_message "-" so Jarvis opens with "How can I help you, sir?".
 * - Anyone else (e.g. a business returning a missed call on the shared number): returns no
 *   business data, only an instruction to take a polite message; the callback is logged.
 * Accepts GET or POST; the caller number is read from common field names.
 */
async function jarvisContext(req, res) {
  try {
    const src = { ...(req.query || {}), ...(req.body || {}) };
    const raw = src.user_phone_number || src.caller_phone_number || src.phone_number || src.caller
      || src.from || src.From || src.user?.phone_number || src.user_config?.user_phone_number || '';
    const caller = raw ? toE164(String(raw)) : null;
    const owner = config.ownerPhone ? toE164(config.ownerPhone) : null;

    if (caller && owner && caller === owner) {
      const context = await buildJarvisContext();
      // If Jarvis is calling sir right now (outbound), return that call's update instead of "-".
      const active = await prisma.ownerCall.findFirst({
        where: { status: 'CALLING', called_at: { gt: new Date(Date.now() - 10 * 60000) } },
        orderBy: { called_at: 'desc' },
      });
      if (active?.data?.spoken_message) {
        return res.json({ harsha_message: active.data.spoken_message, jarvis_context: context, caller_is_owner: 'yes', direction: 'outbound' });
      }
      await logAction(null, 'JARVIS_INBOUND_CALL', 'Sir called Jarvis — latest context loaded');
      return res.json({ harsha_message: '-', jarvis_context: context, caller_is_owner: 'yes', direction: 'inbound' });
    }

    let note = 'unknown number';
    if (caller) {
      const client = await prisma.client.findFirst({ where: { phone_number: caller }, orderBy: { created_at: 'desc' } });
      note = client ? `${client.business_name} (${caller})` : caller;
      await logAction(client?.id || null, 'INBOUND_CALLBACK',
        `${note} called the business number — Jarvis took a message`);
    }
    return res.json({
      harsha_message: '-',
      caller_is_owner: 'no',
      jarvis_context: `THE CALLER IS NOT SIR. This is ${note === 'unknown number' ? 'an unknown caller' : note}, `
        + 'probably returning a call from Infinity Web & Apps. Do not share any information about sir, '
        + 'clients, prices or the business pipeline. Politely say you are the assistant at Infinity Web & Apps, '
        + 'ask their name and what they need, say the team will call them back shortly, then end the call.',
    });
  } catch (err) {
    await logError(null, 'JARVIS_CONTEXT', err);
    // Fail safe: no business data on errors.
    return res.json({ harsha_message: '-', caller_is_owner: 'no', jarvis_context: 'No information available right now. Take a polite message and say the team will call back.' });
  }
}
router.get('/sarvam/jarvis-context', verifySecret, jarvisContext);
router.post('/sarvam/jarvis-context', verifySecret, jarvisContext);

module.exports = router;
