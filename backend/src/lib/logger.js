const prisma = require('./prisma');

/**
 * Write an entry to call_logs. Never throws — logging must not break the pipeline.
 * @param {string|null} clientId
 * @param {string} action short machine-friendly action name, e.g. MEET_SCHEDULED
 * @param {string|object} [details]
 */
async function logAction(clientId, action, details = '') {
  const text = typeof details === 'string' ? details : JSON.stringify(details);
  try {
    await prisma.callLog.create({
      data: { client_id: clientId || null, action, details: text },
    });
  } catch (err) {
    console.error(`[log] failed to write call_log ${action}:`, err.message);
  }
}

/** Log an error both to the console and to call_logs (action is suffixed with _ERROR). */
async function logError(clientId, action, err) {
  const message = err?.response?.data
    ? `${err.message} — ${JSON.stringify(err.response.data)}`
    : err?.message || String(err);
  console.error(`[${action}]`, message);
  await logAction(clientId, `${action}_ERROR`, message);
}

module.exports = { logAction, logError };
