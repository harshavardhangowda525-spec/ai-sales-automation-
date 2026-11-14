// Calls to Harshavardhan through one Sarvam "assistant" agent:
//   SUMMARY   — end-of-campaign report
//   QUOTATION — "send this quotation to the client?" → on yes, WhatsApp the proposal to the client
//   WEBSITE   — "send the live website link to the client?" → on yes, WhatsApp the link
// Calls are queued and placed one at a time, only during OWNER_CALL_START/END hours (IST).
const config = require('../lib/config');
const prisma = require('../lib/prisma');
const { logAction, logError } = require('../lib/logger');
const { istParts, formatMeetingTime } = require('../lib/time');
const { PLANS } = require('./proposalGenerator');
const { sendWhatsAppMessage, sendWebsiteReadyMessage } = require('./whatsapp');

const OPEN = ['QUEUED', 'CALLING'];

function inCallingHours(now = new Date()) {
  const { hour } = istParts(now);
  return hour >= config.ownerCalls.callStartHour && hour < config.ownerCalls.callEndHour;
}

/** Variables for the assistant agent. Sarvam agent variables are strings; unused ones get "-". */
function buildVariables(call, client) {
  const plan = PLANS[client?.plan_interest];
  const base = {
    call_type: call.type.toLowerCase(), // summary | quotation | website
    business_name: client?.business_name || '-',
    contact_name: client?.contact_name || '-',
    plan_name: plan ? plan.name : 'not decided',
    plan_price: plan ? `${plan.price} rupees` : '-',
    meeting_time: client?.meeting_time ? formatMeetingTime(client.meeting_time) : '-',
    requirements: (client?.requirements || '-').replace(/\s*\n+\s*/g, '; ').slice(0, 400),
    website_url: call.data?.website_url || '-',
    booked_count: '-', booked_names: '-', callback_count: '-', rejected_count: '-', no_answer_count: '-', meets_scheduled: '-',
    campaign_name: '-', total_calls: '-', websites_summary: '-', pending_approvals: '-',
  };
  if (call.type === 'SUMMARY' || call.type === 'UPDATE') Object.assign(base, call.data || {});
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, String(v)]));
}

/**
 * Background facts Jarvis can use to answer Harsha's questions during the call (not read out).
 * Sent as the jarvis_context agent variable.
 */
async function buildJarvisContext() {
  const plans = { BASIC: 'Basic ₹4,999', PREMIUM: 'Premium ₹8,999', ADVANCED: 'Advanced ₹15,000', UNKNOWN: 'plan not decided' };
  const stage = {
    NOT_STARTED: 'not started', PROMPT_READY: 'build prompt ready', IN_DEVELOPMENT: 'in development',
    IN_REVIEW: 'in review', READY: 'ready, waiting for your OK', DELIVERED: 'delivered',
  };
  const campaign = await prisma.campaign.findFirst({ orderBy: { created_at: 'desc' } });
  const booked = await prisma.client.findMany({
    where: { call_outcome: 'BOOKED' }, orderBy: { created_at: 'desc' }, take: 10,
  });
  const callbacks = await prisma.client.findMany({
    where: { call_outcome: 'CALLBACK_LATER' }, orderBy: { created_at: 'desc' }, take: 8,
    select: { business_name: true, contact_name: true, preferred_time: true },
  });
  const pending = await prisma.ownerCall.findMany({
    where: { type: { in: ['QUOTATION', 'WEBSITE'] }, status: { in: ['QUEUED', 'NEEDS_MANUAL', 'FAILED'] } },
    include: { client: { select: { business_name: true } } }, take: 10,
  });
  const lines = [];
  lines.push(campaign
    ? `Latest campaign: ${campaign.name} (${campaign.status.toLowerCase()}): ${campaign.booked} booked, ${campaign.callback_later} callback, ${campaign.rejected} rejected, ${campaign.no_answer} no answer.`
    : 'No campaigns have run yet.');
  if (booked.length) {
    lines.push('Booked clients:');
    for (const c of booked) {
      lines.push(`- ${c.business_name}${c.contact_name ? ` (${c.contact_name})` : ''}: ${plans[c.plan_interest]}; `
        + `meeting ${c.meeting_time ? formatMeetingTime(c.meeting_time) : 'not scheduled'}; `
        + `quotation ${c.proposal_sent ? 'sent' : 'not sent yet'}; website ${stage[c.website_stage]}`
        + `${c.requirements ? `; wants: ${c.requirements.replace(/\s*\n+\s*/g, ' ').slice(0, 160)}` : ''}`);
    }
  } else {
    lines.push('No booked clients yet.');
  }
  if (callbacks.length) {
    lines.push(`Asked for a callback: ${callbacks.map((c) => `${c.business_name}${c.preferred_time ? ` (${c.preferred_time})` : ''}`).join(', ')}.`);
  }
  lines.push(pending.length
    ? `Waiting for your approval: ${pending.map((p) => `${p.type === 'QUOTATION' ? 'quotation' : 'website link'} for ${p.client?.business_name}`).join(', ')}.`
    : 'Nothing is waiting for approval.');
  return lines.join('\n').slice(0, 3500);
}

/** What Jarvis says on the call — written here so the agent doesn't need any extra variables. */
function buildSpokenMessage(call, vars) {
  const num = (v) => Number(v) || 0;
  const parts = [];
  if (call.type === 'UPDATE' || call.type === 'SUMMARY') {
    parts.push(call.type === 'UPDATE'
      ? 'Hello sir, Jarvis here with your update.'
      : 'Hello sir, Jarvis here. Your outreach campaign is wrapped up.');
    if (call.type === 'UPDATE' && vars.campaign_name && vars.campaign_name !== '-') {
      parts.push(num(vars.total_calls) ? `On ${vars.campaign_name}, ${vars.total_calls} calls were made.` : 'No calls have been made yet.');
    }
    if (num(vars.booked_count)) parts.push(`${vars.booked_count} booked: ${vars.booked_names}.`);
    else if (call.type === 'SUMMARY') parts.push('No bookings this time.');
    if (num(vars.meets_scheduled)) parts.push(`${vars.meets_scheduled} Google Meets are scheduled.`);
    if (num(vars.callback_count)) parts.push(`${vars.callback_count} want a callback.`);
    if (num(vars.rejected_count)) parts.push(`${vars.rejected_count} rejected.`);
    if (num(vars.no_answer_count)) parts.push(`${vars.no_answer_count} didn't pick up.`);
    if (call.type === 'UPDATE') parts.push(`Websites: ${vars.websites_summary}.`);
    if (num(vars.pending_approvals)) parts.push(`You have ${vars.pending_approvals} approvals waiting in the dashboard.`);
    parts.push('Anything you want to know more about?');
  } else if (call.type === 'QUOTATION') {
    parts.push(`Hello sir, Jarvis here. A new client booked: ${vars.business_name}${vars.contact_name !== '-' ? `, contact ${vars.contact_name}` : ''}.`);
    parts.push(`They're interested in the ${vars.plan_name} plan${vars.plan_price !== '-' ? ` at ${vars.plan_price}` : ''}.`);
    if (vars.meeting_time !== '-') parts.push(`The consultation is on ${vars.meeting_time}.`);
    parts.push('Should I send them the quotation on WhatsApp? Say yes or no.');
  } else if (call.type === 'WEBSITE') {
    parts.push(`Hello sir, Jarvis here. The website for ${vars.business_name} is ready at ${vars.website_url}.`);
    parts.push(`Should I send the link to ${vars.contact_name !== '-' ? vars.contact_name : 'the client'} on WhatsApp? Say yes or no.`);
  }
  return parts.join(' ');
}

/** Queue a call to Harshavardhan. Returns the OwnerCall row. */
async function requestOwnerCall(type, { clientId = null, campaignId = null, data = null } = {}) {
  // One open approval per client+type is enough — refresh it instead of piling up calls.
  if (clientId && type !== 'SUMMARY') {
    const open = await prisma.ownerCall.findFirst({ where: { client_id: clientId, type, status: { in: [...OPEN, 'NEEDS_MANUAL'] } } });
    if (open) {
      const updated = await prisma.ownerCall.update({ where: { id: open.id }, data: { data: data ?? open.data } });
      return updated;
    }
  }

  const call = await prisma.ownerCall.create({ data: { type, client_id: clientId, campaign_id: campaignId, data } });

  if (!config.isConfigured.ownerCalls) {
    await prisma.ownerCall.update({ where: { id: call.id }, data: { status: ['SUMMARY', 'UPDATE'].includes(type) ? 'DONE' : 'NEEDS_MANUAL', decision_note: 'Assistant agent / owner phone not configured' } });
    await logAction(clientId, `OWNER_CALL_${type}_MOCK`,
      `Call to Harsha not placed (assistant agent, connection or HARSHAVARDHAN_PHONE not configured).${type === 'SUMMARY' ? ` Report: ${JSON.stringify(data)}` : ' Approve it from the dashboard.'}`);
    return call;
  }

  await logAction(clientId, `OWNER_CALL_${type}_QUEUED`,
    type === 'SUMMARY' ? 'Campaign summary call queued'
      : type === 'UPDATE' ? 'Jarvis status call requested — calling now'
        : `Approval call queued${inCallingHours() ? '' : ' — will call during calling hours'}`);
  processQueue().catch((err) => logError(null, 'OWNER_CALL_QUEUE', err));
  return call;
}

async function placeCall(call) {
  // Lazy require avoids a circular import (sarvam.js → ownerCalls.js for summary calls).
  const { placeOutboundCall } = require('./sarvam');
  const client = call.client_id ? await prisma.client.findUnique({ where: { id: call.client_id } }) : null;
  const secret = config.webhookSecret ? `?secret=${encodeURIComponent(config.webhookSecret)}` : '';

  await prisma.ownerCall.update({
    where: { id: call.id },
    data: { status: 'CALLING', attempts: { increment: 1 }, called_at: new Date() },
  });
  try {
    const variables = buildVariables(call, client);
    const message = buildSpokenMessage(call, variables);
    const result = await placeOutboundCall({
      phoneNumber: config.ownerPhone,
      appId: config.sarvam.summaryAgentId,
      appVersion: config.sarvam.summaryAgentVersion,
      variables: { ...variables, harsha_message: message, jarvis_context: await buildJarvisContext() },
      appOverrides: { initial_bot_message: message },
      webhook: {
        url: `${config.publicBaseUrl}/webhook/sarvam/owner${secret}`,
        metadata: { owner_call_id: call.id },
      },
    });
    await prisma.ownerCall.update({ where: { id: call.id }, data: { attempt_id: result.attempt_id || null } });
    await logAction(call.client_id, `OWNER_CALL_${call.type}_PLACED`, `Calling Harsha (attempt ${call.attempts + 1}, Sarvam ${result.attempt_id})`);
  } catch (err) {
    await logError(call.client_id, `OWNER_CALL_${call.type}`, err);
    await scheduleRetryOrManual(call.id, `Call failed: ${err.message}`);
  }
}

async function scheduleRetryOrManual(id, note) {
  const call = await prisma.ownerCall.findUnique({ where: { id } });
  if (call.attempts < config.ownerCalls.maxAttempts) {
    await prisma.ownerCall.update({
      where: { id },
      data: { status: 'QUEUED', decision_note: note, next_attempt_at: new Date(Date.now() + config.ownerCalls.retryMinutes * 60000) },
    });
    await logAction(call.client_id, `OWNER_CALL_${call.type}_RETRY`, `${note} — will call again in ${config.ownerCalls.retryMinutes} min`);
  } else {
    await prisma.ownerCall.update({
      where: { id },
      data: { status: ['SUMMARY', 'UPDATE'].includes(call.type) ? 'DONE' : 'NEEDS_MANUAL', decision_note: note },
    });
    await logAction(call.client_id, `OWNER_CALL_${call.type}_UNANSWERED`,
      ['SUMMARY', 'UPDATE'].includes(call.type) ? `${note} — summary is on the dashboard` : `${note} — approve or reject from the dashboard`);
  }
}

/** Place the next queued call (one at a time) and time out calls whose result never arrived. */
let processing = false;
async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    const timeout = new Date(Date.now() - config.ownerCalls.resultTimeoutMinutes * 60000);
    const stale = await prisma.ownerCall.findMany({ where: { status: 'CALLING', called_at: { lt: timeout } } });
    for (const s of stale) await scheduleRetryOrManual(s.id, 'No call result received');

    if (!config.isConfigured.ownerCalls) return;
    if (await prisma.ownerCall.count({ where: { status: 'CALLING' } })) return;

    // "Call me now" updates go first and ignore calling hours (Harsha asked for them).
    // Then summaries, then approvals in the order they were requested — only during calling hours.
    const due = { status: 'QUEUED', next_attempt_at: { lte: new Date() } };
    let next = await prisma.ownerCall.findFirst({ where: { ...due, type: 'UPDATE' }, orderBy: { created_at: 'asc' } });
    if (!next && inCallingHours()) {
      next = await prisma.ownerCall.findFirst({ where: due, orderBy: [{ type: 'asc' }, { created_at: 'asc' }] });
    }
    if (next) await placeCall(next);
  } finally {
    processing = false;
  }
}

function parseDecision(vars = {}) {
  const raw = String(vars.decision ?? vars.approval ?? vars.approved ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (/^(approved?|yes|send|ok|okay|confirm(ed)?|true|haan|ha)\b/.test(raw)) return 'APPROVED';
  if (/^(reject(ed)?|no|don'?t|do not|hold|cancel|false|nahi|beda)\b/.test(raw)) return 'REJECTED';
  return null;
}

/** Do what Harshavardhan approved. */
async function executeApproved(callId) {
  const call = await prisma.ownerCall.findUnique({ where: { id: callId } });
  const client = call.client_id ? await prisma.client.findUnique({ where: { id: call.client_id } }) : null;
  try {
    if (call.type === 'QUOTATION') {
      if (!client.proposal_url) throw new Error('No proposal generated for this client');
      const latest = await prisma.proposal.findFirst({ where: { client_id: client.id }, orderBy: { created_at: 'desc' } });
      await sendWhatsAppMessage(client, client.proposal_url, client.meeting_link, client.meeting_time, { proposalNumber: latest?.number });
      await prisma.client.update({
        where: { id: client.id },
        data: {
          proposal_sent: true,
          ...(['CONVERTED', 'LOST'].includes(client.portal_status) ? {} : { portal_status: client.meeting_link ? 'MEETING_SCHEDULED' : 'PROPOSAL_SENT' }),
        },
      });
    } else if (call.type === 'WEBSITE') {
      const url = call.data?.website_url || client.website_url;
      if (!url) throw new Error('No website URL recorded');
      await sendWebsiteReadyMessage(client, url);
      await prisma.client.update({ where: { id: client.id }, data: { website_sent: true, website_url: url, website_stage: 'DELIVERED' } });
    }
    await prisma.ownerCall.update({ where: { id: call.id }, data: { status: 'SENT' } });
    return { ok: true };
  } catch (err) {
    await prisma.ownerCall.update({ where: { id: call.id }, data: { status: 'FAILED', decision_note: err.message } });
    await logError(call.client_id, `OWNER_CALL_${call.type}_SEND`, err);
    return { ok: false, error: err.message };
  }
}

/** Approve/reject from the dashboard (or from the call webhook). */
async function decide(callId, decision, note, source = 'dashboard') {
  const call = await prisma.ownerCall.findUnique({ where: { id: callId } });
  if (!call) throw Object.assign(new Error('Approval not found'), { status: 404 });
  if (['SENT', 'CANCELLED', 'DONE'].includes(call.status)) {
    throw Object.assign(new Error(`Already ${call.status.toLowerCase()}`), { status: 409 });
  }
  await prisma.ownerCall.update({
    where: { id: callId },
    data: { status: decision, decided_at: new Date(), decision_note: note || `${decision === 'APPROVED' ? 'Approved' : 'Rejected'} from ${source}` },
  });
  await logAction(call.client_id, `OWNER_${decision}_${call.type}`, `Harsha ${decision === 'APPROVED' ? 'approved' : 'rejected'} on ${source}${note ? `: ${note}` : ''}`);
  const result = decision === 'APPROVED' ? await executeApproved(callId) : { ok: true };
  processQueue().catch(() => {});
  return result;
}

/** Sarvam post-call webhook for calls to Harshavardhan. */
async function handleOwnerWebhook(body = {}) {
  const meta = body.webhook_config?.metadata || body.metadata || {};
  let call = meta.owner_call_id ? await prisma.ownerCall.findUnique({ where: { id: meta.owner_call_id } }) : null;
  if (!call && body.attempt_id) call = await prisma.ownerCall.findFirst({ where: { attempt_id: body.attempt_id } });
  if (!call) return { ignored: true };
  if (call.status !== 'CALLING') return { ignored: true, status: call.status };

  const vars = { ...(body.final_agent_variables || {}), ...(body.output_agent_variables || {}) };
  const connectivity = String(body.status || body.connectivity_status || '').toLowerCase();
  const connected = !connectivity || ['connected', 'completed', 'success'].includes(connectivity);

  if (call.type === 'SUMMARY' || call.type === 'UPDATE') {
    if (connected) {
      await prisma.ownerCall.update({ where: { id: call.id }, data: { status: 'DONE', decided_at: new Date() } });
      await logAction(null, call.type === 'UPDATE' ? 'UPDATE_CALL_DELIVERED' : 'SUMMARY_CALL_DELIVERED',
        `Harsha heard the ${call.type === 'UPDATE' ? 'status update' : 'campaign summary'} (${body.duration ?? '?'}s)`);
    } else {
      await scheduleRetryOrManual(call.id, `${call.type === 'UPDATE' ? 'Update' : 'Summary'} call ${connectivity}`);
    }
    processQueue().catch(() => {});
    return { ok: true };
  }

  if (!connected) {
    await scheduleRetryOrManual(call.id, `Call ${connectivity}${body.failure_reason ? ` (${body.failure_reason})` : ''}`);
    processQueue().catch(() => {});
    return { ok: true, retry: true };
  }

  const decision = parseDecision(vars);
  if (decision) {
    return decide(call.id, decision, vars.note || vars.notes || null, 'the call');
  }
  await prisma.ownerCall.update({ where: { id: call.id }, data: { status: 'NEEDS_MANUAL', decision_note: 'Call connected but no clear yes/no' } });
  await logAction(call.client_id, `OWNER_CALL_${call.type}_UNCLEAR`, 'Harsha didn\'t give a clear yes/no on the call — approve or reject from the dashboard');
  processQueue().catch(() => {});
  return { ok: true, unclear: true };
}

/** Re-queue an approval call (e.g. "call me again" from the dashboard). */
async function retryOwnerCall(callId) {
  const call = await prisma.ownerCall.findUnique({ where: { id: callId } });
  if (!call) throw Object.assign(new Error('Approval not found'), { status: 404 });
  if (!config.isConfigured.ownerCalls) throw Object.assign(new Error('Assistant agent or HARSHAVARDHAN_PHONE not configured'), { status: 400 });
  await prisma.ownerCall.update({ where: { id: callId }, data: { status: 'QUEUED', attempts: 0, next_attempt_at: new Date() } });
  await logAction(call.client_id, `OWNER_CALL_${call.type}_QUEUED`, 'Call requested again from dashboard');
  processQueue().catch(() => {});
}

const STAGE_WORDS = {
  PROMPT_READY: 'build prompt ready', IN_DEVELOPMENT: 'in development', IN_REVIEW: 'in review', READY: 'ready to send', DELIVERED: 'delivered',
};

/** Spoken status for the "Jarvis, call me now" update: latest campaign + website progress. */
async function buildUpdateData() {
  const campaign = await prisma.campaign.findFirst({ orderBy: { created_at: 'desc' } });
  const where = campaign ? { campaign_id: campaign.id } : {};
  const groups = await prisma.client.groupBy({ by: ['call_outcome'], where, _count: { _all: true } });
  const n = (o) => groups.find((g) => g.call_outcome === o)?._count._all || 0;
  const booked = await prisma.client.findMany({ where: { ...where, call_outcome: 'BOOKED' }, select: { business_name: true, meeting_link: true } });

  const sites = await prisma.client.findMany({
    where: { website_stage: { not: 'NOT_STARTED' } },
    orderBy: { updated_at: 'desc' },
    take: 8,
    select: { business_name: true, website_stage: true },
  });
  const websitesSummary = sites.length
    ? sites.map((c) => `${c.business_name} ${STAGE_WORDS[c.website_stage]}`).join('; ')
    : 'no websites in progress yet';
  const pending = await prisma.ownerCall.count({ where: { type: { in: ['QUOTATION', 'WEBSITE'] }, status: { in: ['QUEUED', 'NEEDS_MANUAL', 'FAILED'] } } });

  return {
    campaign_name: campaign?.name || 'no campaign yet',
    total_calls: n('BOOKED') + n('REJECTED') + n('NO_ANSWER') + n('CALLBACK_LATER'),
    booked_count: n('BOOKED'),
    booked_names: booked.map((c) => c.business_name).join(', ') || 'none',
    callback_count: n('CALLBACK_LATER'),
    rejected_count: n('REJECTED'),
    no_answer_count: n('NO_ANSWER'),
    meets_scheduled: booked.filter((c) => c.meeting_link).length,
    websites_summary: websitesSummary,
    pending_approvals: pending,
  };
}

/** "Jarvis, call me now" — calls Harsha immediately (outside calling hours too). */
async function requestUpdateCall() {
  if (!config.isConfigured.ownerCalls) {
    throw Object.assign(new Error('Calls to you are not set up: needs the Sarvam agent, connection and HARSHAVARDHAN_PHONE'), { status: 400 });
  }
  const data = await buildUpdateData();
  // Reuse a status call that is still waiting (e.g. after a failure) instead of calling twice.
  const waiting = await prisma.ownerCall.findFirst({ where: { type: 'UPDATE', status: 'QUEUED' }, orderBy: { created_at: 'desc' } });
  if (waiting) {
    const call = await prisma.ownerCall.update({
      where: { id: waiting.id },
      data: { data, attempts: 0, next_attempt_at: new Date(), decision_note: null },
    });
    await logAction(null, 'OWNER_CALL_UPDATE_QUEUED', 'Jarvis status call requested again — calling now');
    processQueue().catch((err) => logError(null, 'OWNER_CALL_QUEUE', err));
    return { call, data };
  }
  const call = await requestOwnerCall('UPDATE', { data });
  return { call, data };
}

let timer = null;
function startOwnerCallWorker() {
  if (timer) return;
  timer = setInterval(() => processQueue().catch((err) => logError(null, 'OWNER_CALL_QUEUE', err)), 60000);
  timer.unref?.();
  processQueue().catch(() => {});
}

module.exports = {
  requestUpdateCall, buildUpdateData, buildSpokenMessage, buildJarvisContext,
  requestOwnerCall, processQueue, handleOwnerWebhook, decide, retryOwnerCall, startOwnerCallWorker, parseDecision, buildVariables,
};
