// Sarvam doesn't deliver the campaign webhook reliably, so every few minutes we read finished
// campaign calls from Sarvam's analytics API and feed each one into the normal pipeline
// (same path as the webhook: recordCall → processCall). Idempotent: call_id = Sarvam interaction id.
const config = require('../lib/config');
const prisma = require('../lib/prisma');
const { logAction, logError } = require('../lib/logger');
const { toE164 } = require('../lib/phone');

let lastRun = 0;
let running = false;

function transcriptFromTrace(trace) {
  const out = [];
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    const role = x.role;
    const text = x.en_text ?? x.text;
    if ((role === 'agent' || role === 'user') && typeof text === 'string' && text.trim()) {
      const last = out[out.length - 1];
      if (!last || last.role !== role || last.en_text !== text.trim()) out.push({ role, en_text: text.trim() });
    }
    Object.values(x).forEach(walk);
  };
  walk(trace);
  return out;
}

async function syncCampaignCalls({ force = false } = {}) {
  if (!config.isConfigured.sarvam || running) return { skipped: true };
  if (!force && Date.now() - lastRun < 2 * 60000) return { skipped: true };
  running = true;
  lastRun = Date.now();
  let imported = 0;
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { sarvam_campaign_id: { not: null }, created_at: { gt: new Date(Date.now() - 10 * 86400000) } },
    });
    if (!campaigns.length) return { imported };
    const bySarvamId = new Map(campaigns.map((c) => [c.sarvam_campaign_id, c]));
    const since = new Date(Math.min(...campaigns.map((c) => c.created_at.getTime())) - 60000);
    const { listInteractions, getTrace } = require('./sarvam');
    const { recordCall, processCall } = require('./pipeline');
    const interactions = await listInteractions(config.sarvam.salesAgentId, since);

    for (const it of interactions) {
      const campaign = bySarvamId.get(it.campaign_id);
      if (!campaign || it.channel_direction !== 'outbound' || !it.end_datetime) continue;
      if (await prisma.client.findUnique({ where: { call_id: it.interaction_id }, select: { id: true } })) continue;
      try {
        const phone = toE164(it.user_contact);
        const known = (campaign.contacts || []).find((c) => c.phone === phone);
        const vars = it.agent_variables || {};
        let transcript = [];
        if ((it.num_messages || 0) > 1) transcript = transcriptFromTrace(await getTrace(config.sarvam.salesAgentId, it.interaction_id).catch(() => null));
        const body = {
          call_id: it.interaction_id,
          user_phone_number: phone,
          business_name: vars.business_name || known?.business_name || undefined,
          campaign_id: campaign.id,
          duration_seconds: it.duration_in_seconds,
          interaction_transcript: transcript.length ? transcript : undefined,
          // user_name is an agent default (e.g. a test name), not the real person — only trust a distinct name.
          final_agent_variables: {
            ...vars,
            contact_name: vars.contact_name || (vars.prospect_name && vars.prospect_name !== vars.user_name ? vars.prospect_name : undefined),
          },
          connectivity_status: (it.num_messages || 0) <= 1 ? 'no_answer' : undefined,
        };
        const recorded = await recordCall(body);
        await processCall(recorded);
        imported += 1;
      } catch (err) {
        await logError(null, 'CAMPAIGN_CALL_SYNC', err);
      }
    }
    if (imported) await logAction(null, 'CAMPAIGN_CALLS_SYNCED', `Imported ${imported} finished campaign call(s) from Sarvam`);
    return { imported };
  } catch (err) {
    await logError(null, 'CAMPAIGN_CALL_SYNC', err);
    return { imported, error: err.message };
  } finally {
    running = false;
  }
}

module.exports = { syncCampaignCalls, transcriptFromTrace };
