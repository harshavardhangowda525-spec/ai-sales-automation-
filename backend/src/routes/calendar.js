const express = require('express');
const prisma = require('../lib/prisma');
const config = require('../lib/config');

const router = express.Router();

// GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — consultations on the portal calendar (IST dates)
router.get('/', async (req, res, next) => {
  try {
    const from = req.query.from ? new Date(`${req.query.from}T00:00:00+05:30`) : new Date(Date.now() - 7 * 86400000);
    const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999+05:30`) : new Date(Date.now() + 60 * 86400000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return res.status(400).json({ error: 'invalid from/to' });
    const meetings = await prisma.client.findMany({
      where: { meeting_time: { gte: from, lte: to } },
      orderBy: { meeting_time: 'asc' },
      select: {
        id: true, business_name: true, contact_name: true, phone_number: true, plan_interest: true,
        meeting_time: true, meeting_link: true, portal_status: true, proposal_sent: true, requirements: true,
      },
    });
    // Google Calendar events for the same range (skip ones that are already a booked consultation).
    let googleEvents = [];
    let googleError = null;
    try {
      const { listGoogleEvents } = require('../services/googleCalendar');
      const booked = new Set((await prisma.client.findMany({
        where: { calendar_event_id: { not: null } }, select: { calendar_event_id: true },
      })).map((c) => c.calendar_event_id));
      googleEvents = (await listGoogleEvents(from, to)).filter((e) => !booked.has(e.id));
    } catch (err) {
      googleError = err.message;
    }
    res.json({ meetings, google_events: googleEvents, google_connected: config.isConfigured.google, google_error: googleError });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
