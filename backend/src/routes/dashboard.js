const express = require('express');
const prisma = require('../lib/prisma');

const router = express.Router();

// GET /api/dashboard
router.get('/', async (req, res, next) => {
  try {
    const [campaigns, outcomes, meetings, proposals, recentClients, activity, total] = await Promise.all([
      prisma.campaign.findMany({ orderBy: { created_at: 'desc' }, take: 20 }),
      prisma.client.groupBy({ by: ['call_outcome'], _count: { _all: true } }),
      prisma.client.count({ where: { meeting_link: { not: null } } }),
      prisma.client.count({ where: { proposal_sent: true } }),
      prisma.client.findMany({
        orderBy: { created_at: 'desc' },
        take: 10,
        select: {
          id: true, business_name: true, contact_name: true, phone_number: true, call_outcome: true,
          plan_interest: true, portal_status: true, meeting_time: true, proposal_sent: true, created_at: true,
        },
      }),
      prisma.callLog.findMany({
        orderBy: { timestamp: 'desc' },
        take: 10,
        include: { client: { select: { id: true, business_name: true } } },
      }),
      prisma.client.count(),
    ]);

    const pendingApprovals = await prisma.ownerCall.findMany({
      where: { type: { in: ['QUOTATION', 'WEBSITE'] }, status: { in: ['QUEUED', 'CALLING', 'NEEDS_MANUAL', 'FAILED'] } },
      orderBy: { created_at: 'desc' },
      take: 20,
      include: { client: { select: { id: true, business_name: true, plan_interest: true } } },
    });
    const stageGroups = await prisma.client.groupBy({ by: ['website_stage'], _count: { _all: true } });
    const count = (o) => outcomes.find((g) => g.call_outcome === o)?._count._all || 0;
    const booked = count('BOOKED');
    const converted = await prisma.client.count({ where: { portal_status: 'CONVERTED' } });

    res.json({
      campaigns,
      active_campaign: campaigns.find((c) => c.status === 'RUNNING') || null,
      total_calls: total,
      total_booked: booked,
      total_rejected: count('REJECTED'),
      total_no_answer: count('NO_ANSWER'),
      total_callback: count('CALLBACK_LATER'),
      meetings_scheduled: meetings,
      proposals_sent: proposals,
      converted,
      conversion_rate: total ? Math.round((booked / total) * 1000) / 10 : 0,
      recent_clients: recentClients,
      recent_activity: activity,
      pending_approvals: pendingApprovals,
      website_stages: Object.fromEntries(stageGroups.map((g) => [g.website_stage, g._count._all])),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
