// Infinity Voice call orchestrator. Owns the single-SIM line: at most one LIVE call on the phone at a
// time, everything else waits in the queue. The local voice gateway (sir's laptop + POCO C55 over
// Bluetooth HFP) polls for commands and reports phone events; nothing here dials by itself unless
// live calling is explicitly enabled AND the gateway has verified the capability on real hardware.
const prisma = require('../../lib/prisma');
const { logAction, logError } = require('../../lib/logger');
const { toE164 } = require('../../lib/phone');
const crm = require('./crmAdapter');
const { transition, logEvent, ON_LINE, ENDED } = require('./stateMachine');
const { getProvider } = require('./aiProvider');

const GATEWAY_STALE_MS = 45000;
const MAX_ATTEMPTS = 2;
const RETRY_AFTER_MIN = 30;

const flags = () => ({
  liveCalling: process.env.VOICE_LIVE_CALLING === 'true',   // outbound dialing (off until a verified test call)
  autoAnswer: process.env.VOICE_AUTO_ANSWER === 'true',     // AI answers incoming calls
});

async function getSetting(key) { return (await prisma.appSetting.findUnique({ where: { key } }))?.value ?? null; }
async function setSetting(key, value) { await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } }); }

async function isEmergencyStopped() { return (await getSetting('voice_emergency_stop')) === 'on'; }

// ── Default agents (created once; editable in Agent Studio) ──
const DEFAULT_AGENTS = [
  {
    name: 'Jarvis — Receptionist', role: 'RECEPTIONIST', can_call_out: false,
    greeting: 'Hello! Thank you for calling Infinity Web and Apps. This is Jarvis, how can I help you today?',
    personality: 'Warm, calm and professional. Speaks like a helpful front-desk person from Bengaluru.',
    objectives: 'Answer enquiries, capture the caller\'s name, business and needs, and book a free 15-minute consultation with the founder.',
    allowed_tools: ['check_availability', 'book_appointment', 'update_qualification', 'create_follow_up'],
  },
  {
    name: 'Jarvis — Follow-Up', role: 'FOLLOW_UP', can_call_out: true,
    greeting: 'Hello! This is Jarvis from Infinity Web and Apps, following up as promised. Is this a good time for a quick chat?',
    personality: 'Friendly and respectful of the customer\'s time.',
    objectives: 'Follow up on proposals or consultations the customer agreed to, answer questions, update the CRM and book next steps.',
    allowed_tools: ['check_availability', 'book_appointment', 'update_qualification', 'create_follow_up'],
  },
  {
    name: 'Jarvis — Sales', role: 'SALES', can_call_out: true,
    greeting: 'Hello! This is Jarvis calling from Infinity Web and Apps in Bengaluru. We build websites and automation for local businesses. Is this a good time for two minutes?',
    personality: 'Confident, upbeat, never pushy.',
    objectives: 'Cold calls and warm leads. Open by saying who you are and why you are calling, and ask if it is a good time. Find out what their business does and whether they have a website; explain our plans and prices, handle objections, and book a free 15-minute Google Meet with the founder. If asked, say you are an AI assistant. If they say not interested or stop calling, apologise, record_opt_out and end the call politely.',
    allowed_tools: ['check_availability', 'book_appointment', 'update_qualification', 'create_follow_up'],
  },
  {
    name: 'Jarvis — Support', role: 'SUPPORT', can_call_out: false,
    greeting: 'Hello! This is Jarvis from Infinity Web and Apps support. What can I help you with?',
    personality: 'Patient and clear.',
    objectives: 'Answer common questions about the customer\'s website or app; escalate anything you cannot solve.',
    allowed_tools: ['update_qualification', 'create_follow_up'],
  },
];

const OLD_SALES_GREETING = 'Hello! This is Jarvis from Infinity Web and Apps, Bengaluru. Thank you for your interest — do you have two minutes?';
async function ensureDefaultAgents() {
  if (await prisma.voiceAgent.count()) {
    // Upgrade the untouched default Sales agent to the cold-call script (edited agents are left alone).
    const sales = DEFAULT_AGENTS.find((a) => a.role === 'SALES');
    await prisma.voiceAgent.updateMany({ where: { role: 'SALES', greeting: OLD_SALES_GREETING }, data: { greeting: sales.greeting, objectives: sales.objectives } });
    return;
  }
  for (const a of DEFAULT_AGENTS) await prisma.voiceAgent.create({ data: { ...a, voice: null, language: 'en-IN' } });
}

// ── Gateway status ──
async function getGatewayStatus() {
  const raw = await getSetting('voice_gateway_status');
  let s = null;
  try { s = raw ? JSON.parse(raw) : null; } catch { s = null; }
  const online = Boolean(s?.last_seen && Date.now() - Date.parse(s.last_seen) < GATEWAY_STALE_MS);
  return { online, ...(s || {}), capabilities: s?.capabilities || {}, health: s?.health || {} };
}

function verified(status, cap) {
  return status.capabilities?.[cap] === 'VERIFIED';
}

// ── Call creation ──
async function startSimulatedCall({ agentId, clientId = null, direction = 'INBOUND' }) {
  const agent = await prisma.voiceAgent.findUnique({ where: { id: agentId } });
  if (!agent) throw Object.assign(new Error('Agent not found'), { status: 404 });
  let call = await prisma.voiceCall.create({ data: { agent_id: agent.id, client_id: clientId, direction, mode: 'SIMULATED', transcript: [{ role: 'agent', text: agent.greeting, final: true, at: new Date().toISOString() }] } });
  call = await transition(call, 'CONNECTED', { reason: 'simulated call (no phone)' });
  call = await transition(call, 'AI_ACTIVE');
  return { call, greeting: agent.greeting };
}

/** Ask for a real outbound call. It is queued only if every eligibility rule passes. */
async function requestLiveCall({ agentId, clientId, purpose = 'follow_up', source = 'dashboard' }) {
  const agent = await prisma.voiceAgent.findUnique({ where: { id: agentId } });
  if (!agent?.active) throw Object.assign(new Error('Agent not found or inactive'), { status: 404 });
  const cold = purpose === 'cold';
  let call = await prisma.voiceCall.create({ data: {
    agent_id: agent.id, client_id: clientId, direction: 'OUTBOUND', mode: 'LIVE', purpose,
    authorization_ref: cold ? crm.coldCalling().ref : null,
  } });
  call = await transition(call, 'ELIGIBILITY_CHECK', { reason: `requested from ${source}` });
  const e = await crm.getCallEligibility({ clientId, purpose });
  const reasons = [...e.reasons];
  if (!agent.can_call_out) reasons.push(`${agent.name} is not allowed to make outbound calls`);
  if (!flags().liveCalling) reasons.push('Live calling is disabled until a verified test call (VOICE_LIVE_CALLING)');
  if (await isEmergencyStopped()) reasons.push('Emergency stop is on');
  if (reasons.length) {
    call = await transition(call, 'BLOCKED', { reason: reasons.join('; '), data: { error: reasons.join('; '), phone: e.phone } });
    return { call, blocked: true, reasons };
  }
  call = await transition(call, 'QUEUED', { data: { phone: e.phone } });
  tick().catch(() => {});
  return { call, blocked: false, reasons: [] };
}

async function enqueueCommand(callId, command, payload = {}) {
  return prisma.voiceGatewayCommand.create({ data: { call_id: callId, command, payload } });
}

async function activeLiveCall() {
  return prisma.voiceCall.findFirst({ where: { mode: 'LIVE', state: { in: [...ON_LINE, 'GATEWAY_READY'] } }, orderBy: { created_at: 'asc' } });
}

/** Move the queue forward: retries due → queued; one queued call → dial (when everything allows it). */
// Serialized: overlapping callers wait for the running pass and then run their own.
let tickChain = Promise.resolve();
function tick() {
  tickChain = tickChain.then(tickOnce, tickOnce);
  return tickChain;
}
async function tickOnce() {
  try {
    await prisma.voiceCall.updateMany({ where: { state: 'RETRY_PENDING', next_attempt_at: { lte: new Date() } }, data: { state: 'QUEUED' } });
    // Stale commands the gateway never picked up are expired, never replayed later by surprise.
    await prisma.voiceGatewayCommand.updateMany({ where: { status: 'pending', created_at: { lt: new Date(Date.now() - 2 * 60000) } }, data: { status: 'expired' } });
    if (await isEmergencyStopped() || !flags().liveCalling) return;
    const gw = await getGatewayStatus();
    if (!gw.online || !verified(gw, 'call_initiation') || gw.health?.call_active) return;
    if (await activeLiveCall()) return; // single SIM: one call at a time
    const next = await prisma.voiceCall.findFirst({ where: { mode: 'LIVE', direction: 'OUTBOUND', state: 'QUEUED' }, orderBy: { created_at: 'asc' } });
    if (!next) return;
    const e = await crm.getCallEligibility({ clientId: next.client_id, purpose: next.purpose, excludeCallId: next.id });
    if (!e.eligible) {
      await transition(next, 'CANCELLED', { reason: `no longer eligible: ${e.reasons.join('; ')}`, data: { error: e.reasons.join('; ') } });
      return;
    }
    let call = await transition(next, 'GATEWAY_READY');
    await enqueueCommand(call.id, 'DIAL', { number: toE164(call.phone) });
    call = await transition(call, 'DIALING', { data: { attempts: call.attempts + 1 } });
  } catch (err) {
    await logError(null, 'VOICE_TICK', err);
  }
}

// ── Gateway protocol ──
async function gatewayHeartbeat(status = {}) {
  const s = { ...status, last_seen: new Date().toISOString() };
  await setSetting('voice_gateway_status', JSON.stringify(s).slice(0, 20000));
  await tick();
  const commands = await prisma.voiceGatewayCommand.findMany({ where: { status: 'pending' }, orderBy: { created_at: 'asc' }, take: 5 });
  if (commands.length) await prisma.voiceGatewayCommand.updateMany({ where: { id: { in: commands.map((c) => c.id) } }, data: { status: 'sent' } });
  return {
    commands: commands.map((c) => ({ id: c.id, call_id: c.call_id, command: c.command, payload: c.payload })),
    config: { ...flags(), emergency_stop: await isEmergencyStopped() },
  };
}

async function commandResult(commandId, { ok, error = null, result = null }) {
  const cmd = await prisma.voiceGatewayCommand.update({ where: { id: commandId }, data: { status: ok ? 'done' : 'failed', result: { error, result } } });
  if (!ok && cmd.call_id) {
    const call = await prisma.voiceCall.findUnique({ where: { id: cmd.call_id } });
    if (call && !ENDED.has(call.state) && call.state !== 'CRM_SYNCED') {
      await transition(call, 'FAILED', { reason: `${cmd.command} failed: ${error}`, data: { error: String(error).slice(0, 500) } }).catch(() => {});
      await finalize(cmd.call_id);
    }
  }
  return cmd;
}

/**
 * Phone event from the gateway (PipeWire telephony call states):
 *   incoming | dialing | alerting | active | disconnected   (+ number, call_id when known, reason)
 */
async function gatewayEvent(e = {}) {
  const type = String(e.type || '').toLowerCase();
  let call = e.call_id ? await prisma.voiceCall.findUnique({ where: { id: e.call_id } }) : await activeLiveCall();

  if (type === 'incoming') {
    const number = toE164(e.number);
    if (call && ON_LINE.has(call.state)) return { action: 'ignore', reason: 'line busy' };
    const agent = await prisma.voiceAgent.findFirst({ where: { role: 'RECEPTIONIST', active: true }, orderBy: { created_at: 'asc' } });
    const customer = number ? await crm.getCustomer(number) : null;
    const ok = flags().autoAnswer && agent && !(await isEmergencyStopped()) && verified(await getGatewayStatus(), 'call_answering');
    call = await prisma.voiceCall.create({ data: { agent_id: agent ? agent.id : (await prisma.voiceAgent.findFirst()).id, client_id: customer?.id || null, direction: 'INBOUND', mode: 'LIVE', phone: number } });
    call = await transition(call, 'RINGING', { reason: 'incoming call' });
    await logEvent(call.id, 'GATEWAY', { type, number });
    if (!ok) return { action: 'ignore', call_id: call.id, reason: 'auto-answer is off, not verified, or emergency stop' };
    await enqueueCommand(call.id, 'ANSWER', {});
    return { action: 'answer', call_id: call.id, greeting: agent.greeting };
  }
  if (!call) return { action: 'ignore', reason: 'no matching call' };
  await logEvent(call.id, 'GATEWAY', { type, reason: e.reason || null });

  if (type === 'alerting' && ['DIALING'].includes(call.state)) call = await transition(call, 'RINGING');
  if (type === 'active' && ['DIALING', 'RINGING'].includes(call.state)) {
    call = await transition(call, 'CONNECTED');
    call = await transition(call, 'AI_ACTIVE');
    const agent = await prisma.voiceAgent.findUnique({ where: { id: call.agent_id } });
    await prisma.voiceCall.update({ where: { id: call.id }, data: { transcript: [{ role: 'agent', text: agent.greeting, final: true, at: new Date().toISOString() }] } });
    return { action: 'speak', call_id: call.id, greeting: agent.greeting };
  }
  if (type === 'disconnected') {
    const reason = String(e.reason || '').toLowerCase();
    if (['CONNECTED', 'AI_ACTIVE', 'ESCALATED'].includes(call.state)) call = await transition(call, 'COMPLETED', { reason: e.reason });
    else if (['DIALING', 'RINGING'].includes(call.state)) {
      const to = /busy/.test(reason) ? 'BUSY' : /reject|declin/.test(reason) ? 'REJECTED' : 'NO_ANSWER';
      call = await transition(call, to, { reason: e.reason, data: { outcome: to === 'REJECTED' ? 'NOT_INTERESTED' : to } });
    }
    await finalize(call.id);
    tick().catch(() => {});
  }
  return { action: 'ok', call_id: call.id };
}

/** Customer turn on a live call (gateway sends STT text; gets the reply to speak). */
async function liveTurn(callId, text) {
  const call = await prisma.voiceCall.findUnique({ where: { id: callId } });
  if (!call || !['AI_ACTIVE', 'ESCALATED', 'CONNECTED'].includes(call.state)) throw Object.assign(new Error('Call is not active'), { status: 409 });
  if (await isEmergencyStopped()) return { reply: 'Sorry, I have to end the call now. Our founder will call you back.', endCall: true };
  const { runTurn } = require('./agentEngine');
  const r = await runTurn(callId, text);
  if (r.endCall) await enqueueCommand(callId, 'HANGUP', { after_speaking: true });
  return r;
}

async function hangup(callId, reason = 'hung up from dashboard') {
  const call = await prisma.voiceCall.findUnique({ where: { id: callId } });
  if (!call) throw Object.assign(new Error('Call not found'), { status: 404 });
  if (call.mode === 'SIMULATED') {
    if (!ENDED.has(call.state) && call.state !== 'CRM_SYNCED') await transition(call, 'COMPLETED', { reason });
    return finalize(call.id);
  }
  if (['QUEUED', 'RETRY_PENDING', 'GATEWAY_READY'].includes(call.state)) return transition(call, 'CANCELLED', { reason });
  if (ON_LINE.has(call.state)) await enqueueCommand(call.id, 'HANGUP', {});
  return call;
}

async function emergencyStop(on = true) {
  await setSetting('voice_emergency_stop', on ? 'on' : 'off');
  if (on) {
    // Nothing that would start or answer a call may still reach the phone.
    await prisma.voiceGatewayCommand.updateMany({ where: { status: 'pending', command: { not: 'HANGUP' } }, data: { status: 'expired', result: { error: 'emergency stop' } } });
    const live = await prisma.voiceCall.findMany({ where: { mode: 'LIVE', state: { in: [...ON_LINE] } } });
    for (const c of live) await enqueueCommand(c.id, 'HANGUP', { emergency: true });
    const queued = await prisma.voiceCall.findMany({ where: { mode: 'LIVE', state: { in: ['QUEUED', 'RETRY_PENDING', 'GATEWAY_READY'] } } });
    for (const c of queued) await transition(c, 'CANCELLED', { reason: 'emergency stop' }).catch(() => {});
  }
  await logAction(null, on ? 'VOICE_EMERGENCY_STOP' : 'VOICE_EMERGENCY_CLEARED', on ? 'All AI calls stopped' : 'AI calling allowed again');
  return { emergency_stop: on };
}

/** After a call ends: summary + CRM sync (idempotent), or schedule a capped retry. */
async function finalize(callId) {
  let call = await prisma.voiceCall.findUnique({ where: { id: callId } });
  if (!call || call.state === 'CRM_SYNCED') return call;
  if (['NO_ANSWER', 'BUSY', 'FAILED', 'GATEWAY_DISCONNECTED'].includes(call.state) && call.mode === 'LIVE' && call.direction === 'OUTBOUND'
    && call.attempts < MAX_ATTEMPTS && call.outcome !== 'OPT_OUT') {
    return transition(call, 'RETRY_PENDING', { data: { next_attempt_at: new Date(Date.now() + RETRY_AFTER_MIN * 60000) } });
  }
  if (!call.summary && Array.isArray(call.transcript) && call.transcript.length > 1) {
    const summary = await summarize(call).catch(() => null);
    if (summary) call = await prisma.voiceCall.update({ where: { id: call.id }, data: summary });
  }
  if (call.mode === 'LIVE') {
    await crm.saveCallOutcome(call);
    await crm.addConversationSummary(call.client_id, `${call.direction} AI call — ${call.outcome || call.state}. ${call.summary || ''}`, call.id);
  }
  if (call.state === 'CANCELLED' || ENDED.has(call.state)) call = await transition(call, 'CRM_SYNCED');
  if (call.state === 'CRM_SYNCED') await require('./voiceCampaigns').afterCall(call).catch((err) => logError(call.client_id, 'VOICE_CAMPAIGN_AFTER_CALL', err));
  return call;
}

async function summarize(call) {
  const lines = call.transcript.map((t) => `${t.role === 'agent' ? 'Agent' : 'Customer'}: ${t.text}`).join('\n').slice(-8000);
  const provider = getProvider();
  if (provider.name === 'mock') return { summary: `(simulated) ${call.transcript.length} turns.`, outcome: call.outcome || 'INFO_ONLY' };
  const res = await provider.respond({
    system: 'Summarise this phone call for a CRM. Reply with JSON only: {"summary": "2-4 sentences", "intent": "short", "qualification_score": 0-100, "objections": "short or empty", "outcome": "BOOKED|INTERESTED|CALLBACK|NOT_INTERESTED|OPT_OUT|INFO_ONLY"}',
    messages: [{ role: 'user', content: lines }],
    tools: [],
  });
  const j = JSON.parse((res.text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
  return {
    summary: String(j.summary || '').slice(0, 2000) || null,
    intent: j.intent ? String(j.intent).slice(0, 200) : null,
    qualification_score: Number.isFinite(+j.qualification_score) ? Math.max(0, Math.min(100, Math.round(+j.qualification_score))) : null,
    objections: j.objections ? String(j.objections).slice(0, 1000) : null,
    outcome: call.outcome || (['BOOKED', 'INTERESTED', 'CALLBACK', 'NOT_INTERESTED', 'OPT_OUT', 'INFO_ONLY'].includes(j.outcome) ? j.outcome : null),
  };
}

module.exports = {
  ensureDefaultAgents, getGatewayStatus, startSimulatedCall, requestLiveCall, tick, gatewayHeartbeat, gatewayEvent,
  commandResult, liveTurn, hangup, emergencyStop, isEmergencyStopped, finalize, flags, DEFAULT_AGENTS,
};
