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
const OUTCOME_TEXT = { BOOKED: 'booked', REJECTED: 'not interested', NO_ANSWER: "didn't pick up", CALLBACK_LATER: 'wants a callback' };

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
const { requestBuild, handleBuildDone } = require('../services/claudeBuild');
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
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  return prisma.client.findFirst({
    where: {
      OR: [
        { business_name: { contains: q, mode: 'insensitive' } },
        { contact_name: { contains: q, mode: 'insensitive' } },
        ...words.map((w) => ({ business_name: { contains: w, mode: 'insensitive' } })),
      ],
    },
    orderBy: { updated_at: 'desc' },
  });
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
async function jarvisWhatsApp(req, res) {
  const { src, isOwner } = toolInput(req);
  if (!isOwner) return res.json({ answer: 'Only sir can send messages.' });
  try {
    const client = await findClient(src.client || src.name);
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
  const client = await findClient(src.client || src.name).catch(() => null);
  if (!client) return res.json({ answer: `I couldn't find a client called "${src.client || src.name}", sir.` });
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
  return res.json({ answer: `On it, sir. Claude is starting the ${label} for ${client.business_name} now — I'll call you when it's built.` });
}

router.post('/sarvam/jarvis-schedule', verifySecret, jarvisSchedule);
router.post('/sarvam/jarvis-whatsapp', verifySecret, jarvisWhatsApp);
router.post('/sarvam/jarvis-build', verifySecret, jarvisBuild);

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
