const express = require('express');
const prisma = require('../lib/prisma');
const { decide, retryOwnerCall, requestUpdateCall, buildUpdateData } = require('../services/ownerCalls');

const router = express.Router();

// GET /api/approvals?status=open|all — calls to Harsha (approvals + summaries)
router.get('/', async (req, res, next) => {
  try {
    const where = req.query.status === 'all' ? {} : { status: { in: ['QUEUED', 'CALLING', 'NEEDS_MANUAL', 'FAILED'] } };
    const calls = await prisma.ownerCall.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 100,
      include: { client: { select: { id: true, business_name: true, contact_name: true, plan_interest: true } } },
    });
    res.json(calls);
  } catch (err) {
    next(err);
  }
});

// POST /api/approvals/update-call — "Jarvis, call me now" with calls + website progress
router.post('/update-call', async (req, res, next) => {
  try {
    const { call, data } = await requestUpdateCall();
    res.json({ ok: true, owner_call: call, script_data: data });
  } catch (err) {
    next(err);
  }
});

// GET /api/approvals/update-preview — what the update call would say right now
router.get('/update-preview', async (req, res, next) => {
  try {
    res.json(await buildUpdateData());
  } catch (err) {
    next(err);
  }
});

// POST /api/approvals/:id/approve | /reject   body: { note? }
for (const [action, decision] of [['approve', 'APPROVED'], ['reject', 'REJECTED']]) {
  router.post(`/:id/${action}`, async (req, res, next) => {
    try {
      const result = await decide(req.params.id, decision, req.body?.note);
      const call = await prisma.ownerCall.findUnique({ where: { id: req.params.id } });
      res.status(result.ok ? 200 : 502).json({ ...result, owner_call: call });
    } catch (err) {
      next(err);
    }
  });
}

// POST /api/approvals/:id/call-again
router.post('/:id/call-again', async (req, res, next) => {
  try {
    await retryOwnerCall(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
