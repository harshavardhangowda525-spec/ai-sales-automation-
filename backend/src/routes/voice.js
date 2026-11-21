// Infinity Voice API.
//   adminRouter   → /api/voice/*            (dashboard; ADMIN_TOKEN)
//   gatewayRouter → /voice-gateway/*        (sir's local voice gateway; VOICE_GATEWAY_TOKEN)
const crypto = require('crypto');
const express = require('express');
const prisma = require('../lib/prisma');
const orch = require('../services/voice/orchestrator');
const crm = require('../services/voice/crmAdapter');
const { runTurn, TOOLS } = require('../services/voice/agentEngine');
const { ClaudeProvider } = require('../services/voice/aiProvider');
const { STATES } = require('../services/voice/stateMachine');

const adminRouter = express.Router();
const gatewayRouter = express.Router();

const ROLES = ['SALES', 'RECEPTIONIST', 'FOLLOW_UP', 'SUPPORT'];
const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

function agentData(b, partial = false) {
  const d = {};
  const s = (k, max = 4000) => { if (b[k] !== undefined) d[k] = b[k] === null ? null : String(b[k]).slice(0, max); };
  s('name', 120); s('personality'); s('voice', 120); s('language', 20); s('greeting', 600); s('objectives'); s('escalation_rules');
  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) throw Object.assign(new Error(`role must be one of ${ROLES.join(', ')}`), { status: 400 });
    d.role = b.role;
  }
  if (b.allowed_tools !== undefined) d.allowed_tools = (Array.isArray(b.allowed_tools) ? b.allowed_tools : []).filter((t) => TOOLS[t]);
  if (b.can_call_out !== undefined) d.can_call_out = Boolean(b.can_call_out);
  if (b.active !== undefined) d.active = Boolean(b.active);
  if (!partial && (!d.name || !d.role || !d.greeting)) throw Object.assign(new Error('name, role and greeting are required'), { status: 400 });
  return d;
}

// ── Status (real health checks only) ──
adminRouter.get('/status', wrap(async (req, res) => {
  await orch.ensureDefaultAgents();
  const gw = await orch.getGatewayStatus();
  const [queued, active, pendingApprovals, lastOk] = await Promise.all([
    prisma.voiceCall.count({ where: { mode: 'LIVE', state: { in: ['QUEUED', 'RETRY_PENDING'] } } }),
    prisma.voiceCall.findFirst({ where: { mode: 'LIVE', state: { in: ['DIALING', 'RINGING', 'CONNECTED', 'AI_ACTIVE', 'ESCALATED'] } }, include: { agent: { select: { name: true } } } }),
    prisma.ownerCall.count({ where: { type: 'VOICE_APPROVAL', status: { in: ['QUEUED', 'CALLING', 'NEEDS_MANUAL'] } } }),
    prisma.voiceCallEvent.findFirst({ where: { type: 'LATENCY' }, orderBy: { at: 'desc' } }),
  ]);
  res.json({
    gateway: gw,
    ai: {
      provider: ClaudeProvider.isConfigured() ? 'claude' : 'mock',
      model: ClaudeProvider.isConfigured() ? (process.env.VOICE_CLAUDE_MODEL || 'claude-opus-5-5') : 'mock (no ANTHROPIC_API_KEY — simulated replies)',
      last_response: lastOk ? { at: lastOk.at, ...(lastOk.data || {}) } : null,
    },
    flags: orch.flags(),
    emergency_stop: await orch.isEmergencyStopped(),
    queue: { queued, active, pending_approvals: pendingApprovals },
    states: STATES,
    tools: Object.keys(TOOLS),
  });
}));

// ── Agents ──
adminRouter.get('/agents', wrap(async (req, res) => {
  await orch.ensureDefaultAgents();
  res.json(await prisma.voiceAgent.findMany({ orderBy: { created_at: 'asc' } }));
}));
adminRouter.post('/agents', wrap(async (req, res) => {
  res.status(201).json(await prisma.voiceAgent.create({ data: agentData(req.body || {}) }));
}));
adminRouter.patch('/agents/:id', wrap(async (req, res) => {
  const cur = await prisma.voiceAgent.findUnique({ where: { id: req.params.id } });
  if (!cur) return res.status(404).json({ error: 'Agent not found' });
  res.json(await prisma.voiceAgent.update({ where: { id: cur.id }, data: { ...agentData(req.body || {}, true), version: cur.version + 1 } }));
}));

// ── Knowledge base ──
adminRouter.get('/knowledge', wrap(async (req, res) => res.json(await prisma.voiceKnowledge.findMany({ orderBy: { created_at: 'asc' } }))));
adminRouter.post('/knowledge', wrap(async (req, res) => {
  const { title, content } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: 'title and content are required' });
  res.status(201).json(await prisma.voiceKnowledge.create({ data: { title: String(title).slice(0, 200), content: String(content).slice(0, 20000) } }));
}));
adminRouter.patch('/knowledge/:id', wrap(async (req, res) => {
  const { title, content, active } = req.body || {};
  res.json(await prisma.voiceKnowledge.update({ where: { id: req.params.id }, data: { ...(title ? { title: String(title).slice(0, 200) } : {}), ...(content ? { content: String(content).slice(0, 20000) } : {}), ...(active !== undefined ? { active: Boolean(active) } : {}) } }));
}));
adminRouter.delete('/knowledge/:id', wrap(async (req, res) => { await prisma.voiceKnowledge.delete({ where: { id: req.params.id } }); res.json({ ok: true }); }));

// ── Calls ──
adminRouter.get('/calls', wrap(async (req, res) => {
  const { mode, direction, outcome, agent_id: agentId } = req.query;
  const calls = await prisma.voiceCall.findMany({
    where: { ...(mode ? { mode } : {}), ...(direction ? { direction } : {}), ...(outcome ? { outcome } : {}), ...(agentId ? { agent_id: agentId } : {}) },
    orderBy: { created_at: 'desc' }, take: 100,
    omit: { ai_messages: true },
    include: { agent: { select: { name: true, role: true } } },
  });
  res.json(calls);
}));
adminRouter.get('/calls/:id', wrap(async (req, res) => {
  const call = await prisma.voiceCall.findUnique({ where: { id: req.params.id }, omit: { ai_messages: true }, include: { agent: true, events: { orderBy: { at: 'asc' }, take: 300 } } });
  if (!call) return res.status(404).json({ error: 'Call not found' });
  res.json(call);
}));
// Simulated call for the test console (no phone, no CRM writes).
adminRouter.post('/calls/simulate', wrap(async (req, res) => {
  const { agent_id: agentId, client_id: clientId, direction } = req.body || {};
  res.status(201).json(await orch.startSimulatedCall({ agentId, clientId: clientId || null, direction: direction === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND' }));
}));
adminRouter.post('/calls/:id/turn', wrap(async (req, res) => {
  const call = await prisma.voiceCall.findUnique({ where: { id: req.params.id } });
  if (!call) return res.status(404).json({ error: 'Call not found' });
  if (call.mode !== 'SIMULATED') return res.status(409).json({ error: 'Text turns from the dashboard are only for simulated calls' });
  if (!['AI_ACTIVE', 'ESCALATED', 'CONNECTED'].includes(call.state)) return res.status(409).json({ error: `Call is ${call.state}` });
  const r = await runTurn(call.id, req.body?.text);
  if (r.endCall) await orch.hangup(call.id, 'agent ended the simulated call');
  const fresh = await prisma.voiceCall.findUnique({ where: { id: call.id }, omit: { ai_messages: true }, include: { events: { where: { type: { in: ['TOOL', 'LATENCY', 'ERROR'] } }, orderBy: { at: 'asc' } } } });
  res.json({ ...r, call: fresh });
}));
// Real outbound call request (queued only if every eligibility rule passes).
adminRouter.post('/calls', wrap(async (req, res) => {
  const { agent_id: agentId, client_id: clientId, purpose } = req.body || {};
  if (!agentId || !clientId) return res.status(400).json({ error: 'agent_id and client_id are required' });
  const r = await orch.requestLiveCall({ agentId, clientId, purpose: purpose || 'follow_up', source: 'dashboard' });
  res.status(r.blocked ? 422 : 201).json(r);
}));
adminRouter.post('/calls/:id/hangup', wrap(async (req, res) => res.json(await orch.hangup(req.params.id))));
adminRouter.post('/emergency-stop', wrap(async (req, res) => res.json(await orch.emergencyStop(req.body?.on !== false))));

// Consent / do-not-call on the existing CRM client
adminRouter.patch('/consent/:clientId', wrap(async (req, res) => {
  const { voice_consent: consent, do_not_call: dnc, note } = req.body || {};
  const c = await prisma.client.update({
    where: { id: req.params.clientId },
    data: {
      ...(consent !== undefined ? { voice_consent: Boolean(consent) } : {}),
      ...(dnc !== undefined ? { do_not_call: Boolean(dnc), ...(dnc ? { voice_consent: false } : {}) } : {}),
      ...(note !== undefined ? { consent_note: String(note).slice(0, 1000) } : {}),
    },
    select: { id: true, voice_consent: true, do_not_call: true, consent_note: true },
  });
  res.json(c);
}));
adminRouter.get('/eligibility/:clientId', wrap(async (req, res) => {
  const e = await crm.getCallEligibility({ clientId: req.params.clientId });
  res.json({ eligible: e.eligible, reasons: e.reasons, phone: e.phone });
}));

// ── Analytics (real data only; simulated calls excluded unless ?include_simulated=1) ──
adminRouter.get('/analytics', wrap(async (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 30 * 86400000);
  const where = { created_at: { gte: since }, ...(req.query.include_simulated ? {} : { mode: 'LIVE' }) };
  const calls = await prisma.voiceCall.findMany({ where, select: { direction: true, state: true, outcome: true, duration_seconds: true, connected_at: true, usage: true, agent_id: true } });
  const connected = calls.filter((c) => c.connected_at);
  const by = (f) => calls.reduce((m, c) => { const k = f(c) || 'none'; m[k] = (m[k] || 0) + 1; return m; }, {});
  const lat = calls.map((c) => c.usage?.avg_latency_ms).filter(Boolean);
  const tokens = calls.reduce((a, c) => ({ input: a.input + (c.usage?.input_tokens || 0), output: a.output + (c.usage?.output_tokens || 0) }), { input: 0, output: 0 });
  // Claude Opus 5.5 list price: $4 / $20 per million input / output tokens (cache reads cheaper — this is an upper estimate).
  const est = (tokens.input * 4 + tokens.output * 20) / 1e6;
  res.json({
    since, total: calls.length,
    inbound: calls.filter((c) => c.direction === 'INBOUND').length,
    outbound: calls.filter((c) => c.direction === 'OUTBOUND').length,
    connected: connected.length,
    answer_rate: calls.length ? Math.round((connected.length / calls.length) * 100) : null,
    avg_duration_s: connected.length ? Math.round(connected.reduce((a, c) => a + (c.duration_seconds || 0), 0) / connected.length) : null,
    by_outcome: by((c) => c.outcome), by_state: by((c) => c.state), by_agent: by((c) => c.agent_id),
    avg_turn_latency_ms: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
    tokens, est_ai_cost_usd: Math.round(est * 100) / 100,
  });
}));

// ── Gateway (token-protected) ──
function gatewayAuth(req, res, next) {
  const token = process.env.VOICE_GATEWAY_TOKEN;
  if (!token) return res.status(503).json({ error: 'VOICE_GATEWAY_TOKEN is not set on the server' });
  const got = Buffer.from((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(401).json({ error: 'Unauthorized' });
  return next();
}
gatewayRouter.use(gatewayAuth);
gatewayRouter.post('/heartbeat', wrap(async (req, res) => res.json(await orch.gatewayHeartbeat(req.body?.status || {}))));
gatewayRouter.post('/events', wrap(async (req, res) => res.json(await orch.gatewayEvent(req.body || {}))));
gatewayRouter.post('/commands/:id/result', wrap(async (req, res) => { await orch.commandResult(req.params.id, req.body || {}); res.json({ ok: true }); }));
gatewayRouter.post('/calls/:id/turn', wrap(async (req, res) => {
  const r = await orch.liveTurn(req.params.id, req.body?.text);
  res.json({ reply: r.reply, end_call: r.endCall, latency_ms: r.latencyMs });
}));

module.exports = { adminRouter, gatewayRouter };
