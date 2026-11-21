const express = require('express');
const prisma = require('../lib/prisma');
const { startCampaign, triggerSummaryCall } = require('../services/sarvam');
const { recomputeCampaignStats } = require('../services/pipeline');

const router = express.Router();

// GET /api/campaigns
router.get('/', async (req, res, next) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      orderBy: { created_at: 'desc' },
      include: { _count: { select: { clients: true } } },
    });
    res.json(campaigns.map(({ _count, ...c }) => ({ ...c, processed_calls: _count.clients })));
  } catch (err) {
    next(err);
  }
});

// POST /api/campaign/start  body: { campaign_name, engine?: 'sarvam'|'infinity_voice', cohort_id?, agent_id?, agent_version?, contacts?: [{phone_number, business_name}] }
router.post('/start', async (req, res, next) => {
  try {
    const { campaign_name, cohort_id, agent_id, agent_version, contacts, total_calls } = req.body || {};
    if (!campaign_name) return res.status(400).json({ error: 'campaign_name is required' });
    if (contacts && !Array.isArray(contacts)) return res.status(400).json({ error: 'contacts must be an array' });
    if (req.body.engine === 'infinity_voice') {
      return res.status(201).json(await require('../services/voice/voiceCampaigns').startVoiceCampaign({ campaign_name, contacts: contacts || [] }));
    }
    const result = await startCampaign({ campaign_name, cohort_id, agent_id, agent_version, contacts: contacts || [] });
    if (!contacts?.length && Number(total_calls) > 0) {
      result.campaign = await prisma.campaign.update({
        where: { id: result.campaign.id }, data: { total_calls: Number(total_calls) },
      });
    }
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/campaigns/sync — pull finished campaign calls from Sarvam right now
router.post('/sync', async (req, res, next) => {
  try {
    res.json(await require('../services/campaignCallSync').syncCampaignCalls({ force: true }));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/campaign/:id — only for campaigns that never reached Sarvam and have no calls/clients
router.delete('/:id', async (req, res, next) => {
  try {
    const c = await prisma.campaign.findUnique({ where: { id: req.params.id }, include: { _count: { select: { clients: true } } } });
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    if (c.sarvam_campaign_id || c._count.clients) {
      return res.status(409).json({ error: 'This campaign is live on Sarvam or has calls — it can\'t be deleted, only completed' });
    }
    await prisma.campaign.delete({ where: { id: c.id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/campaign/:id  body: { total_calls?, name? } — set expected number of calls
router.patch('/:id', async (req, res, next) => {
  try {
    const data = {};
    if (req.body.name) data.name = String(req.body.name);
    if (req.body.total_calls !== undefined) data.total_calls = Math.max(0, Number(req.body.total_calls) || 0);
    const campaign = await prisma.campaign.update({ where: { id: req.params.id }, data });
    res.json(campaign);
  } catch (err) {
    next(err);
  }
});

// POST /api/campaign/:id/complete — mark complete now and place the summary call
router.post('/:id/complete', async (req, res, next) => {
  try {
    await recomputeCampaignStats(req.params.id);
    const result = await triggerSummaryCall(req.params.id);
    if (result.skipped) return res.status(409).json({ error: 'Summary call already placed for this campaign' });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
