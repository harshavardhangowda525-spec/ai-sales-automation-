// Orchestrates what happens after every Sarvam call.
const prisma = require('../lib/prisma');
const { logAction, logError } = require('../lib/logger');
const { toE164 } = require('../lib/phone');
const { parseTranscript } = require('./transcriptParser');
const { scheduleGoogleMeet } = require('./googleCalendar');
const { generateProposal } = require('./proposalGenerator');
const { sendWhatsAppMessage } = require('./whatsapp');
const { triggerSummaryCall } = require('./sarvam');
const { requestOwnerCall } = require('./ownerCalls');
const { generateWebsitePrompt } = require('./websitePrompt');
const config = require('../lib/config');

const OUTCOMES = ['BOOKED', 'REJECTED', 'NO_ANSWER', 'CALLBACK_LATER'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeOutcome(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (OUTCOMES.includes(v)) return v;
  if (['CALLBACK', 'CALL_BACK', 'CALL_BACK_LATER', 'FOLLOW_UP'].includes(v)) return 'CALLBACK_LATER';
  if (['NOT_INTERESTED', 'DECLINED'].includes(v)) return 'REJECTED';
  if (['NOANSWER', 'NOT_ANSWERED', 'BUSY', 'FAILED', 'UNREACHABLE'].includes(v)) return 'NO_ANSWER';
  if (['MEETING_BOOKED', 'INTERESTED', 'YES', 'CONVERTED'].includes(v)) return 'BOOKED';
  return null;
}

function transcriptToText(t) {
  if (!t) return null;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) {
    return t.map((m) => `${m.role === 'user' ? 'Customer' : m.role === 'agent' || m.role === 'assistant' || m.role === 'bot' ? 'Agent' : m.role || 'Speaker'}: ${m.en_text ?? m.text ?? m.content ?? ''}`).join('\n');
  }
  return JSON.stringify(t);
}

/**
 * Accept both the payload shape agreed in the spec and Sarvam's native campaign / instant-outbound
 * webhook payloads (attempt_id, user_phone_number, interaction_transcript, *_agent_variables …).
 */
function normalizePayload(body = {}) {
  const vars = {
    ...(body.initial_agent_variables || {}),
    ...(body.final_agent_variables || {}),
    ...(body.output_agent_variables || {}),
  };
  const connectivity = String(body.connectivity_status || body.status || '').toLowerCase();
  const unreachable = ['no_answer', 'busy', 'failed', 'not_connected', 'unreachable'].includes(connectivity);

  return {
    callId: body.call_id || body.attempt_id || body.interaction_id || null,
    phone: toE164(body.phone_number || body.user_phone_number || vars.phone_number),
    businessName: body.business_name || vars.business_name || body.user_identifier || 'Unknown business',
    outcome: normalizeOutcome(body.outcome || vars.outcome || vars.call_outcome) || (unreachable ? 'NO_ANSWER' : null),
    transcript: transcriptToText(body.transcript || body.interaction_transcript),
    durationSeconds: Number.isFinite(Number(body.duration_seconds ?? body.duration)) ? Math.round(Number(body.duration_seconds ?? body.duration)) : null,
    campaignRef: body.campaign_id || body.metadata?.campaign_id || body.webhook_config?.metadata?.campaign_id || null,
    metadataCampaignId: body.metadata?.campaign_id || body.webhook_config?.metadata?.campaign_id || null,
    contactName: vars.contact_name || vars.customer_name || null,
    planHint: vars.plan_interest || vars.plan || null,
  };
}

/** Find our campaign row from either our UUID or Sarvam's campaign id; create one if unknown. */
async function resolveCampaign(p) {
  for (const ref of [p.metadataCampaignId, p.campaignRef].filter(Boolean)) {
    if (UUID_RE.test(ref)) {
      const byId = await prisma.campaign.findUnique({ where: { id: ref } });
      if (byId) return byId;
    }
    const bySarvam = await prisma.campaign.findUnique({ where: { sarvam_campaign_id: String(ref) } });
    if (bySarvam) return bySarvam;
  }
  if (p.campaignRef && !UUID_RE.test(p.campaignRef)) {
    return prisma.campaign.upsert({
      where: { sarvam_campaign_id: String(p.campaignRef) },
      update: {},
      create: { name: `Sarvam campaign ${p.campaignRef}`, sarvam_campaign_id: String(p.campaignRef) },
    });
  }
  if (p.campaignRef) {
    return prisma.campaign.create({ data: { id: p.campaignRef, name: `Campaign ${p.campaignRef.slice(0, 8)}` } });
  }
  return null;
}

/** Recount campaign stats from the clients table (robust to retries / re-deliveries). */
async function recomputeCampaignStats(campaignId) {
  if (!campaignId) return null;
  const groups = await prisma.client.groupBy({
    by: ['call_outcome'], where: { campaign_id: campaignId }, _count: { _all: true },
  });
  const count = (o) => groups.find((g) => g.call_outcome === o)?._count._all || 0;
  const stats = {
    booked: count('BOOKED'),
    rejected: count('REJECTED'),
    no_answer: count('NO_ANSWER'),
    callback_later: count('CALLBACK_LATER'),
  };
  const processed = stats.booked + stats.rejected + stats.no_answer + stats.callback_later;
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  return prisma.campaign.update({
    where: { id: campaignId },
    data: { ...stats, total_calls: Math.max(campaign.total_calls, processed) },
  }).then((c) => ({ ...c, processed, expected: campaign.total_calls }));
}

/**
 * Step 1 (synchronous, fast): persist the call so the webhook can ACK quickly.
 * Re-deliveries of the same call_id, and retries to the same number within a campaign, update the
 * existing client instead of creating duplicates.
 */
async function recordCall(body) {
  const p = normalizePayload(body);
  if (!p.phone) throw Object.assign(new Error('phone_number is required'), { status: 400 });

  const campaign = await resolveCampaign(p);
  let existing = p.callId ? await prisma.client.findUnique({ where: { call_id: p.callId } }) : null;
  if (!existing && campaign) {
    existing = await prisma.client.findFirst({ where: { campaign_id: campaign.id, phone_number: p.phone } });
  }

  const data = {
    campaign_id: campaign?.id || null,
    business_name: p.businessName,
    phone_number: p.phone,
    call_outcome: p.outcome || existing?.call_outcome || 'CALLBACK_LATER',
    transcript: p.transcript ?? existing?.transcript ?? null,
    duration_seconds: p.durationSeconds ?? existing?.duration_seconds ?? null,
    ...(p.contactName ? { contact_name: p.contactName } : {}),
  };

  let client;
  if (existing) {
    // Never downgrade an already-booked client because a later retry didn't connect.
    if (existing.call_outcome === 'BOOKED' && data.call_outcome !== 'BOOKED') data.call_outcome = 'BOOKED';
    client = await prisma.client.update({
      where: { id: existing.id },
      data: { ...data, call_id: existing.call_id || p.callId },
    });
    await logAction(client.id, 'CALL_RECEIVED', `Repeat webhook (${p.callId || 'no call id'}) — outcome ${client.call_outcome}`);
  } else {
    client = await prisma.client.create({ data: { ...data, call_id: p.callId } });
    await logAction(client.id, 'CALL_RECEIVED',
      `Call ${p.callId || ''} from Sarvam — outcome ${client.call_outcome}${p.durationSeconds ? `, ${p.durationSeconds}s` : ''}`);
  }
  return { client, payload: p, outcomeKnown: Boolean(p.outcome), isNew: !existing };
}

/** Run the booked-client automations: Meet → proposal → WhatsApp. Each step is isolated. */
/**
 * @param {object} [opts] { skipApproval } — true when Harsha triggered it himself from the dashboard
 */
async function runBookedAutomation(client, prefs = {}, { skipApproval = false } = {}) {
  const result = { meet: null, proposal: null, whatsapp: null, approval: null, errors: [] };

  if (!client.meeting_link) {
    try {
      result.meet = await scheduleGoogleMeet(client, prefs);
    } catch (err) {
      result.errors.push('meet');
      await logError(client.id, 'MEET_SCHEDULE', err);
    }
  }

  let fresh = await prisma.client.findUnique({ where: { id: client.id } });
  try {
    result.proposal = await generateProposal(fresh);
  } catch (err) {
    result.errors.push('proposal');
    await logError(client.id, 'PROPOSAL_GENERATE', err);
  }

  fresh = await prisma.client.findUnique({ where: { id: client.id } });
  if (fresh.proposal_url && config.ownerCalls.requireQuotationApproval && !skipApproval) {
    // Ask Harsha on a call first; the WhatsApp goes out when he says yes (see ownerCalls.js).
    try {
      const call = await requestOwnerCall('QUOTATION', { clientId: client.id, campaignId: client.campaign_id });
      result.approval = { ownerCallId: call.id, status: call.status };
    } catch (err) {
      result.errors.push('approval');
      await logError(client.id, 'APPROVAL_REQUEST', err);
    }
  } else if (fresh.proposal_url) {
    try {
      result.whatsapp = await sendWhatsAppMessage(fresh, fresh.proposal_url, fresh.meeting_link, fresh.meeting_time,
        { proposalNumber: result.proposal?.number });
      await prisma.client.update({ where: { id: client.id }, data: { proposal_sent: true } });
    } catch (err) {
      result.errors.push('whatsapp');
      await logError(client.id, 'WHATSAPP_SEND', err);
    }
  }

  const final = await prisma.client.findUnique({ where: { id: client.id } });
  if (!['CONVERTED', 'LOST'].includes(final.portal_status)) {
    const status = final.meeting_link ? 'MEETING_SCHEDULED' : final.proposal_sent ? 'PROPOSAL_SENT' : final.portal_status;
    if (status !== final.portal_status) {
      await prisma.client.update({ where: { id: client.id }, data: { portal_status: status } });
    }
  }
  return result;
}

/** Step 2 (async): parse transcript, run automations, update stats, maybe trigger summary call. */
async function processCall({ client, payload, outcomeKnown }) {
  const summary = { clientId: client.id, parsed: null, automation: null, campaign: null };

  // 1. Transcript → structured fields
  let prefs = {};
  if (client.transcript) {
    try {
      const { data, source } = await parseTranscript(client.transcript);
      prefs = data;
      const update = {
        ...(data.contact_name && !client.contact_name ? { contact_name: data.contact_name } : {}),
        ...(data.business_name && client.business_name === 'Unknown business' ? { business_name: data.business_name } : {}),
        plan_interest: data.plan_interest !== 'UNKNOWN'
          ? data.plan_interest
          : (['BASIC', 'PREMIUM', 'ADVANCED'].includes(String(payload.planHint).toUpperCase()) ? String(payload.planHint).toUpperCase() : client.plan_interest),
        requirements: data.requirements || client.requirements,
        preferred_time: data.preferred_time || client.preferred_time,
        ...(!outcomeKnown && data.outcome ? { call_outcome: data.outcome } : {}),
      };
      client = await prisma.client.update({ where: { id: client.id }, data: update });
      summary.parsed = { ...data, source };
      await logAction(client.id, 'TRANSCRIPT_PARSED',
        `via ${source}: plan=${client.plan_interest}, name=${client.contact_name || '—'}, time=${client.preferred_time || '—'}`);
    } catch (err) {
      await logError(client.id, 'TRANSCRIPT_PARSE', err);
    }
  }

  // 2. Outcome-specific automation
  if (client.call_outcome === 'BOOKED') {
    if (client.proposal_sent) {
      await logAction(client.id, 'AUTOMATION_SKIPPED', 'Proposal already sent for this client — not re-sending');
    } else {
      summary.automation = await runBookedAutomation(client, prefs);
    }
    // Write the Claude Code build prompt for this client's website (first booking only).
    const fresh = await prisma.client.findUnique({ where: { id: client.id } });
    if (!fresh.website_prompt) {
      try {
        await generateWebsitePrompt(fresh);
      } catch (err) {
        await logError(client.id, 'WEBSITE_PROMPT', err);
      }
    }
  } else if (client.call_outcome === 'REJECTED' && client.portal_status === 'NEW_LEAD') {
    await prisma.client.update({ where: { id: client.id }, data: { portal_status: 'LOST' } });
  }

  // 3. Campaign stats + completion check
  if (client.campaign_id) {
    const c = await recomputeCampaignStats(client.campaign_id);
    summary.campaign = c;
    if (c && c.expected > 0 && c.processed >= c.expected && !c.summary_call_sent) {
      try {
        await triggerSummaryCall(c.id);
      } catch (err) {
        // already logged in triggerSummaryCall
      }
    }
  }
  return summary;
}

module.exports = {
  recordCall, processCall, runBookedAutomation, recomputeCampaignStats, normalizePayload, normalizeOutcome,
};
