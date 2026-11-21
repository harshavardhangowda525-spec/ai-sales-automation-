// Cold-call campaigns on sir's own line (Infinity Voice). Sarvam campaigns are untouched;
// this is the second engine. Leads are dialled one at a time (single SIM), only inside calling
// hours and under the daily cap. When every lead has had its call, Jarvis (Sarvam) phones sir with
// the summary, and BOOKED leads get the usual Meet + proposal + approval automation.
const prisma = require('../../lib/prisma');
const { logAction, logError } = require('../../lib/logger');
const { toE164 } = require('../../lib/phone');
const crm = require('./crmAdapter');

const OPEN = ['CREATED', 'ELIGIBILITY_CHECK', 'QUEUED', 'GATEWAY_READY', 'DIALING', 'RINGING', 'CONNECTED', 'AI_ACTIVE', 'RETRY_PENDING',
  'COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED', 'REJECTED', 'GATEWAY_DISCONNECTED', 'ESCALATED'];

async function salesAgent() {
  return prisma.voiceAgent.findFirst({ where: { role: 'SALES', active: true, can_call_out: true }, orderBy: { created_at: 'asc' } });
}

/**
 * Create the campaign and its leads. Numbers already on do-not-call are skipped.
 * contacts: [{ phone_number, business_name }]
 */
async function startVoiceCampaign({ campaign_name, contacts = [] }) {
  const cc = crm.coldCalling();
  if (!cc.authorized || !cc.ref) {
    throw Object.assign(new Error('Cold calling on Infinity Voice is switched off. Set VOICE_COLD_CALLING_AUTHORIZED=true and VOICE_TELEMARKETER_ID on Render.'), { status: 409 });
  }
  if (!(await salesAgent())) throw Object.assign(new Error('No active Sales agent in Infinity Voice → Agents'), { status: 409 });
  const seen = new Set();
  const leads = [];
  for (const c of contacts.slice(0, 1000)) {
    const phone = toE164(c.phone_number || c.phone);
    if (!phone || phone.replace(/\D/g, '').length < 12 || seen.has(phone)) continue;
    seen.add(phone);
    leads.push({ phone, business_name: String(c.business_name || '').trim().slice(0, 200) || null });
  }
  if (!leads.length) throw Object.assign(new Error('Add at least one valid 10-digit mobile number'), { status: 400 });

  const campaign = await prisma.campaign.create({
    data: { name: String(campaign_name).slice(0, 200), engine: 'infinity_voice', total_calls: 0, contacts: leads },
  });
  let added = 0;
  const skipped = [];
  for (const l of leads) {
    // Do-not-call on ANY record for this number wins.
    if (await prisma.client.count({ where: { phone_number: l.phone, do_not_call: true } })) { skipped.push({ phone: l.phone, reason: 'do-not-call' }); continue; }
    const existing = await prisma.client.findFirst({ where: { phone_number: l.phone }, orderBy: { created_at: 'desc' } });
    if (existing && !existing.campaign_id) {
      await prisma.client.update({ where: { id: existing.id }, data: { campaign_id: campaign.id } });
    } else {
      // Same pattern as Sarvam campaigns: one row per campaign, so older campaign stats stay intact.
      await prisma.client.create({ data: {
        campaign_id: campaign.id, phone_number: l.phone, call_outcome: 'MANUAL',
        business_name: l.business_name || existing?.business_name || 'Unknown business',
        contact_name: existing?.contact_name || null, email: existing?.email || null,
      } });
    }
    added++;
  }
  const updated = await prisma.campaign.update({ where: { id: campaign.id }, data: { total_calls: added } });
  await logAction(null, 'VOICE_CAMPAIGN_STARTED', `"${updated.name}": ${added} leads on Infinity Voice (auth ${cc.ref})${skipped.length ? `, ${skipped.length} skipped (do-not-call)` : ''}`);
  tick().catch(() => {});
  return { campaign: updated, added, skipped };
}

/** Leads of a campaign that have not had a cold call yet. */
async function pendingLeads(campaign) {
  const leads = await prisma.client.findMany({ where: { campaign_id: campaign.id, do_not_call: false }, orderBy: { created_at: 'asc' } });
  if (!leads.length) return [];
  const called = await prisma.voiceCall.findMany({
    where: { purpose: 'cold', mode: 'LIVE', created_at: { gte: campaign.created_at }, client_id: { in: leads.map((l) => l.id) } },
    select: { client_id: true },
  });
  const done = new Set(called.map((c) => c.client_id));
  return leads.filter((l) => !done.has(l.id));
}

/** One pass: dial the next lead when the line is free; close finished campaigns. */
let inFlight = null;
function tick(opts) {
  if (!inFlight) inFlight = tickOnce(opts).finally(() => { inFlight = null; });
  return inFlight;
}
async function tickOnce({ now = new Date() } = {}) {
  try {
    const campaigns = await prisma.campaign.findMany({ where: { engine: 'infinity_voice', status: 'RUNNING' }, orderBy: { created_at: 'asc' } });
    if (!campaigns.length) return;
    const orch = require('./orchestrator');
    for (const campaign of campaigns) {
      const leads = await pendingLeads(campaign);
      const ids = (await prisma.client.findMany({ where: { campaign_id: campaign.id }, select: { id: true } })).map((c) => c.id);
      const open = await prisma.voiceCall.count({ where: { purpose: 'cold', mode: 'LIVE', state: { in: OPEN }, client_id: { in: ids } } });
      if (!leads.length && !open) { await complete(campaign.id); continue; }
    }
    // Pace: only add a call when nothing is waiting for the line, and only when it could dial now.
    if (!orch.flags().liveCalling || await orch.isEmergencyStopped() || !crm.inCallingHours(now)) return;
    const waiting = await prisma.voiceCall.count({ where: { mode: 'LIVE', direction: 'OUTBOUND', state: { in: ['QUEUED', 'GATEWAY_READY', 'DIALING', 'RINGING', 'CONNECTED', 'AI_ACTIVE'] } } });
    if (waiting) return;
    const agent = await salesAgent();
    if (!agent) return;
    for (const campaign of campaigns) {
      const [lead] = await pendingLeads(campaign);
      if (!lead) continue;
      const e = await crm.getCallEligibility({ clientId: lead.id, purpose: 'cold', now });
      if (e.reasons.some((r) => /Daily call limit|Outside calling hours/.test(r))) return; // try again later
      await orch.requestLiveCall({ agentId: agent.id, clientId: lead.id, purpose: 'cold', source: `campaign "${campaign.name}"` });
      return; // one call at a time
    }
  } catch (err) {
    await logError(null, 'VOICE_CAMPAIGN_TICK', err);
  }
}

/** Every lead done: stats, then Jarvis calls sir with the summary (on Sarvam). */
async function complete(campaignId) {
  const { recomputeCampaignStats } = require('../pipeline');
  const { triggerSummaryCall } = require('../sarvam');
  await recomputeCampaignStats(campaignId);
  return triggerSummaryCall(campaignId);
}

/** Called after a cold call is synced: BOOKED leads get the Meet + proposal (sent to sir first). */
async function afterCall(call) {
  if (call.purpose !== 'cold' || call.mode !== 'LIVE' || !call.client_id) return;
  const client = await prisma.client.findUnique({ where: { id: call.client_id } });
  if (!client?.campaign_id) return;
  const { recomputeCampaignStats, runBookedAutomation } = require('../pipeline');
  await recomputeCampaignStats(client.campaign_id).catch(() => {});
  if (call.outcome === 'BOOKED' && !client.proposal_url) {
    await runBookedAutomation(client).catch((err) => logError(client.id, 'VOICE_BOOKED_AUTOMATION', err));
  }
}

module.exports = { startVoiceCampaign, tick, afterCall, complete, pendingLeads };
