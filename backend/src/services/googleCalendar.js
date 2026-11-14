const { google } = require('googleapis');
const crypto = require('crypto');
const config = require('../lib/config');
const prisma = require('../lib/prisma');
const { logAction } = require('../lib/logger');
const { istParts, istDate, toISTISOString, TZ } = require('../lib/time');

const DURATION_MIN = 30;
const SLOT_HOURS = { morning: 10, afternoon: 15, evening: 18 };
const WORK_START = 9;
const WORK_END = 20; // last meeting must start before 20:00 IST

function getAuthClient() {
  const { clientId, clientSecret, redirectUri, refreshToken } = config.google;
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

function calendarApi() {
  return google.calendar({ version: 'v3', auth: getAuthClient() });
}

/** Turn the free-text preference into a slot hour (10 AM / 3 PM / 6 PM by default). */
function resolveHour({ preferred_hour, preferred_slot, preferred_time }) {
  if (Number.isInteger(preferred_hour) && preferred_hour >= WORK_START && preferred_hour < WORK_END) {
    return preferred_hour;
  }
  const text = `${preferred_slot || ''} ${preferred_time || ''}`.toLowerCase();
  if (text.includes('evening') || text.includes('night')) return SLOT_HOURS.evening;
  if (text.includes('afternoon')) return SLOT_HOURS.afternoon;
  return SLOT_HOURS.morning;
}

/**
 * Pick the meeting start time: the client's preferred date if valid and in the future, otherwise
 * the next available working day, at morning (10 AM) / afternoon (3 PM) / evening (6 PM) IST.
 */
function computeStartTime(prefs = {}, now = new Date()) {
  const hour = resolveHour(prefs);
  const working = config.google.workingDays;

  if (prefs.preferred_date) {
    const [y, m, d] = prefs.preferred_date.split('-').map(Number);
    const candidate = istDate(y, m - 1, d, hour, 0);
    const wd = istParts(candidate).weekday;
    if (candidate.getTime() > now.getTime() + 2 * 3600000 && working.includes(wd)) return candidate;
  }

  const today = istParts(now);
  for (let offset = 1; offset <= 14; offset++) {
    const candidate = istDate(today.year, today.month, today.day + offset, hour, 0);
    if (working.includes(istParts(candidate).weekday)) return candidate;
  }
  return istDate(today.year, today.month, today.day + 1, hour, 0);
}

/** Shift forward in 30-minute steps until the slot is free on the calendar (best effort). */
async function findFreeSlot(calendar, start) {
  let candidate = new Date(start);
  for (let i = 0; i < 12; i++) {
    const end = new Date(candidate.getTime() + DURATION_MIN * 60000);
    const { hour } = istParts(candidate);
    if (hour >= WORK_START && hour < WORK_END) {
      const fb = await calendar.freebusy.query({
        requestBody: {
          timeMin: candidate.toISOString(),
          timeMax: end.toISOString(),
          timeZone: TZ,
          items: [{ id: config.google.calendarId }],
        },
      });
      const busy = fb.data.calendars?.[config.google.calendarId]?.busy || [];
      if (busy.length === 0) return candidate;
    }
    candidate = new Date(candidate.getTime() + DURATION_MIN * 60000);
  }
  return start; // fall back to the original slot rather than failing
}

function buildEvent(client, start) {
  const end = new Date(start.getTime() + DURATION_MIN * 60000);
  const description = [
    `Free consultation with ${client.contact_name || 'client'} from ${client.business_name}.`,
    `Phone: ${client.phone_number}`,
    `Plan interest: ${client.plan_interest}`,
    '',
    'Requirements (from call transcript):',
    client.requirements || '—',
    '',
    client.proposal_url ? `Proposal: ${client.proposal_url}` : '',
    `Client portal: ${(config.frontendUrls[0] || '')}/clients/${client.id}`,
  ].filter((l) => l !== null).join('\n');

  return {
    summary: `Infinity Web & Apps – ${client.business_name} Free Consultation`,
    description,
    start: { dateTime: toISTISOString(start), timeZone: TZ },
    end: { dateTime: toISTISOString(end), timeZone: TZ },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }, { method: 'popup', minutes: 10 }] },
    conferenceData: {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
  };
}

function extractMeetLink(event) {
  return event.hangoutLink
    || event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri
    || null;
}

/**
 * Create (or move) the 30-min Google Calendar event with a Meet link and save it on the client.
 * @param {object} client Prisma client row
 * @param {object} [prefs] parsed preferences { preferred_slot, preferred_date, preferred_hour, preferred_time }
 * @param {object} [opts] { startTime?: Date } — explicit time (used by reschedule)
 * @returns {Promise<{meetLink: string|null, eventId: string|null, scheduledTime: Date, mock?: boolean}>}
 */
async function scheduleGoogleMeet(client, prefs = {}, opts = {}) {
  let start = opts.startTime ? new Date(opts.startTime) : computeStartTime({
    preferred_time: client.preferred_time, ...prefs,
  });

  if (!config.isConfigured.google) {
    const mockLink = `https://meet.google.com/mock-${client.id.slice(0, 3)}-${client.id.slice(4, 8)}`;
    await prisma.client.update({
      where: { id: client.id },
      data: { meeting_link: mockLink, meeting_time: start, calendar_event_id: null },
    });
    await logAction(client.id, 'MEET_SCHEDULED_MOCK',
      `Google not configured — mock meeting saved for ${toISTISOString(start)}`);
    return { meetLink: mockLink, eventId: null, scheduledTime: start, mock: true };
  }

  const calendar = calendarApi();
  if (!opts.startTime) start = await findFreeSlot(calendar, start);
  const requestBody = buildEvent(client, start);

  let event;
  if (client.calendar_event_id) {
    // Reschedule: move the existing event and keep its Meet link.
    const { conferenceData, ...patch } = requestBody;
    event = (await calendar.events.patch({
      calendarId: config.google.calendarId,
      eventId: client.calendar_event_id,
      requestBody: patch,
      sendUpdates: 'all',
    })).data;
  } else {
    event = (await calendar.events.insert({
      calendarId: config.google.calendarId,
      conferenceDataVersion: 1,
      sendUpdates: 'all',
      requestBody,
    })).data;
  }

  const meetLink = extractMeetLink(event) || client.meeting_link;
  await prisma.client.update({
    where: { id: client.id },
    data: { meeting_link: meetLink, meeting_time: start, calendar_event_id: event.id },
  });
  await logAction(client.id, client.calendar_event_id ? 'MEET_RESCHEDULED' : 'MEET_SCHEDULED',
    `Event ${event.id} at ${toISTISOString(start)} — ${meetLink}`);

  return { meetLink, eventId: event.id, scheduledTime: start };
}

module.exports = { scheduleGoogleMeet, computeStartTime, getAuthClient };
