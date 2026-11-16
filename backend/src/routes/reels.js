// Dashboard API for the daily Instagram reels (behind ADMIN_TOKEN).
const express = require('express');
const prisma = require('../lib/prisma');
const config = require('../lib/config');
const reels = require('../services/reels');

const router = express.Router();
const OMIT_VIDEO = { video: true }; // true = leave the MP4 bytes out (never send them as JSON)

// GET /api/reels — latest reels + settings
router.get('/', async (req, res, next) => {
  try {
    const list = await prisma.reel.findMany({ orderBy: { day: 'desc' }, take: 30, omit: OMIT_VIDEO });
    res.json({
      reels: list.map(({ video, ...r }) => ({ ...r, video_url: r.video_size ? reels.reelVideoUrl(r) : null })),
      settings: {
        enabled: config.isConfigured.reels,
        instagram_connected: config.isConfigured.instagram || Boolean(await reels.getSetting('instagram_token')),
        instagram_username: await reels.getSetting('instagram_username'),
        repo: config.reels.repo || (await reels.getSetting('reels_repo')),
        prepare_at: `${config.reels.prepareHour}:00`,
        post_at: `${config.reels.postHour}:${String(config.reels.postMinute).padStart(2, '0')}`,
        today: reels.todayIST(),
        today_topic: reels.topicFor(reels.todayIST()),
      },
    });
  } catch (err) { next(err); }
});

// POST /api/reels/make { instructions? } — make today's reel now (or redo it)
router.post('/make', async (req, res, next) => {
  try {
    const reel = await reels.requestReel({ instructions: req.body?.instructions?.trim() || null, source: 'dashboard' });
    res.json({ ok: true, reel: { ...reel, video: undefined } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/:id/approve', async (req, res, next) => {
  try { res.json({ ok: true, reel: { ...(await reels.approveReel(req.params.id, 'dashboard')), video: undefined } }); } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/:id/reject', async (req, res, next) => {
  try {
    const r = await reels.rejectReel(req.params.id, { instructions: req.body?.instructions?.trim() || null, source: 'dashboard' });
    res.json({ ok: true, reel: { ...r, video: undefined } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/reels/:id/post-now — approved/failed reel goes to Instagram right away
router.post('/:id/post-now', async (req, res, next) => {
  try {
    const reel = await prisma.reel.findUnique({ where: { id: req.params.id } });
    if (!reel) return res.status(404).json({ error: 'Reel not found' });
    if (!['ready', 'approved', 'failed'].includes(reel.status) || !reel.video_size) return res.status(409).json({ error: `This reel is ${reel.status}` });
    if (reel.status === 'ready') await prisma.reel.update({ where: { id: reel.id }, data: { status: 'approved', approved_at: new Date() } });
    reels.publishReel(await prisma.reel.findUnique({ where: { id: reel.id } })).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/reels/upload?topic=…  (raw MP4 body, caption in X-Reel-Meta as base64 JSON) — manual/backup upload
router.post('/upload', express.raw({ type: 'video/mp4', limit: '80mb' }), async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length < 10000) return res.status(400).json({ error: 'Send the MP4 as the request body (Content-Type: video/mp4)' });
    const day = reels.todayIST();
    let reel = await prisma.reel.findUnique({ where: { day } });
    if (!reel) reel = await prisma.reel.create({ data: { day, topic: reels.topicFor(day) } });
    if (['posting', 'posted'].includes(reel.status)) return res.status(409).json({ error: `Today's reel is already ${reel.status}` });
    await prisma.reel.update({ where: { id: reel.id }, data: { status: 'generating' } });
    res.json(await reels.handleReelUpload({ reelId: reel.id, video: req.body, meta: req.get('x-reel-meta'), runUrl: req.get('x-run-url') || null }));
  } catch (err) { next(err); }
});

module.exports = router;
