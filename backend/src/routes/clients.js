const express = require('express');
const prisma = require('../lib/prisma');
const { logAction, logError } = require('../lib/logger');
const { runBookedAutomation } = require('../services/pipeline');
const { scheduleGoogleMeet } = require('../services/googleCalendar');
const { generateProposal } = require('../services/proposalGenerator');
const { sendWhatsAppMessage } = require('../services/whatsapp');
const { requestOwnerCall } = require('../services/ownerCalls');
const { generateWebsitePrompt } = require('../services/websitePrompt');
const { createClientRepo } = require('../services/github');
const STAGES = ['NOT_STARTED', 'PROMPT_READY', 'IN_DEVELOPMENT', 'IN_REVIEW', 'READY', 'DELIVERED'];

const router = express.Router();
const OUTCOMES = ['BOOKED', 'REJECTED', 'NO_ANSWER', 'CALLBACK_LATER'];
const PLANS = ['BASIC', 'PREMIUM', 'ADVANCED', 'UNKNOWN'];
const PORTAL = ['NEW_LEAD', 'PROPOSAL_SENT', 'MEETING_SCHEDULED', 'CONVERTED', 'LOST'];

// GET /api/clients?status=&outcome=&campaign_id=&plan=&q=&from=&to=
// `status` accepts either a call outcome (BOOKED…) or a portal status (CONVERTED…).
router.get('/', async (req, res, next) => {
  try {
    const { status, outcome, campaign_id, plan, q, from, to } = req.query;
    const where = {};
    const s = status?.toUpperCase();
    if (s && OUTCOMES.includes(s)) where.call_outcome = s;
    else if (s && PORTAL.includes(s)) where.portal_status = s;
    if (outcome && OUTCOMES.includes(outcome.toUpperCase())) where.call_outcome = outcome.toUpperCase();
    if (plan && PLANS.includes(plan.toUpperCase())) where.plan_interest = plan.toUpperCase();
    if (campaign_id) where.campaign_id = campaign_id;
    if (from || to) {
      where.created_at = {};
      if (from) where.created_at.gte = new Date(`${from}T00:00:00+05:30`);
      if (to) where.created_at.lte = new Date(`${to}T23:59:59.999+05:30`);
    }
    if (q) {
      where.OR = [
        { business_name: { contains: q, mode: 'insensitive' } },
        { phone_number: { contains: q.replace(/\s/g, '') } },
        { contact_name: { contains: q, mode: 'insensitive' } },
      ];
    }
    const clients = await prisma.client.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 500,
      omit: { transcript: true },
      include: { campaign: { select: { id: true, name: true } } },
    });
    res.json(clients);
  } catch (err) {
    next(err);
  }
});

// GET /api/clients/:id — full details incl. transcript, proposals and all logs
router.get('/:id', async (req, res, next) => {
  try {
    const client = await prisma.client.findUnique({
      where: { id: req.params.id },
      include: {
        campaign: true,
        call_logs: { orderBy: { timestamp: 'desc' } },
        proposals: { orderBy: { created_at: 'desc' }, select: { id: true, number: true, plan: true, created_at: true } },
        owner_calls: { orderBy: { created_at: 'desc' } },
      },
    });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json(client);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/clients/:id — update notes / portal status / plan / contact name
router.patch('/:id', async (req, res, next) => {
  try {
    const { notes, portal_status, plan_interest, contact_name, website_stage, website_preview_url } = req.body;
    const data = {};
    if (website_stage !== undefined) {
      if (!STAGES.includes(website_stage)) return res.status(400).json({ error: 'invalid website_stage' });
      data.website_stage = website_stage;
    }
    if (website_preview_url !== undefined) {
      if (website_preview_url && !/^https?:\/\//.test(website_preview_url)) return res.status(400).json({ error: 'Preview link must start with http:// or https://' });
      data.website_preview_url = website_preview_url || null;
    }
    if (notes !== undefined) data.notes = notes;
    if (portal_status !== undefined) {
      if (!PORTAL.includes(portal_status)) return res.status(400).json({ error: 'invalid portal_status' });
      data.portal_status = portal_status;
    }
    if (plan_interest !== undefined) {
      if (!PLANS.includes(plan_interest)) return res.status(400).json({ error: 'invalid plan_interest' });
      data.plan_interest = plan_interest;
    }
    if (contact_name !== undefined) data.contact_name = contact_name || null;
    const before = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'Client not found' });
    const client = await prisma.client.update({ where: { id: req.params.id }, data });
    const changes = Object.keys(data).filter((k) => k !== 'notes').map((k) => `${k}: ${before[k] ?? '—'} → ${data[k] ?? '—'}`);
    if (changes.length) await logAction(client.id, 'CLIENT_UPDATED', changes.join(', '));
    if (data.notes !== undefined) await logAction(client.id, 'NOTES_UPDATED', 'Notes edited from dashboard');
    res.json(client);
  } catch (err) {
    next(err);
  }
});

// POST /api/clients/:id/resend-proposal — regenerate the PDF and resend on WhatsApp
router.post('/:id/resend-proposal', async (req, res, next) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    await logAction(client.id, 'PROPOSAL_RESEND_REQUESTED', 'Triggered from dashboard');
    const result = await runBookedAutomation(client, {}, { skipApproval: true });
    const updated = await prisma.client.findUnique({ where: { id: client.id } });
    res.status(result.errors.length ? 207 : 200).json({ ok: result.errors.length === 0, result, client: updated });
  } catch (err) {
    await logError(req.params.id, 'PROPOSAL_RESEND', err);
    next(err);
  }
});

// POST /api/clients/:id/reschedule  body: { start_time?: ISO string, preferred_slot?: morning|afternoon|evening, notify?: boolean }
router.post('/:id/reschedule', async (req, res, next) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const { start_time, preferred_slot, notify = true } = req.body || {};
    let startTime;
    if (start_time) {
      startTime = new Date(start_time);
      if (Number.isNaN(startTime.getTime())) return res.status(400).json({ error: 'invalid start_time' });
      if (startTime.getTime() < Date.now()) return res.status(400).json({ error: 'start_time must be in the future' });
    }
    const meet = await scheduleGoogleMeet(client, { preferred_slot }, { startTime });

    let whatsapp = null;
    if (notify) {
      try {
        const proposal = await generateProposal(client);
        const fresh = await prisma.client.findUnique({ where: { id: client.id } });
        whatsapp = await sendWhatsAppMessage(fresh, fresh.proposal_url, fresh.meeting_link, fresh.meeting_time,
          { proposalNumber: proposal.number });
        await prisma.client.update({ where: { id: client.id }, data: { proposal_sent: true } });
      } catch (err) {
        await logError(client.id, 'RESCHEDULE_NOTIFY', err);
      }
    }
    const updated = await prisma.client.update({
      where: { id: client.id },
      data: ['CONVERTED', 'LOST'].includes(client.portal_status) ? {} : { portal_status: 'MEETING_SCHEDULED' },
    });
    res.json({ ok: true, meet, whatsapp, client: updated });
  } catch (err) {
    await logError(req.params.id, 'RESCHEDULE', err);
    next(err);
  }
});

// POST /api/clients/:id/website-prompt — (re)write the Claude Code build prompt
router.post('/:id/website-prompt', async (req, res, next) => {
  try {
    const exists = await prisma.client.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!exists) return res.status(404).json({ error: 'Client not found' });
    const client = await generateWebsitePrompt(req.params.id);
    res.json({ ok: true, client });
  } catch (err) {
    next(err);
  }
});

// POST /api/clients/:id/github-repo — create the client's private repo with CLAUDE.md (or refresh CLAUDE.md)
router.post('/:id/github-repo', async (req, res, next) => {
  try {
    const exists = await prisma.client.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!exists) return res.status(404).json({ error: 'Client not found' });
    const client = await createClientRepo(req.params.id);
    res.json({ ok: true, client });
  } catch (err) {
    await logError(req.params.id, 'GITHUB_REPO', err);
    // Never pass GitHub's 401/403 through: the dashboard treats 401 as "log out".
    const msg = [401, 403].includes(err.status)
      ? `GitHub refused the token (${err.status}) — check GITHUB_TOKEN has Administration + Contents write access`
      : err.message;
    res.status(err.status === 400 ? 400 : 502).json({ error: msg });
  }
});

// GET /api/clients/:id/website-prompt.md — download the prompt (paste into Claude Code / save as CLAUDE.md)
router.get('/:id/website-prompt.md', async (req, res, next) => {
  try {
    const c = await prisma.client.findUnique({ where: { id: req.params.id }, select: { business_name: true, website_prompt: true } });
    if (!c?.website_prompt) return res.status(404).json({ error: 'No build prompt yet' });
    const name = c.business_name.replace(/[^\w-]+/g, '-').replace(/-+/g, '-').toLowerCase();
    res.set({ 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}-website-prompt.md"` });
    res.send(c.website_prompt);
  } catch (err) {
    next(err);
  }
});

// POST /api/clients/:id/website-ready  body: { website_url }
// Saves the link and queues a call asking Harsha to confirm before the client gets it on WhatsApp.
router.post('/:id/website-ready', async (req, res, next) => {
  try {
    const client = await prisma.client.findUnique({ where: { id: req.params.id } });
    if (!client) return res.status(404).json({ error: 'Client not found' });
    let url;
    try {
      url = new URL(String(req.body?.website_url || '').trim()).toString();
    } catch {
      return res.status(400).json({ error: 'Enter a full website link, e.g. https://example.com' });
    }
    if (!/^https?:/.test(url)) return res.status(400).json({ error: 'Website link must start with http:// or https://' });
    await prisma.client.update({ where: { id: client.id }, data: { website_url: url, website_sent: false, website_stage: 'READY' } });
    await logAction(client.id, 'WEBSITE_READY', `Website marked ready: ${url}`);
    const call = await requestOwnerCall('WEBSITE', { clientId: client.id, campaignId: client.campaign_id, data: { website_url: url } });
    res.json({ ok: true, owner_call: call });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
