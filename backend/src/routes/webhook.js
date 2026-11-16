const express = require('express');
const config = require('../lib/config');
const { logError } = require('../lib/logger');
const { recordCall, processCall } = require('../services/pipeline');
const { handleOwnerWebhook, buildJarvisContext } = require('../services/ownerCalls');
const prisma = require('../lib/prisma');
const { logAction } = require('../lib/logger');
const { toE164 } = require('../lib/phone');
const { formatMeetingTime } = require('../lib/time');

const router = express.Router();

// Log every Jarvis tool request (without bodies) so tool usage is visible in the activity feed.
router.use((req, res, next) => {
  if (!req.path.startsWith('/sarvam/jarvis-')) return next();
  const src = { ...(req.query || {}), ...(req.body || {}) };
  const tool = req.path.split('/').pop();
  logAction(null, 'JARVIS_TOOL', `Jarvis used ${tool}${callerFrom(src) ? '' : ' (no caller number received)'}`).catch(() => {});
  next();
});

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
/** Caller number from any shape Sarvam may send (incl. on_start: user_information.phone_number). */
function callerFrom(src) {
  const info = src.user_information || src.on_start_input?.user_information || src.input?.on_start_input?.user_information;
  const fromInfo = info?.phone_number ? `${info.country_code ? `+${String(info.country_code).replace(/\D/g, '')}` : ''}${String(info.phone_number).replace(/^0+/, '')}` : '';
  return src.caller || src.user_phone_number || src.caller_phone_number || src.phone_number || src.from || src.From
    || src.user?.phone_number || src.user_config?.user_phone_number || fromInfo || '';
}

async function jarvisContext(req, res) {
  try {
    const src = { ...(req.query || {}), ...(req.body || {}) };
    const raw = callerFrom(src);
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
        const v = { harsha_message: active.data.spoken_message, jarvis_context: context };
        return res.json({ ...v, agent_variables: v, caller_is_owner: 'yes', direction: 'outbound' });
      }
      await logAction(null, 'JARVIS_INBOUND_CALL', 'Sir called Jarvis — latest context loaded');
      const v = { harsha_message: '-', jarvis_context: context };
      return res.json({ ...v, agent_variables: v, caller_is_owner: 'yes', direction: 'inbound' });
    }

    // Jarvis is calling one of sir's contacts on his behalf → give him the relay script.
    const relayVars = await require('../services/relayCalls').activeRelayFor(caller);
    if (relayVars) return res.json({ ...relayVars, agent_variables: relayVars, caller_is_owner: 'no', direction: 'relay' });

    let note = 'unknown number';
    if (caller) {
      const client = await prisma.client.findFirst({ where: { phone_number: caller }, orderBy: { created_at: 'desc' } });
      note = client ? `${client.business_name} (${caller})` : caller;
      await logAction(client?.id || null, 'INBOUND_CALLBACK',
        `${note} called the business number — Jarvis took a message`);
    }
    const notSir = `THE CALLER IS NOT SIR. This is ${note === 'unknown number' ? 'an unknown caller' : note}, `
        + 'probably returning a call from Infinity Web & Apps. Do not share any information about sir, '
        + 'clients, prices or the business pipeline. Politely say you are the assistant at Infinity Web & Apps, '
        + 'ask their name and what they need, say the team will call them back shortly, then end the call.';
    const v = { harsha_message: '-', jarvis_context: notSir };
    return res.json({ ...v, agent_variables: v, caller_is_owner: 'no' });
  } catch (err) {
    await logError(null, 'JARVIS_CONTEXT', err);
    // Fail safe: no business data on errors.
    return res.json({ harsha_message: '-', caller_is_owner: 'no', jarvis_context: 'No information available right now. Take a polite message and say the team will call back.' });
  }
}
const PLAN_TEXT = { BASIC: 'Basic ₹4,999', PREMIUM: 'Premium ₹8,999', ADVANCED: 'Advanced ₹15,000', UNKNOWN: 'plan not decided' };
const STAGE_TEXT = {
  NOT_STARTED: 'not started', PROMPT_READY: 'brief ready', IN_DEVELOPMENT: 'in development',
  IN_REVIEW: 'in review', READY: 'ready, waiting for your OK', DELIVERED: 'delivered',
};
const OUTCOME_TEXT = { BOOKED: 'booked', REJECTED: 'not interested', NO_ANSWER: "didn't pick up", CALLBACK_LATER: 'wants a callback', MANUAL: 'added by you' };

function describeClient(c, { full = false } = {}) {
  const parts = [
    `${c.business_name}${c.contact_name ? ` (${c.contact_name})` : ''}, ${c.phone_number}: ${OUTCOME_TEXT[c.call_outcome]}`,
    PLAN_TEXT[c.plan_interest],
    c.meeting_time ? `meeting ${formatMeetingTime(c.meeting_time)}` : null,
    c.call_outcome === 'BOOKED' ? `quotation ${c.proposal_sent ? 'sent' : 'not sent yet'}` : null,
    c.website_stage !== 'NOT_STARTED' ? `website ${STAGE_TEXT[c.website_stage]}` : null,
    c.website_url || c.website_preview_url ? `site ${c.website_url || c.website_preview_url}` : null,
    c.github_repo ? `code in GitHub repo ${c.github_repo}` : null,
    full && c.preferred_time ? `prefers ${c.preferred_time}` : null,
    full && c.requirements ? `wants: ${c.requirements.replace(/\s*\n+\s*/g, ' ').slice(0, 300)}` : null,
    full && c.notes ? `your notes: ${c.notes.slice(0, 200)}` : null,
  ];
  return parts.filter(Boolean).join('; ');
}

/**
 * Mid-call dashboard lookup for Jarvis (Sarvam API tool "lookup_dashboard").
 * Params: query (client name or topic: today, campaign, pending, websites, callbacks, booked, all)
 *         caller (caller's phone number) — answers only when the caller is the owner.
 */
async function jarvisLookup(req, res) {
  try {
    const src = { ...(req.query || {}), ...(req.body || {}) };
    const raw = callerFrom(src);
    const caller = raw ? toE164(String(raw)) : null;
    const owner = config.ownerPhone ? toE164(config.ownerPhone) : null;
    if (!caller || caller !== owner) {
      return res.json({ answer: 'This information is only for sir. Take a polite message instead.' });
    }
    const q = String(src.query || src.q || '').trim();
    const ql = q.toLowerCase();
    const contact = q ? await require('../services/relayCalls').findContact(ql.replace(/\b(contact|details|number|phone|for|of|s|'s)\b/g, ' ')).catch(() => null) : null;
    if (contact) {
      return res.json({ answer: `${contact.name} is in sir's personal contacts: ${contact.phone}. You can call them for sir (send_whatsapp with message starting "CALL:") or WhatsApp them.` });
    }

    // 1. A specific client by business or contact name
    if (q && !/^(all|everything|summary|today|campaign|pending|approval|website|callback|booked|bookings?|calendar|schedule|meetings?|agenda|tomorrow|week)\b/.test(ql)) {
      const words = q.split(/\s+/).filter((w) => w.length > 2);
      const matches = await prisma.client.findMany({
        where: {
          OR: [
            { business_name: { contains: q, mode: 'insensitive' } },
            { contact_name: { contains: q, mode: 'insensitive' } },
            ...words.map((w) => ({ business_name: { contains: w, mode: 'insensitive' } })),
          ],
        },
        orderBy: { updated_at: 'desc' },
        take: 3,
      });
      if (matches.length) {
        const last = await prisma.callLog.findMany({
          where: { client_id: matches[0].id }, orderBy: { timestamp: 'desc' }, take: 3,
        });
        return res.json({
          answer: matches.map((c) => describeClient(c, { full: true })).join('\n')
            + (last.length ? `\nLatest on ${matches[0].business_name}: ${last.map((l) => l.action.replace(/_/g, ' ').toLowerCase()).join(', ')}.` : ''),
        });
      }
    }

    // 2. Topics
    const lines = [];
    const want = (re) => !q || re.test(ql) || /all|everything|summary/.test(ql);
    if (want(/today|campaign/)) {
      const since = new Date(Date.now() - 24 * 3600000);
      const groups = await prisma.client.groupBy({ by: ['call_outcome'], where: { updated_at: { gt: since } }, _count: { _all: true } });
      const n = (o) => groups.find((g) => g.call_outcome === o)?._count._all || 0;
      lines.push(`Last 24 hours: ${n('BOOKED') + n('REJECTED') + n('NO_ANSWER') + n('CALLBACK_LATER')} calls — ${n('BOOKED')} booked, ${n('CALLBACK_LATER')} callback, ${n('REJECTED')} not interested, ${n('NO_ANSWER')} no answer.`);
      const campaigns = await prisma.campaign.findMany({ orderBy: { created_at: 'desc' }, take: 3 });
      for (const c of campaigns) lines.push(`Campaign ${c.name} (${c.status.toLowerCase()}): ${c.booked} booked, ${c.callback_later} callback, ${c.rejected} rejected, ${c.no_answer} no answer.`);
    }
    if (want(/calendar|schedule|meeting|agenda|tomorrow|week|today/)) {
      const { scheduleText } = require('../services/ownerCalls');
      const sched = await scheduleText({ days: /week/.test(ql) ? 7 : /tomorrow/.test(ql) ? 2 : 7 });
      lines.push(sched ? `Schedule: ${sched}.` : 'Your calendar is clear for the next 7 days.');
    }
        if (want(/booked|booking/)) {
      const booked = await prisma.client.findMany({ where: { call_outcome: 'BOOKED' }, orderBy: { created_at: 'desc' }, take: 10 });
      lines.push(booked.length ? `Booked clients:\n${booked.map((c) => `- ${describeClient(c)}`).join('\n')}` : 'No booked clients yet.');
    }
    if (want(/website/)) {
      const sites = await prisma.client.findMany({ where: { website_stage: { not: 'NOT_STARTED' } }, orderBy: { updated_at: 'desc' }, take: 10 });
      lines.push(sites.length ? `Websites: ${sites.map((c) => `${c.business_name} ${STAGE_TEXT[c.website_stage]}`).join('; ')}.` : 'No websites in progress.');
    }
    if (want(/callback/)) {
      const cb = await prisma.client.findMany({ where: { call_outcome: 'CALLBACK_LATER' }, orderBy: { created_at: 'desc' }, take: 10 });
      lines.push(cb.length ? `Callbacks: ${cb.map((c) => `${c.business_name}${c.preferred_time ? ` (${c.preferred_time})` : ''}`).join(', ')}.` : 'No callbacks pending.');
    }
    if (want(/pending|approval/)) {
      const pending = await prisma.ownerCall.findMany({
        where: { type: { in: ['QUOTATION', 'WEBSITE'] }, status: { in: ['QUEUED', 'NEEDS_MANUAL', 'FAILED'] } },
        include: { client: { select: { business_name: true } } },
      });
      lines.push(pending.length
        ? `Waiting for your approval: ${pending.map((p) => `${p.type === 'QUOTATION' ? 'quotation' : 'website link'} for ${p.client?.business_name}`).join(', ')}.`
        : 'Nothing is waiting for your approval.');
    }
    if (!lines.length) lines.push(`I couldn't find "${q}" in the dashboard.`);
    return res.json({ answer: lines.join('\n').slice(0, 4000) });
  } catch (err) {
    await logError(null, 'JARVIS_LOOKUP', err);
    return res.json({ answer: "I couldn't reach the dashboard just now." });
  }
}
router.get('/sarvam/jarvis-lookup', verifySecret, jarvisLookup);
router.post('/sarvam/jarvis-lookup', verifySecret, jarvisLookup);

// ── Jarvis action tools (only for sir's number) ─────────────────────────────────────────────
const { scheduleGoogleMeet } = require('../services/googleCalendar');
const { sendMeetingMessage } = require('../services/whatsapp');
const { requestBuild, requestDeploy, handleBuildDone, prepareQuotation, approveQuotation, pendingQuotation } = require('../services/claudeBuild');
const { addClient } = require('../services/clientsService');
const waLinked = require('../services/waLinked');
const { istParts, istDate } = require('../lib/time');

function toolInput(req) {
  const src = { ...(req.query || {}), ...(req.body || {}) };
  const raw = callerFrom(src);
  const caller = raw ? toE164(String(raw)) : null;
  const owner = config.ownerPhone ? toE164(config.ownerPhone) : null;
  return { src, isOwner: Boolean(caller && owner && caller === owner) };
}

async function findClient(name) {
  const q = String(name || '').trim();
  if (!q) return null;
  // 1) whole name inside business or contact name; 2) every word present (AND) — never a single shared word.
  const whole = await prisma.client.findFirst({
    where: { OR: [{ business_name: { contains: q, mode: 'insensitive' } }, { contact_name: { contains: q, mode: 'insensitive' } }] },
    orderBy: { updated_at: 'desc' },
  });
  if (whole) return whole;
  const words = q.split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|for|website|site|app|mobile|client)$/i.test(w));
  if (!words.length) return null;
  const all = await prisma.client.findFirst({
    where: { AND: words.map((w) => ({ business_name: { contains: w, mode: 'insensitive' } })) },
    orderBy: { updated_at: 'desc' },
  });
  if (all) return all;
  // 3) speech-to-text often mishears names ("Masil House" for "Muscle House") — closest-sounding name.
  const recent = await prisma.client.findMany({ orderBy: { updated_at: 'desc' }, take: 300, select: { id: true, business_name: true } });
  let best = null;
  for (const c of recent) {
    const score = nameSimilarity(q, c.business_name);
    if (!best || score > best.score) best = { id: c.id, score };
  }
  return best && best.score >= 0.6 ? prisma.client.findUnique({ where: { id: best.id } }) : null;
}

function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** 0..1 — how alike two spoken business names are (ignores spaces, case and "the"). */
function nameSimilarity(a, b) {
  const norm = (x) => String(x || '').toLowerCase().replace(/\b(the|website|site|app)\b/g, '').replace(/[^a-z0-9]/g, '');
  const x = norm(a); const y = norm(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/** The project sir most likely means when he doesn't name one: the only one in progress. */
async function onlyActiveProject() {
  const active = await prisma.client.findMany({
    where: { OR: [{ website_stage: { in: ['PROMPT_READY', 'IN_DEVELOPMENT', 'IN_REVIEW', 'READY'] } }, { build_status: { in: ['requested', 'running', 'deploying'] } }] },
    orderBy: { updated_at: 'desc' }, take: 2,
  });
  return active.length === 1 ? active[0] : null;
}

/** Parse "2026-11-16T16:00", "tomorrow 4pm", "monday 11:30 am", "today 6 pm" into a Date (IST). */
function parseWhen(text, now = new Date()) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})[t ](\d{1,2}):(\d{2})/);
  if (iso) return istDate(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5]);
  const p = istParts(now);
  let dayOffset = null;
  if (/\btoday\b|\btonight\b/.test(t)) dayOffset = 0;
  else if (/\btomorrow\b/.test(t)) dayOffset = 1;
  else if (/day after tomorrow/.test(t)) dayOffset = 2;
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dn = days.findIndex((d) => t.includes(d));
  if (dayOffset === null && dn >= 0) dayOffset = ((dn - p.weekday + 7) % 7) || 7;
  const dm = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  const tm = t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b(?!\s*(?:st|nd|rd|th|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/g);
  let hour = null; let minute = 0;
  for (const m of tm || []) {
    const mm = m.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/);
    let h = +mm[1];
    if (mm[3] === 'pm' && h < 12) h += 12;
    if (mm[3] === 'am' && h === 12) h = 0;
    if (!mm[3] && !mm[2] && h <= 7) h += 12; // "at 4" → 4 PM
    if (h >= 0 && h <= 23) { hour = h; minute = +(mm[2] || 0); }
  }
  if (hour === null) hour = /evening/.test(t) ? 18 : /afternoon/.test(t) ? 15 : /morning/.test(t) ? 10 : null;
  if (hour === null) return null;
  if (dm) {
    const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(dm[2]);
    let d = istDate(p.year, mon, +dm[1], hour, minute);
    if (d < now) d = istDate(p.year + 1, mon, +dm[1], hour, minute);
    return d;
  }
  if (dayOffset === null) dayOffset = 0;
  let d = istDate(p.year, p.month, p.day + dayOffset, hour, minute);
  if (d < now && dayOffset === 0) d = istDate(p.year, p.month, p.day + 1, hour, minute);
  return d;
}

// POST /webhook/sarvam/jarvis-schedule { client, when, notify?, caller }
async function jarvisSchedule(req, res) {
  const { src, isOwner } = toolInput(req);
  if (!isOwner) return res.json({ answer: 'Only sir can schedule meetings.' });
  try {
    const client = await findClient(src.client || src.name);
    if (!client) return res.json({ answer: `I couldn't find a client called "${src.client || src.name}" in the dashboard, sir.` });
    const when = parseWhen(src.when || src.time || src.datetime);
    if (!when) return res.json({ answer: 'What day and time should I book it for, sir?' });
    if (when.getTime() < Date.now()) return res.json({ answer: 'That time has already passed, sir. Which time should I use?' });
    const meet = await scheduleGoogleMeet(client, {}, { startTime: when });
    const fresh = await prisma.client.findUnique({ where: { id: client.id } });
    let told = '';
    const notify = !['false', 'no', '0'].includes(String(src.notify ?? 'true').toLowerCase());
    if (notify) {
      try {
        await sendMeetingMessage(fresh);
        told = ` I've sent ${fresh.contact_name || fresh.business_name} the invite on WhatsApp.`;
      } catch (err) {
        told = ` I couldn't WhatsApp them (${err.message}).`;
      }
    }
    await logAction(client.id, 'JARVIS_SCHEDULED', `Booked by voice for ${formatMeetingTime(meet.scheduledTime)}`);
    return res.json({ answer: `Done, sir. ${fresh.business_name} is booked for ${formatMeetingTime(meet.scheduledTime)} with a Google Meet link, and it's on your calendar.${told}` });
  } catch (err) {
    await logError(null, 'JARVIS_SCHEDULE', err);
    return res.json({ answer: `I couldn't book that, sir: ${err.message}` });
  }
}

// POST /webhook/sarvam/jarvis-whatsapp { client, message, caller }
/** Jarvis calls one of sir's personal contacts and passes on his message. */
async function relayFor(who, message, phone, res) {
  const relayCalls = require('../services/relayCalls');
  const msg = String(message || '').replace(/^\s*call\s*:\s*/i, '').replace(/^\s*(and\s+)?(tell|say to|inform)\s+(her|him|them)\s+(that\s+)?/i, '').trim();
  if (!who) return res.json({ answer: 'Who should I call, sir?' });
  if (!msg) return res.json({ answer: `What should I tell ${who}, sir?` });
  const contact = await relayCalls.findContact(who);
  const digits = String(phone || '').replace(/\D/g, '');
  if (!contact && digits.length < 10) {
    return res.json({ answer: `I don't have a number saved for ${who}, sir. Tell me their number, or add them under Contacts in the dashboard.` });
  }
  try {
    const relay = await relayCalls.callContact({ contact, phone, name: who, message: msg });
    return res.json({ answer: `Calling ${relay.to_name} now, sir. I'll tell them "${msg}" and WhatsApp you what they say.` });
  } catch (err) {
    await logError(null, 'JARVIS_CALL_CONTACT', err);
    return res.json({ answer: `I couldn't place that call, sir: ${err.message}` });
  }
}

async function jarvisWhatsApp(req, res) {
  const { src, isOwner } = toolInput(req);
  if (!isOwner) return res.json({ answer: 'Only sir can send messages.' });
  try {
    const who = src.client || src.name;
    // "CALL: ..." means sir wants a phone call, not a WhatsApp (no separate tool needed in Sarvam).
    if (/^\s*call\s*:/i.test(String(src.message || ''))) return relayFor(who, src.message, src.phone, res);
    // Personal contacts (Mom, Dad…) get the WhatsApp at their own number — they are not clients.
    const contact = await require('../services/relayCalls').findContact(who).catch(() => null);
    if (contact) {
      const message = String(src.message || '').trim();
      if (!message) return res.json({ answer: 'What should the message say, sir?' });
      if (!(await waLinked.hasSession())) return res.json({ answer: 'Your WhatsApp isn\'t linked right now, sir — please link it on the WhatsApp page.' });
      await waLinked.sendText(contact.phone, message);
      await logAction(null, 'WHATSAPP_SENT', `Sent by voice to ${contact.name}: "${message.slice(0, 300)}"`);
      return res.json({ answer: `Sent to ${contact.name} on WhatsApp, sir. If you want me to call ${contact.name} instead, just say so.` });
    }
    const client = await findClient(who);
    if (!client) return res.json({ answer: `I couldn't find a client called "${src.client || src.name}", sir.` });
    const message = String(src.message || '').trim();
    if (!message) return res.json({ answer: 'What should the message say, sir?' });
    if (!(await waLinked.hasSession())) return res.json({ answer: 'Your WhatsApp isn\'t linked right now, sir — please link it on the WhatsApp page.' });
    await waLinked.sendText(client.phone_number, message);
    await logAction(client.id, 'WHATSAPP_SENT', `Sent by voice from your WhatsApp: "${message.slice(0, 300)}"`);
    return res.json({ answer: `Sent to ${client.contact_name || client.business_name} on WhatsApp, sir.` });
  } catch (err) {
    await logError(null, 'JARVIS_WHATSAPP', err);
    return res.json({ answer: `I couldn't send it, sir: ${err.message}` });
  }
}

// POST /webhook/sarvam/jarvis-build { client, kind: website|app, instructions?, caller }
async function jarvisBuild(req, res) {
  const { src, isOwner } = toolInput(req);
  if (!isOwner) return res.json({ answer: 'Only sir can start builds.' });
  const wanted = String(src.client || src.name || src.business_name || '').trim();
  let client = wanted && !/^(-|none|null|my client|the client|it|this|that)$/i.test(wanted)
    ? await findClient(wanted).catch(() => null)
    : await onlyActiveProject().catch(() => null);
  if (!client && !wanted) return res.json({ answer: 'Which business is it for, sir? Give me a name for the project.' });
  // build_project doubles as deploy / send-quotation / call-a-person, so no new tools are needed in the Sarvam editor.
  const intent = `${src.kind || ''} ${src.action || ''} ${src.instructions || ''}`.toLowerCase();
  if (/\breels?\b|instagram/.test(intent)) return reelFor(intent, src, res);
  if (/^\s*(call|phone call|relay)\b/.test(String(src.kind || '').toLowerCase())) {
    const spoken = String(src.instructions || '').replace(/[^\d+]/g, '');
    return relayFor(wanted, src.instructions || src.message, src.phone || (spoken.match(/(?:\+?91)?[6-9]\d{9}/) || [])[0], res);
  }
  const isBuild = /\b(build|rebuild|redo|create|make (a|the|it)|website for|app for|change|update|fix)\b/.test(intent);
  const wantsDeploy = !isBuild && !/\b(quotation|quote|proposal)\b/.test(intent) && /\b(deploy|publish|go live|make it live|put it live|live link|host)\b/.test(intent);
  const wantsQuote = /\b(quotation|quote|proposal|approve|approved)\b/.test(intent);
  if ((wantsDeploy || wantsQuote) && !client) return res.json({ answer: `I couldn't find a client called ${wanted}, sir. Which one do you mean?` });
  if (wantsDeploy) return deployFor(client, res);
  if (wantsQuote) return quotationFor(client, src, res);
  if (['requested', 'running', 'deploying'].includes(client?.build_status)
    && client.build_requested_at && Date.now() - client.build_requested_at.getTime() < 45 * 60000) {
    return res.json({ answer: `${client.business_name} is already ${client.build_status === 'deploying' ? 'deploying' : 'being built'}, sir — I'll call you the moment it's done.` });
  }
  let added = '';
  if (!client) {
    // New project — add it as a client first, with what sir described as the requirements.
    ({ client } = await addClient({
      business_name: wanted, contact_name: src.contact_name, phone: src.phone,
      plan: src.plan, requirements: src.instructions || src.description,
    }, 'Jarvis call (new build)'));
    added = `I've added ${client.business_name} as a new client. `;
  }
  if (!config.isConfigured.claudeBuilds) {
    return res.json({ answer: 'Claude builds aren\'t connected yet, sir — the Claude token or GitHub token is missing on the server.' });
  }
  const k = String(src.kind || '').toLowerCase();
  const kind = /mobile|android|ios|phone/.test(k) ? 'mobile' : /app/.test(k) ? 'app' : 'website';
  // Setup takes a little while; answer now and report on WhatsApp.
  requestBuild(client.id, { kind, instructions: src.instructions || null, source: 'Jarvis call' })
    .catch(async (err) => {
      await logError(client.id, 'CLAUDE_BUILD', err);
      try {
        if (await waLinked.hasSession()) await waLinked.sendText(config.ownerPhone, `⚠️ Sir, I couldn't start the build for ${client.business_name}: ${err.message}`);
      } catch { /* ignore */ }
    });
  const label = { website: 'website', app: 'web app', mobile: 'mobile app' }[kind];
  return res.json({ answer: `Done, sir — ${added}Claude has started building the ${label} for ${client.business_name}. I'll call you when it's built, then just say "deploy it" to put it live.` });
}

async function deployFor(client, res) {
  try {
    await requestDeploy(client.id, { source: 'Jarvis call' });
    return res.json({ answer: `Deploying ${client.business_name} now, sir. In a couple of minutes it'll be on a live link — I'll WhatsApp it to you and give you a call.` });
  } catch (err) {
    return res.json({ answer: `I couldn't deploy ${client.business_name}, sir: ${err.message}.` });
  }
}

async function quotationFor(client, src, res) {
  // Jarvis often puts the number inside the instructions ("send it to 9 9 8 0 8 ...").
  const spoken = String(src.instructions || '').replace(/[^\d+]/g, '');
  const phone = src.phone || src.number || (spoken.match(/(?:\+?91)?[6-9]\d{9}/) || [])[0];
  const text = `${src.kind || ''} ${src.action || ''} ${src.instructions || ''}`.toLowerCase();
  const approving = /approv|confirm|go ahead|yes|send it to (the )?client|send to (the )?client|looks good/.test(text)
    && !/prepare|redo|new quotation|again/.test(text);
  try {
    if (approving && await pendingQuotation(client.id)) {
      const r = await approveQuotation(client.id, { phone, source: 'Jarvis call' });
      return res.json({
        answer: r.waitingForEmail
          ? `Approved, sir. I've messaged ${client.business_name} on ${r.client.phone_number} for their email — the portal with the quotation goes out when they reply.`
          : `Approved and sent, sir. Quotation ${r.number || ''} has gone to ${client.business_name} on WhatsApp, ${r.client.phone_number}.`,
      });
    }
    const r = await prepareQuotation(client.id, { phone, source: 'Jarvis call' });
    return res.json({
      answer: `I've prepared quotation ${r.number} for ${client.business_name} (${r.price}) and sent it to your WhatsApp, sir. It hasn't gone to the client yet — shall I send it to them?`
        + (String(r.client.phone_number).replace(/\D/g, '').length >= 10 ? '' : ' I will also need their phone number.'),
    });
  } catch (err) {
    return res.json({ answer: err.status === 400 ? err.message : `I couldn't do the quotation, sir: ${err.message}.` });
  }
}

/** Reel actions through build_project (approve / redo / reject / make). */
async function reelFor(intent, src, res) {
  const reels = require('../services/reels');
  try {
    if (/reject|skip|cancel|don.?t post|\bno\b/.test(intent)) {
      await reels.rejectReel(null, { source: 'Jarvis call' });
      return res.json({ answer: "Okay sir, I won't post today's reel." });
    }
    if (/redo|again|change|remake|new/.test(intent)) {
      const open = await reels.latestOpenReel();
      await reels.requestReel({ day: open?.day || reels.todayIST(), instructions: src.instructions || 'Make a different, more eye-catching version', source: 'Jarvis call' });
      return res.json({ answer: "Sure sir, Claude is making the reel again with your changes. I'll send it to you on WhatsApp and call you when it's ready." });
    }
    if (/make|create|start|generate/.test(intent) && !/approv|post/.test(intent)) {
      await reels.requestReel({ instructions: src.instructions || null, source: 'Jarvis call' });
      return res.json({ answer: "Claude has started making today's reel, sir. I'll send it to you and call you for approval when it's ready." });
    }
    const r = await reels.approveReel(null, 'Jarvis call');
    const later = r.day === reels.todayIST() && Date.now() < reels.postTimeToday().getTime() ? ' at 7:30 PM' : ' now';
    return res.json({ answer: `Approved, sir. I'll post the reel on Instagram${later} and WhatsApp you the link.` });
  } catch (err) {
    return res.json({ answer: err.status && err.status < 500 ? `${err.message}, sir.` : `I couldn't do that, sir: ${err.message}.` });
  }
}

async function clientFromTool(src) {
  const wanted = String(src.client || src.name || src.business_name || '').trim();
  return wanted && !/^(-|none|null|my client|the client|it|this|that)$/i.test(wanted)
    ? findClient(wanted).catch(() => null)
    : onlyActiveProject().catch(() => null);
}

// POST /webhook/sarvam/jarvis-deploy { client?, caller }
async function jarvisDeploy(req, res) {
  const { src, isOwner } = toolInput(req);
  if (!isOwner) return res.json({ answer: 'Only sir can deploy.' });
  const client = await clientFromTool(src);
  if (!client) return res.json({ answer: 'Which project should I deploy, sir?' });
  return deployFor(client, res);
}

// POST /webhook/sarvam/jarvis-quotation { client?, phone?, caller }
async function jarvisQuotation(req, res) {
  const { src, isOwner } = toolInput(req);
  if (!isOwner) return res.json({ answer: 'Only sir can send quotations.' });
  const client = await clientFromTool(src);
  if (!client) return res.json({ answer: 'Which client should get the quotation, sir?' });
  return quotationFor(client, src, res);
}

// POST /webhook/sarvam/jarvis-add-client { business_name, contact_name?, phone?, plan?, requirements?, notes?, caller }
async function jarvisAddClient(req, res) {
  const { src, isOwner } = toolInput(req);
  if (!isOwner) return res.json({ answer: 'Only sir can add clients.' });
  try {
    let name = src.business_name || src.client || src.name;
    if (!name) return res.json({ answer: "What's the business name, sir?" });
    const rawPhone = src.phone || src.phone_number_client || src.number;
    const digits = String(rawPhone || '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
    if (rawPhone && digits.length !== 10) {
      return res.json({ answer: `That number has ${digits.length} digits, sir — I need all 10. Could you say it again?` });
    }
    // A slightly misheard name of an existing client updates that client instead of adding a new one.
    const known = await findClient(name).catch(() => null);
    if (known && nameSimilarity(name, known.business_name) >= 0.75) name = known.business_name;
    const { client, created } = await addClient({
      business_name: name, contact_name: src.contact_name, phone: rawPhone, email: src.email,
      plan: src.plan, requirements: src.requirements, notes: src.notes,
    }, 'Jarvis call');
    const noPhone = client.phone_number === '-' ? " I don't have their phone number yet — tell me if you want me to add it." : '';
    return res.json({
      answer: created
        ? `Done, sir. I've added ${client.business_name}${client.contact_name ? ` (${client.contact_name})` : ''} to your clients.${noPhone}`
        : `${client.business_name} was already in your clients, sir — I've updated their details${client.phone_number !== '-' ? `; their number is ${client.phone_number}` : ''}.`,
    });
  } catch (err) {
    await logError(null, 'JARVIS_ADD_CLIENT', err);
    return res.json({ answer: `I couldn't add them, sir: ${err.message}` });
  }
}
router.post('/sarvam/jarvis-add-client', verifySecret, jarvisAddClient);

// POST /webhook/sarvam/jarvis-call-contact { contact, message, phone?, caller }
// "Call my mom and tell her I'll be late today."
async function jarvisCallContact(req, res) {
  const { src, isOwner } = toolInput(req);
  if (!isOwner) return res.json({ answer: 'Only sir can ask me to call people.' });
  return relayFor(src.contact || src.name || src.person, src.message, src.phone, res);
}
router.post('/sarvam/jarvis-call-contact', verifySecret, jarvisCallContact);

// POST /webhook/sarvam/jarvis-calendar { title, when, minutes?, client?, caller } — plain calendar entry for sir
async function jarvisCalendar(req, res) {
  const { src, isOwner } = toolInput(req);
  if (!isOwner) return res.json({ answer: 'Only sir can add calendar events.' });
  try {
    const when = parseWhen(src.when || src.time || src.datetime);
    if (!when) return res.json({ answer: 'What day and time should I put it at, sir?' });
    if (when.getTime() < Date.now() - 5 * 60000) return res.json({ answer: 'That time has already passed, sir. Which time should I use?' });
    const client = src.client ? await findClient(src.client).catch(() => null) : null;
    const title = String(src.title || '').trim()
      || (client ? `Meeting: ${client.business_name}${client.contact_name ? ` (${client.contact_name})` : ''}` : 'Meeting');
    const minutes = Math.min(Math.max(Number(src.minutes) || 30, 5), 480);
    const { googleCalendar } = { googleCalendar: require('../services/googleCalendar') };
    await googleCalendar.addCalendarEvent({
      title, start: when, minutes,
      description: client ? `Client: ${client.business_name}${client.contact_name ? `, ${client.contact_name}` : ''}, ${client.phone_number}` : 'Added by Jarvis',
    });
    await logAction(client?.id || null, 'CALENDAR_EVENT_ADDED', `"${title}" at ${formatMeetingTime(when)} (added by Jarvis)`);
    return res.json({ answer: `Done, sir — "${title}" is on your calendar for ${formatMeetingTime(when)}.` });
  } catch (err) {
    await logError(null, 'JARVIS_CALENDAR', err);
    return res.json({ answer: `I couldn't add it to your calendar, sir: ${err.message}` });
  }
}
router.post('/sarvam/jarvis-calendar', verifySecret, jarvisCalendar);
router.post('/sarvam/jarvis-schedule', verifySecret, jarvisSchedule);
router.post('/sarvam/jarvis-whatsapp', verifySecret, jarvisWhatsApp);
router.post('/sarvam/jarvis-build', verifySecret, jarvisBuild);
router.post('/sarvam/jarvis-deploy', verifySecret, jarvisDeploy);
router.post('/sarvam/jarvis-quotation', verifySecret, jarvisQuotation);

// POST /webhook/github/build-done — sent by the Claude build workflow when a run ends
router.post('/github/build-done', verifySecret, async (req, res) => {
  try {
    res.json(await handleBuildDone(req.body || {}));
  } catch (err) {
    await logError(null, 'BUILD_CALLBACK', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/sarvam/jarvis-context', verifySecret, jarvisContext);
router.post('/sarvam/jarvis-context', verifySecret, jarvisContext);

module.exports = router;
module.exports.parseWhen = parseWhen;
module.exports.nameSimilarity = nameSimilarity;
