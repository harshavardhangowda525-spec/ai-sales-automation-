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
    campaign_name: '-', period: '-', total_calls: '-', websites_summary: '-', pending_approvals: '-', today_schedule: '-', notice: '-',
  };
  if (['SUMMARY', 'UPDATE', 'NOTICE', 'REEL'].includes(call.type)) Object.assign(base, call.data || {});
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, String(v)]));
}

/** "Kaveri Bakery consultation at 4:00 PM; Team call at 6:00 PM" for the next N days (IST). */
async function scheduleText({ days = 7, todayOnly = false } = {}) {
  const { listUpcomingSchedule } = require('./googleCalendar');
  const items = await listUpcomingSchedule({ days }).catch(() => []);
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const fmt = (d, withDay) => new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
    ...(withDay ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
  }).format(d);
  return items
    .filter((i) => !todayOnly || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(i.start) === todayKey)
    .slice(0, 12)
    .map((i) => `${String(i.title).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').trim()} ${i.allDay ? (todayOnly ? '(all day)' : `on ${fmt(i.start, true).split(',').slice(0, 2).join(',')}`) : `at ${fmt(i.start, !todayOnly)}`}`)
    .join('; ');
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
  const projects = await prisma.client.findMany({
    where: { OR: [{ website_stage: { not: 'NOT_STARTED' } }, { github_repo: { not: null } }] },
    orderBy: { updated_at: 'desc' }, take: 8,
  });
  if (projects.length) {
    const bs = {
      requested: 'starting', running: 'Claude is building it right now', success: 'built, not deployed yet (say deploy)',
      failure: 'last build FAILED', deploying: 'deploying to Vercel right now', deployed: 'built and live',
    };
    lines.push('Website / app projects:');
    for (const c of projects) {
      lines.push(`- ${c.business_name}: ${stage[c.website_stage]}${c.build_status ? `; ${bs[c.build_status] || c.build_status}` : ''}`
        + `${c.website_preview_url ? `; live preview ${c.website_preview_url}` : '; no live link yet'}`);
    }
  }
  const reel = await prisma.reel.findFirst({ orderBy: { day: 'desc' }, select: { day: true, status: true, topic: true, ig_permalink: true } }).catch(() => null);
  if (reel) {
    const rs = { generating: 'Claude is making it now', ready: 'READY — waiting for sir\'s approval', approved: 'approved, posts at 7:30 PM', rejected: 'rejected', posting: 'posting now', posted: `posted${reel.ig_permalink ? ` (${reel.ig_permalink})` : ''}`, failed: 'FAILED' };
    lines.push(`Instagram reel for ${reel.day}: ${rs[reel.status] || reel.status}${reel.topic ? ` — topic: ${String(reel.topic).split(/[—:]/)[0].trim()}` : ''}.`);
  }
  const contacts = await prisma.contact.findMany({ orderBy: { name: 'asc' }, take: 15 });
  lines.push(contacts.length
    ? `Sir's personal contacts (NOT clients): ${contacts.map((c) => `${c.name}${c.aliases ? ` (${c.aliases})` : ''}`).join('; ')}.`
    : 'Sir has no personal contacts saved yet.');
  const schedule = await scheduleText({ days: 7 });
  lines.push(schedule ? `Sir's schedule, next 7 days (Google Calendar + booked consultations): ${schedule}.` : "Sir's calendar is clear for the next 7 days.");
  lines.push(pending.length
    ? `Waiting for your approval: ${pending.map((p) => `${p.type === 'QUOTATION' ? 'quotation' : 'website link'} for ${p.client?.business_name}`).join(', ')}.`
    : 'Nothing is waiting for approval.');
  const body = lines.join('\n').slice(0, 3300);
  return `${body}\n\n${JARVIS_RULES}`;
}

// Appended to the context every call, so behaviour can be fixed here without editing the agent in Sarvam.
const JARVIS_RULES = [
  'HOW TO ACT (follow strictly):',
  '- Website/app work has 3 steps, each done with the build_project tool:',
  '  1) BUILD — sir says build / make / rebuild / change the website: call build_project with the client and his instructions. Claude builds it; you call sir when it is built.',
  '  2) DEPLOY — sir says deploy / publish / make it live / send me the link: call build_project with kind = "deploy". It goes live on a preview link; sir gets the link on WhatsApp and you call him.',
  '  3) QUOTATION — two steps. (a) Sir says prepare / send the quotation (or proposal): call build_project with kind = "quotation" (put any phone number sir gives in instructions). It is sent to SIR on WhatsApp only. Then ask: "Shall I send it to the client?" (b) Only when sir clearly says yes / approve / send it to the client: call build_project with kind = "approve quotation". Never send to the client without that yes.',
  '- INSTAGRAM REEL: when sir approves the reel ("yes, post it"), call build_project with kind = "approve reel". To make it again with changes: kind = "redo reel" and instructions = his changes. To skip today: kind = "reject reel". To make one now: kind = "make reel".',
  '- CALLING SOMEONE: you CAN make phone calls. When sir says "call my mom / amma / <name> and tell her …", call send_whatsapp with client = that person (e.g. "Mom") and message = "CALL: " + sir\'s message (e.g. "CALL: I\'ll be late today"). You will phone them and pass it on. Without "CALL:" it is only a WhatsApp. Never add family or friends as clients.',
  '- After any tool call, repeat what the tool answered — that is the truth. If it says something failed or is missing, tell sir exactly that.',
  '- If sir does not name the client and only one project is listed above, use that one — do not ask "which client?". Ask only if several could match, and never ask the same question twice: act on your best guess.',
  '- Speech-to-text mishears names. Map what you hear to the closest name listed above (e.g. "Masil House" = Muscle House). Never create a new client from a misheard name.',
  '- Never say something is done, being deployed or "coordinated" unless a tool just told you so. Never promise to call back except for builds and deploys (those calls are automatic).',
  '- Never invent people or names. Messages for sir go only to sir.',
  '- If sir pauses mid-sentence, wait for him to finish; keep replies short (1-2 sentences).',
].join('\n');

/** What Jarvis says on the call — written here so the agent doesn't need any extra variables. */
function buildSpokenMessage(call, vars) {
  const num = (v) => Number(v) || 0;
  const parts = [];
  if (call.type === 'UPDATE' || call.type === 'SUMMARY') {
    parts.push(call.type === 'UPDATE'
      ? "Here's your update, sir."
      : 'Your outreach campaign is wrapped up, sir.');
    if (call.type === 'UPDATE' && vars.period && vars.period !== '-') {
      parts.push(`${vars.period}, ${vars.total_calls} calls were made.`);
    } else if (call.type === 'UPDATE' && vars.campaign_name && vars.campaign_name !== '-') {
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
    if (vars.today_schedule && vars.today_schedule !== '-') parts.push(`On your calendar today: ${vars.today_schedule}.`);
    parts.push('Anything you want to know more about?');
  } else if (call.type === 'NOTICE') {
    parts.push(call.data?.notice || vars.notice || 'I have an update for you, sir.');
    parts.push('Anything you want me to do about it?');
  } else if (call.type === 'REEL') {
    parts.push(call.data?.notice || "Today's Instagram reel is ready, sir — I've sent it to your WhatsApp.");
    parts.push('Say yes and I will post it, or tell me what to change.');
  } else if (call.type === 'QUOTATION') {
    parts.push(`A new client just booked, sir: ${vars.business_name}${vars.contact_name !== '-' ? `, contact ${vars.contact_name}` : ''}.`);
    parts.push(`They're interested in the ${vars.plan_name} plan${vars.plan_price !== '-' ? ` at ${vars.plan_price}` : ''}.`);
    if (vars.meeting_time !== '-') parts.push(`The consultation is on ${vars.meeting_time}.`);
    parts.push('Should I send them the quotation on WhatsApp? Say yes or no.');
  } else if (call.type === 'WEBSITE') {
    parts.push(`The website for ${vars.business_name} is ready, sir, at ${vars.website_url}.`);
    parts.push(`Should I send the link to ${vars.contact_name !== '-' ? vars.contact_name : 'the client'} on WhatsApp? Say yes or no.`);
  }
  return parts.join(' ');
}

/** Queue a call to Harshavardhan. Returns the OwnerCall row. */
async function requestOwnerCall(type, { clientId = null, campaignId = null, data = null, delayMs = 0 } = {}) {
  // One open approval per client+type is enough — refresh it instead of piling up calls.
  if (clientId && type !== 'SUMMARY') {
    const open = await prisma.ownerCall.findFirst({ where: { client_id: clientId, type, status: { in: [...OPEN, 'NEEDS_MANUAL'] } } });
    if (open) {
      const updated = await prisma.ownerCall.update({ where: { id: open.id }, data: { data: data ?? open.data } });
      return updated;
    }
  }

  const call = await prisma.ownerCall.create({
    data: { type, client_id: clientId, campaign_id: campaignId, data, ...(delayMs ? { next_attempt_at: new Date(Date.now() + delayMs) } : {}) },
  });

  if (!config.isConfigured.ownerCalls) {
    await prisma.ownerCall.update({ where: { id: call.id }, data: { status: ['SUMMARY', 'UPDATE', 'NOTICE'].includes(type) ? 'DONE' : 'NEEDS_MANUAL', decision_note: 'Assistant agent / owner phone not configured' } });
    await logAction(clientId, `OWNER_CALL_${type}_MOCK`,
      `Call to Harsha not placed (assistant agent, connection or HARSHAVARDHAN_PHONE not configured).${type === 'SUMMARY' ? ` Report: ${JSON.stringify(data)}` : ' Approve it from the dashboard.'}`);
    return call;
  }

  await logAction(clientId, `OWNER_CALL_${type}_QUEUED`,
    type === 'SUMMARY' ? 'Campaign summary call queued'
      : type === 'UPDATE' ? 'Jarvis status call requested — calling now'
        : type === 'NOTICE' ? `Jarvis will call you: ${String(data?.notice || '').slice(0, 160)}`
        : `Approval call queued${inCallingHours() ? '' : ' — will call during calling hours'}`);
  processQueue().catch((err) => logError(null, 'OWNER_CALL_QUEUE', err));
  return call;
}

async function placeCall(call) {
  // Automatic updates are refreshed right before dialling so late results are included.
  if (call.type === 'UPDATE' && call.data?.since) {
    const fresh = await buildUpdateData({ since: new Date(call.data.since) });
    call = await prisma.ownerCall.update({ where: { id: call.id }, data: { data: { ...fresh, auto: true, since: call.data.since } } });
  }
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
    // Remember what this call should say, so the agent's on-start tool can fetch it too.
    await prisma.ownerCall.update({ where: { id: call.id }, data: { data: { ...(call.data || {}), spoken_message: message } } });
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
      data: { status: ['SUMMARY', 'UPDATE', 'NOTICE'].includes(call.type) ? 'DONE' : 'NEEDS_MANUAL', decision_note: note },
    });
    await logAction(call.client_id, `OWNER_CALL_${call.type}_UNANSWERED`,
      ['SUMMARY', 'UPDATE', 'NOTICE'].includes(call.type) ? `${note} — details are on the dashboard` : `${note} — approve or reject from the dashboard`);
  }
}

/**
 * Automatic Jarvis update: once business calls have gone quiet for OWNER_UPDATE_QUIET_MINUTES
 * and there are new results since the last update/summary, queue an update call to Harsha.
 */
async function maybeAutoUpdate() {
  if (!config.ownerCalls.autoUpdate || !config.isConfigured.ownerCalls || !inCallingHours()) return;
  const open = await prisma.ownerCall.count({ where: { type: { in: ['UPDATE', 'SUMMARY'] }, status: { in: ['QUEUED', 'CALLING'] } } });
  if (open) return;

  const last = await prisma.ownerCall.findFirst({
    where: { type: { in: ['UPDATE', 'SUMMARY'] }, status: { notIn: ['CANCELLED'] } },
    orderBy: { created_at: 'desc' },
  });
  const since = last?.created_at || new Date(Date.now() - 24 * 3600000);
  const lastCall = await prisma.callLog.findFirst({
    where: { action: 'CALL_RECEIVED', timestamp: { gt: since } },
    orderBy: { timestamp: 'desc' },
  });
  if (!lastCall) return; // nothing new to report
  if (Date.now() - lastCall.timestamp.getTime() < config.ownerCalls.updateQuietMinutes * 60000) return; // session still running

  const data = await buildUpdateData({ since });
  await prisma.ownerCall.create({ data: { type: 'UPDATE', data: { ...data, auto: true, since: since.toISOString() } } });
  await logAction(null, 'OWNER_CALL_UPDATE_QUEUED', `Calling session finished — Jarvis will call with ${data.total_calls} new call results`);
}

/** Mark campaigns finished when Sarvam says they ended, so the summary call fires. */
let lastCampaignPoll = 0;
async function pollSarvamCampaigns() {
  if (!config.isConfigured.sarvam || Date.now() - lastCampaignPoll < 10 * 60000) return;
  lastCampaignPoll = Date.now();
  const running = await prisma.campaign.findMany({ where: { status: 'RUNNING', sarvam_campaign_id: { not: null } } });
  if (!running.length) return;
  const { getSarvamCampaign, triggerSummaryCall } = require('./sarvam');
  const { recomputeCampaignStats } = require('./pipeline');
  for (const c of running) {
    try {
      const remote = await getSarvamCampaign(c.sarvam_campaign_id);
      if (['ended', 'cancelled', 'completed'].includes(String(remote.status).toLowerCase())) {
        await recomputeCampaignStats(c.id);
        await triggerSummaryCall(c.id);
      }
    } catch (err) {
      await logError(null, 'CAMPAIGN_STATUS_POLL', err);
    }
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
    // A call cut off by a server restart before it reached Sarvam (no attempt id) is simply dialled again.
    await prisma.ownerCall.updateMany({
      where: { status: 'CALLING', attempt_id: null, called_at: { lt: new Date(Date.now() - 90 * 1000) } },
      data: { status: 'QUEUED', next_attempt_at: new Date() },
    });

    if (!config.isConfigured.ownerCalls) return;
    await require('./campaignCallSync').syncCampaignCalls().catch((err) => logError(null, 'CAMPAIGN_CALL_SYNC', err));
    await require('./reels').reelsTick().catch((err) => logError(null, 'REELS_TICK', err));
    await pollSarvamCampaigns().catch((err) => logError(null, 'CAMPAIGN_STATUS_POLL', err));
    await maybeAutoUpdate().catch((err) => logError(null, 'AUTO_UPDATE', err));
    if (await prisma.ownerCall.count({ where: { status: 'CALLING' } })) return;

    // "Call me now" updates go first and ignore calling hours (Harsha asked for them).
    // Then summaries, then approvals in the order they were requested — only during calling hours.
    const due = { status: 'QUEUED', next_attempt_at: { lte: new Date() } };
    // Build/deploy news (NOTICE) also goes out right away — sir is waiting for it.
    let next = await prisma.ownerCall.findFirst({ where: { ...due, type: { in: ['UPDATE', 'NOTICE', 'REEL'] } }, orderBy: { created_at: 'asc' } });
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
    if (call.type === 'QUOTATION' && require('./clientPortal').isConfigured()) {
      // Proposal lives in the Client Portal; ask for the email first if we don't have it.
      const r = await require('./clientPortal').deliverApprovedQuotation(client);
      if (r.status === 'asked_email') {
        await prisma.ownerCall.update({ where: { id: call.id }, data: { status: 'SENT', decision_note: 'Asked the client for their email — the portal link goes out when they reply' } });
        return { ok: true, waitingForEmail: true };
      }
    } else if (call.type === 'QUOTATION') {
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
    } else if (call.type === 'REEL') {
      const reel = call.data?.reel_id ? await prisma.reel.findUnique({ where: { id: call.data.reel_id } }) : null;
      if (reel?.status === 'ready') await require('./reels').approveReel(reel.id, 'the call');
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
  if (meta.relay_call_id) return require('./relayCalls').handleRelayWebhook(meta.relay_call_id, body);
  let call = meta.owner_call_id ? await prisma.ownerCall.findUnique({ where: { id: meta.owner_call_id } }) : null;
  if (!call && body.attempt_id) call = await prisma.ownerCall.findFirst({ where: { attempt_id: body.attempt_id } });
  if (!call) return { ignored: true };
  if (call.status !== 'CALLING') return { ignored: true, status: call.status };

  const vars = { ...(body.final_agent_variables || {}), ...(body.output_agent_variables || {}) };
  const connectivity = String(body.status || body.connectivity_status || '').toLowerCase();
  const connected = !connectivity || ['connected', 'completed', 'success'].includes(connectivity);

  if (['SUMMARY', 'UPDATE', 'NOTICE'].includes(call.type)) {
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
async function buildUpdateData({ since = null } = {}) {
  let where;
  let campaignName = null;
  if (since) {
    // Only the businesses called since the last update to Harsha.
    const logs = await prisma.callLog.findMany({
      where: { action: 'CALL_RECEIVED', timestamp: { gt: since }, client_id: { not: null } },
      select: { client_id: true },
    });
    where = { id: { in: [...new Set(logs.map((l) => l.client_id))] } };
  } else {
    const campaign = await prisma.campaign.findFirst({ orderBy: { created_at: 'desc' } });
    where = campaign ? { campaign_id: campaign.id } : {};
    campaignName = campaign?.name || 'no campaign yet';
  }
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

  const todaySchedule = await scheduleText({ days: 1, todayOnly: true });
  return {
    today_schedule: todaySchedule || '-',
    campaign_name: campaignName || '-',
    period: since ? 'Since my last update' : '-',
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
  requestUpdateCall, buildUpdateData, buildSpokenMessage, buildJarvisContext, maybeAutoUpdate, scheduleText,
  requestOwnerCall, processQueue, handleOwnerWebhook, decide, retryOwnerCall, startOwnerCallWorker, parseDecision, buildVariables,
};
