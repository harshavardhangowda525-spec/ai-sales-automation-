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

// A refresh token saved by the in-app reconnect (/auth/google) wins over GOOGLE_REFRESH_TOKEN.
let savedRefreshToken = null;
async function loadSavedToken() {
  try {
    savedRefreshToken = (await prisma.appSetting.findUnique({ where: { key: 'google_refresh_token' } }))?.value || null;
  } catch { /* keep the env token */ }
  return savedRefreshToken;
}
loadSavedToken();
setInterval(loadSavedToken, 5 * 60000).unref();

function reconnectRedirectUri() {
  return `${config.publicBaseUrl}/oauth2callback`;
}

function getAuthClient() {
  const { clientId, clientSecret, redirectUri, refreshToken } = config.google;
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2.setCredentials({ refresh_token: savedRefreshToken || refreshToken });
  return oauth2;
}

const stateFor = () => crypto.createHmac('sha256', String(config.adminToken || config.google.clientSecret)).update('google-reconnect').digest('hex').slice(0, 32);

/** Google consent URL for reconnecting the calendar (offline access, always re-consent → new refresh token). */
function reconnectUrl() {
  const { clientId, clientSecret } = config.google;
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, reconnectRedirectUri());
  return oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/calendar'], state: stateFor() });
}

async function finishReconnect(code, state) {
  if (state !== stateFor()) throw Object.assign(new Error('Invalid link, start again from /auth/google'), { status: 400 });
  const { clientId, clientSecret } = config.google;
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, reconnectRedirectUri());
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token; remove the app at myaccount.google.com/permissions and try again');
  await prisma.appSetting.upsert({ where: { key: 'google_refresh_token' }, create: { key: 'google_refresh_token', value: tokens.refresh_token }, update: { value: tokens.refresh_token } });
  savedRefreshToken = tokens.refresh_token;
  await logAction(null, 'GOOGLE_RECONNECTED', 'Google Calendar reconnected');
  return true;
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
/** A real video-call link without any API: MEETING_ROOM_URL if set, else a unique Jitsi Meet room. */
function meetingRoomLink(client) {
  if (config.meetingRoomUrl) return config.meetingRoomUrl;
  const slug = String(client.business_name).normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '').slice(0, 30) || 'Client';
  return `https://meet.jit.si/InfinityWebApps-${slug}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Shift forward in 30-minute steps until no other client's consultation overlaps (portal calendar). */
async function findFreePortalSlot(start, clientId) {
  let candidate = new Date(start);
  for (let i = 0; i < 24; i++) {
    const { hour } = istParts(candidate);
    if (hour >= WORK_START && hour < WORK_END) {
      const clash = await prisma.client.count({
        where: {
          id: { not: clientId },
          meeting_time: {
            gt: new Date(candidate.getTime() - DURATION_MIN * 60000),
            lt: new Date(candidate.getTime() + DURATION_MIN * 60000),
          },
        },
      });
      if (!clash) return candidate;
    }
    candidate = new Date(candidate.getTime() + DURATION_MIN * 60000);
  }
  return start;
}

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
    // Portal calendar (no Google): the dashboard is the source of truth for meetings.
    if (!opts.startTime) start = await findFreePortalSlot(start, client.id);
    const link = client.meeting_link && !client.meeting_link.includes('/mock-')
      ? client.meeting_link // keep the same room when rescheduling
      : meetingRoomLink(client);
    await prisma.client.update({
      where: { id: client.id },
      data: { meeting_link: link, meeting_time: start, calendar_event_id: null },
    });
    await logAction(client.id, client.meeting_time ? 'MEET_RESCHEDULED' : 'MEET_SCHEDULED',
      `Consultation on the portal calendar at ${toISTISOString(start)} — ${link}`);
    return { meetLink: link, eventId: null, scheduledTime: start };
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

/**
 * Upcoming items for Jarvis: Google Calendar events (when connected) merged with consultations
 * booked in the dashboard. Returns [{ start: Date, title, link }], soonest first.
 */
async function listUpcomingSchedule({ days = 7 } = {}) {
  const now = new Date();
  const until = new Date(now.getTime() + days * 86400000);
  const items = [];
  const seen = new Set();
  if (config.isConfigured.google) {
    try {
      const { data } = await calendarApi().events.list({
        calendarId: config.google.calendarId,
        timeMin: now.toISOString(),
        timeMax: until.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 30,
      });
      for (const e of data.items || []) {
        const start = e.start?.dateTime ? new Date(e.start.dateTime) : e.start?.date ? new Date(`${e.start.date}T00:00:00+05:30`) : null;
        if (!start) continue;
        items.push({ start, title: e.summary || 'Busy', link: extractMeetLink(e), allDay: !e.start?.dateTime });
        if (e.id) seen.add(e.id);
      }
    } catch (err) {
      // fall back to dashboard meetings only
    }
  }
  const booked = await prisma.client.findMany({
    where: { meeting_time: { gte: now, lte: until } },
    orderBy: { meeting_time: 'asc' },
    select: { business_name: true, meeting_time: true, meeting_link: true, calendar_event_id: true },
  });
  for (const c of booked) {
    if (c.calendar_event_id && seen.has(c.calendar_event_id)) continue;
    items.push({ start: c.meeting_time, title: `Consultation with ${c.business_name}`, link: c.meeting_link });
  }
  return items.sort((a, b) => a.start - b.start);
}

/** Google Calendar events between two dates (for the dashboard's Calendar page). */
async function listGoogleEvents(from, to) {
  if (!config.isConfigured.google) return [];
  const { data } = await calendarApi().events.list({
    calendarId: config.google.calendarId,
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  });
  return (data.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
    id: e.id,
    title: e.summary || '(No title)',
    start: e.start?.dateTime || (e.start?.date ? `${e.start.date}T00:00:00+05:30` : null),
    end: e.end?.dateTime || (e.end?.date ? `${e.end.date}T00:00:00+05:30` : null),
    all_day: !e.start?.dateTime,
    location: e.location || null,
    meet_link: extractMeetLink(e),
    html_link: e.htmlLink || null,
  })).filter((e) => e.start);
}

/** Plain calendar entry for sir (no Meet link, nobody invited). */
async function addCalendarEvent({ title, start, minutes = 30, description }) {
  if (!config.isConfigured.google) throw new Error('Google Calendar is not connected');
  const end = new Date(start.getTime() + minutes * 60000);
  const { data } = await calendarApi().events.insert({
    calendarId: config.google.calendarId,
    requestBody: {
      summary: title,
      description: description || 'Added by Jarvis',
      start: { dateTime: toISTISOString(start), timeZone: TZ },
      end: { dateTime: toISTISOString(end), timeZone: TZ },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
    },
  });
  return data;
}

module.exports = { reconnectUrl, finishReconnect, reconnectRedirectUri, scheduleGoogleMeet, computeStartTime, getAuthClient, listUpcomingSchedule, addCalendarEvent, listGoogleEvents };
