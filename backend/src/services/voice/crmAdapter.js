// Typed bridge between Infinity Voice and the existing CRM (Client, CallLog, OwnerCall, Google Calendar).
// No duplicate tables: leads/customers ARE Client rows; approvals ARE OwnerCall rows.
const config = require('../../lib/config');
const prisma = require('../../lib/prisma');
const { logAction } = require('../../lib/logger');
const { toE164 } = require('../../lib/phone');
const { istParts, istDate, formatMeetingTime } = require('../../lib/time');

const CALL_START_HOUR = Number(process.env.VOICE_CALL_START_HOUR ?? 10); // IST, outbound only
const CALL_END_HOUR = Number(process.env.VOICE_CALL_END_HOUR ?? 19);
const MAX_ATTEMPTS_PER_WEEK = Number(process.env.VOICE_MAX_ATTEMPTS_PER_WEEK ?? 3);

const CLIENT_FIELDS = {
  id: true, business_name: true, contact_name: true, phone_number: true, email: true, call_outcome: true,
  plan_interest: true, requirements: true, preferred_time: true, meeting_time: true, meeting_link: true,
  proposal_sent: true, portal_status: true, website_stage: true, website_preview_url: true, notes: true,
  voice_consent: true, do_not_call: true, consent_note: true,
};

async function getLead(clientId) {
  return clientId ? prisma.client.findUnique({ where: { id: clientId }, select: CLIENT_FIELDS }) : null;
}

/** Customer by phone (inbound caller ID) — never returns another customer's data. */
async function getCustomer(phone) {
  const e164 = toE164(phone);
  if (!e164) return null;
  return prisma.client.findFirst({ where: { phone_number: e164 }, orderBy: { updated_at: 'desc' }, select: CLIENT_FIELDS });
}

async function getPreviousInteractions(clientId, limit = 8) {
  if (!clientId) return [];
  const [logs, calls] = await Promise.all([
    prisma.callLog.findMany({ where: { client_id: clientId }, orderBy: { timestamp: 'desc' }, take: limit, select: { action: true, details: true, timestamp: true } }),
    prisma.voiceCall.findMany({ where: { client_id: clientId, summary: { not: null } }, orderBy: { created_at: 'desc' }, take: 3, select: { created_at: true, outcome: true, summary: true } }),
  ]);
  return { logs, voice_calls: calls };
}

function inCallingHours(now = new Date()) {
  const { hour, weekday } = istParts(now);
  return weekday !== 0 && hour >= CALL_START_HOUR && hour < CALL_END_HOUR;
}

/**
 * Can the AI place an OUTBOUND call to this person right now? Every reason is returned so the
 * dashboard can show exactly why a call is blocked.
 */
async function getCallEligibility({ clientId = null, phone = null, purpose = 'follow_up', now = new Date(), excludeCallId = null } = {}) {
  const reasons = [];
  const lead = clientId ? await getLead(clientId) : await getCustomer(phone);
  const number = toE164(lead?.phone_number || phone);
  if (!number || number.replace(/\D/g, '').length < 12) reasons.push('No valid Indian mobile number');
  if (!lead) reasons.push('Not a CRM contact — only existing customers/leads can be called');
  if (lead?.do_not_call) reasons.push('Customer opted out (do-not-call)');
  if (lead && !lead.voice_consent) reasons.push('No recorded consent to receive AI calls');
  if (purpose === 'promotional') reasons.push('Unsolicited promotional calls from a personal number are not allowed');
  if (!inCallingHours(now)) reasons.push(`Outside calling hours (${CALL_START_HOUR}:00–${CALL_END_HOUR}:00 IST, Mon–Sat)`);
  if (lead) {
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    // Only real dial attempts count (blocked / cancelled requests never reached the phone).
    const recent = await prisma.voiceCall.count({ where: { client_id: lead.id, direction: 'OUTBOUND', mode: 'LIVE', started_at: { gte: weekAgo } } });
    if (recent >= MAX_ATTEMPTS_PER_WEEK) reasons.push(`Already called ${recent} times this week`);
    const open = await prisma.voiceCall.count({ where: { client_id: lead.id, mode: 'LIVE', ...(excludeCallId ? { id: { not: excludeCallId } } : {}), state: { in: ['QUEUED', 'GATEWAY_READY', 'DIALING', 'RINGING', 'CONNECTED', 'AI_ACTIVE', 'RETRY_PENDING'] } } });
    if (open) reasons.push('A call to this customer is already queued or in progress');
  }
  return { eligible: reasons.length === 0, reasons, phone: number, lead };
}

const PORTAL = ['NEW_LEAD', 'PROPOSAL_SENT', 'MEETING_SCHEDULED', 'CONVERTED', 'LOST'];
async function updateLeadStatus(clientId, status, source = 'Infinity Voice') {
  if (!PORTAL.includes(status)) throw new Error(`Unknown lead status ${status}`);
  const c = await prisma.client.update({ where: { id: clientId }, data: { portal_status: status } });
  await logAction(clientId, 'CLIENT_UPDATED', `Lead status → ${status} (${source})`);
  return c;
}

async function updateQualification(clientId, { requirements, plan_interest, contact_name, email } = {}) {
  const c = await prisma.client.findUnique({ where: { id: clientId } });
  if (!c) throw new Error('Customer not found');
  const plans = ['BASIC', 'PREMIUM', 'ADVANCED'];
  const data = {
    ...(requirements && !String(c.requirements || '').includes(requirements) ? { requirements: [c.requirements, requirements].filter(Boolean).join('\n').slice(0, 4000) } : {}),
    ...(plan_interest && plans.includes(String(plan_interest).toUpperCase()) ? { plan_interest: String(plan_interest).toUpperCase() } : {}),
    ...(contact_name && !c.contact_name ? { contact_name: String(contact_name).slice(0, 120) } : {}),
    ...(email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && !c.email ? { email: String(email).toLowerCase() } : {}),
  };
  if (!Object.keys(data).length) return c;
  return prisma.client.update({ where: { id: clientId }, data });
}

async function addConversationSummary(clientId, summary, callId) {
  if (!clientId || !summary) return;
  await logAction(clientId, 'VOICE_CALL_SUMMARY', `${summary.slice(0, 1500)}${callId ? ` (call ${callId})` : ''}`);
}

/** Free 30-min slots in the next `days` working days, 10:00–19:00 IST, avoiding Google events and booked Meets. */
async function checkCalendarAvailability({ days = 5, durationMin = 30, now = new Date() } = {}) {
  const until = new Date(now.getTime() + days * 86400000);
  const busy = [];
  try {
    const { listGoogleEvents } = require('../googleCalendar');
    for (const e of await listGoogleEvents(now, until)) if (!e.all_day) busy.push([Date.parse(e.start), Date.parse(e.end)]);
  } catch { /* calendar not connected — fall back to CRM meetings only */ }
  const meets = await prisma.client.findMany({ where: { meeting_time: { gte: now, lte: until } }, select: { meeting_time: true } });
  for (const m of meets) busy.push([m.meeting_time.getTime(), m.meeting_time.getTime() + 30 * 60000]);
  const slots = [];
  const today = istParts(now);
  for (let d = 0; d <= days && slots.length < 8; d++) {
    for (const hour of [10, 11, 12, 15, 16, 17, 18]) {
      const start = istDate(today.year, today.month, today.day + d, hour, 0);
      if (istParts(start).weekday === 0 || start.getTime() < now.getTime() + 2 * 3600000) continue;
      const end = start.getTime() + durationMin * 60000;
      if (busy.some(([b0, b1]) => start.getTime() < b1 && end > b0)) continue;
      slots.push({ start: start.toISOString(), label: formatMeetingTime(start) });
      if (slots.filter((s) => s.start.slice(0, 10) === start.toISOString().slice(0, 10)).length >= 2) break;
    }
  }
  return slots;
}

/** Book the free consultation (Google Meet) in a slot from checkCalendarAvailability. */
async function bookAppointment(clientId, startIso) {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime()) || start.getTime() < Date.now() + 30 * 60000) throw new Error('That time is not valid or has passed');
  const free = await checkCalendarAvailability({ days: 14 });
  if (!free.some((s) => Math.abs(Date.parse(s.start) - start.getTime()) < 60000)) throw new Error('That slot is no longer free');
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  const { scheduleGoogleMeet } = require('../googleCalendar');
  const r = await scheduleGoogleMeet(client, {}, { startTime: start });
  if (!['CONVERTED', 'LOST'].includes(client.portal_status)) await prisma.client.update({ where: { id: clientId }, data: { portal_status: 'MEETING_SCHEDULED' } });
  return { meet_link: r.meetLink, time: formatMeetingTime(r.scheduledTime) };
}

async function createFollowUp(clientId, { when, note }) {
  const at = new Date(when);
  if (Number.isNaN(at.getTime())) throw new Error('Follow-up time is not a valid date');
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { business_name: true } });
  try {
    const { addCalendarEvent } = require('../googleCalendar');
    await addCalendarEvent({ title: `📞 Follow up: ${client?.business_name || 'customer'}`, start: at, minutes: 15, description: note || 'Created by Infinity Voice' });
  } catch { /* calendar optional */ }
  await logAction(clientId, 'FOLLOW_UP_CREATED', `${formatMeetingTime(at)} — ${String(note || '').slice(0, 300)}`);
  return { when: at.toISOString(), label: formatMeetingTime(at) };
}

/** Anything the agent must not decide alone → an approval for sir (dashboard + Jarvis call when the line is free). */
async function createApprovalRequest({ clientId, callId, kind, request, details }) {
  const { requestOwnerCall } = require('../ownerCalls');
  const client = clientId ? await prisma.client.findUnique({ where: { id: clientId }, select: { business_name: true, contact_name: true } }) : null;
  const who = client ? `${client.business_name}${client.contact_name ? ` (${client.contact_name})` : ''}` : 'A caller';
  const call = await requestOwnerCall('VOICE_APPROVAL', {
    clientId,
    data: {
      kind, request, details, voice_call_id: callId,
      notice: `${who} is asking for ${kind}: ${request}. Should I approve it?`,
    },
  });
  return { approval_id: call.id };
}

async function saveCallOutcome(call) {
  if (!call.client_id) return;
  const map = { BOOKED: 'BOOKED', NOT_INTERESTED: 'REJECTED', OPT_OUT: 'REJECTED', CALLBACK: 'CALLBACK_LATER', NO_ANSWER: 'NO_ANSWER', BUSY: 'NO_ANSWER' };
  const c = await prisma.client.findUnique({ where: { id: call.client_id } });
  const data = {};
  if (map[call.outcome] && c.call_outcome !== 'BOOKED') data.call_outcome = map[call.outcome];
  if (call.outcome === 'OPT_OUT') Object.assign(data, { do_not_call: true, voice_consent: false, consent_note: `Opted out on an AI call ${new Date().toISOString().slice(0, 10)}` });
  if (Object.keys(data).length) await prisma.client.update({ where: { id: call.client_id }, data });
}

module.exports = {
  getLead, getCustomer, getPreviousInteractions, getCallEligibility, updateLeadStatus, updateQualification,
  addConversationSummary, checkCalendarAvailability, bookAppointment, createFollowUp, createApprovalRequest,
  saveCallOutcome, inCallingHours,
};
