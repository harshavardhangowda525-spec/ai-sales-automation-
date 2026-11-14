const express = require('express');
const config = require('../lib/config');
const { logError } = require('../lib/logger');
const { recordCall, processCall } = require('../services/pipeline');

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

module.exports = router;
