// Infinity Voice integration tests — real Postgres (TEST_DATABASE_URL), MockProvider (no paid AI),
// and a simulated gateway (no phone). Run: TEST_DATABASE_URL=postgresql://… npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
process.env.VOICE_AI_PROVIDER = 'mock';
delete process.env.ANTHROPIC_API_KEY;
process.env.HARSHAVARDHAN_PHONE = '';
process.env.VOICE_CALL_START_HOUR = '0'; // tests may run at any hour
process.env.VOICE_CALL_END_HOUR = '24';
process.env.VOICE_CALL_ON_SUNDAY = 'true';

const prisma = require('../src/lib/prisma');
const orch = require('../src/services/voice/orchestrator');
const { transition, TransitionError } = require('../src/services/voice/stateMachine');
const { runTurn, validate } = require('../src/services/voice/agentEngine');
const crm = require('../src/services/voice/crmAdapter');

// Never touch real calendars or Sarvam from tests.
const gcal = require('../src/services/googleCalendar');
gcal.listGoogleEvents = async () => [];
gcal.addCalendarEvent = async () => ({ id: 'test' });
gcal.scheduleGoogleMeet = async (client, prefs, { startTime }) => ({ meetLink: 'https://meet.test/abc', scheduledTime: startTime });
const owner = require('../src/services/ownerCalls');
const approvals = [];
owner.requestOwnerCall = async (type, o) => { approvals.push({ type, ...o }); return { id: `approval-${approvals.length}` }; };

let agents;
let client;
const VERIFIED = { bluetooth: 'VERIFIED', hfp: 'VERIFIED', incoming_audio: 'VERIFIED', outgoing_audio: 'VERIFIED', call_initiation: 'VERIFIED', call_answering: 'VERIFIED' };

before(async () => {
  await prisma.voiceCallEvent.deleteMany({});
  await prisma.voiceGatewayCommand.deleteMany({});
  await prisma.voiceCall.deleteMany({});
  await prisma.voiceAgent.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'voice_' } } });
  await prisma.client.deleteMany({ where: { business_name: { startsWith: 'VoiceTest' } } });
  await prisma.campaign.deleteMany({ where: { name: { startsWith: 'VoiceTest' } } });
  await orch.ensureDefaultAgents();
  agents = Object.fromEntries((await prisma.voiceAgent.findMany()).map((a) => [a.role, a]));
  client = await prisma.client.create({ data: { business_name: 'VoiceTest Bakery', phone_number: '+919812345678', call_outcome: 'MANUAL', voice_consent: true } });
});

after(async () => { await prisma.$disconnect(); });

test('default agents exist for all four roles', () => {
  assert.deepEqual(Object.keys(agents).sort(), ['FOLLOW_UP', 'RECEPTIONIST', 'SALES', 'SUPPORT']);
});

test('state machine rejects illegal transitions', async () => {
  const c = await prisma.voiceCall.create({ data: { agent_id: agents.SALES.id, direction: 'OUTBOUND', mode: 'LIVE' } });
  await assert.rejects(() => transition(c, 'AI_ACTIVE'), TransitionError);
  const q = await transition(c, 'ELIGIBILITY_CHECK');
  assert.equal(q.state, 'ELIGIBILITY_CHECK');
  await transition(q, 'BLOCKED');
});

test('tool input validation', () => {
  assert.equal(validate('check_availability', { days: 3 }), null);
  assert.match(validate('check_availability', { days: '3' }), /integer/);
  assert.match(validate('end_call', { outcome: 'MAYBE', summary: 'x', next_action: '' }), /one of/);
  assert.match(validate('book_appointment', { start: 'x', extra: 1 }), /Unexpected/);
});

test('simulated call: greeting, availability tool, end_call, CRM untouched', async () => {
  const { call, greeting } = await orch.startSimulatedCall({ agentId: agents.RECEPTIONIST.id, clientId: client.id });
  assert.equal(call.state, 'AI_ACTIVE');
  assert.match(greeting, /Infinity Web and Apps/);
  const r1 = await runTurn(call.id, 'Can I book a meeting?');
  assert.match(r1.reply, /simulated/);
  const events = await prisma.voiceCallEvent.findMany({ where: { call_id: call.id, type: 'TOOL' } });
  assert.ok(events.some((e) => e.data.name === 'check_availability'));
  const r2 = await runTurn(call.id, 'ok bye');
  assert.equal(r2.endCall, true);
  const done = await orch.hangup(call.id);
  assert.equal(done.state, 'CRM_SYNCED');
  const c = await prisma.client.findUnique({ where: { id: client.id } });
  assert.equal(c.call_outcome, 'MANUAL'); // simulated calls never change the CRM
});

test('agent without permission cannot use a tool', async () => {
  const { call } = await orch.startSimulatedCall({ agentId: agents.SUPPORT.id, clientId: client.id });
  await runTurn(call.id, 'I want a meeting'); // mock tries check_availability, SUPPORT is not allowed
  const ev = await prisma.voiceCallEvent.findFirst({ where: { call_id: call.id, type: 'TOOL' } });
  assert.equal(ev.data.error, true);
  assert.match(ev.data.result, /not permitted/);
});

test('live call is blocked while live calling is disabled', async () => {
  delete process.env.VOICE_LIVE_CALLING;
  const r = await orch.requestLiveCall({ agentId: agents.FOLLOW_UP.id, clientId: client.id });
  assert.equal(r.blocked, true);
  assert.ok(r.reasons.some((x) => /Live calling is disabled/.test(x)));
});

test('eligibility: no consent, do-not-call and receptionist cannot call out', async () => {
  const noConsent = await prisma.client.create({ data: { business_name: 'VoiceTest NoConsent', phone_number: '+919800000001', call_outcome: 'MANUAL' } });
  const e = await crm.getCallEligibility({ clientId: noConsent.id });
  assert.ok(e.reasons.some((x) => /consent/.test(x)));
  process.env.VOICE_LIVE_CALLING = 'true';
  const r = await orch.requestLiveCall({ agentId: agents.RECEPTIONIST.id, clientId: client.id });
  assert.ok(r.reasons.some((x) => /not allowed to make outbound/.test(x)));
});

test('full live outbound flow with a simulated gateway', async () => {
  process.env.VOICE_LIVE_CALLING = 'true';
  // Gateway offline → nothing is dialled.
  const r = await orch.requestLiveCall({ agentId: agents.FOLLOW_UP.id, clientId: client.id });
  assert.equal(r.blocked, false, r.reasons.join('; '));
  assert.equal((await prisma.voiceCall.findUnique({ where: { id: r.call.id } })).state, 'QUEUED');
  // Unverified gateway → still nothing.
  let hb = await orch.gatewayHeartbeat({ capabilities: { call_initiation: 'UNKNOWN' } });
  assert.equal(hb.commands.length, 0);
  // Verified gateway → DIAL command.
  hb = await orch.gatewayHeartbeat({ capabilities: VERIFIED, health: { call_active: false } });
  assert.equal(hb.commands.length, 1);
  assert.equal(hb.commands[0].command, 'DIAL');
  assert.equal(hb.commands[0].payload.number, '+919812345678');
  // Single SIM: a second queued call waits.
  const other = await prisma.client.create({ data: { business_name: 'VoiceTest Second', phone_number: '+919812345679', call_outcome: 'MANUAL', voice_consent: true } });
  const r2 = await orch.requestLiveCall({ agentId: agents.FOLLOW_UP.id, clientId: other.id });
  hb = await orch.gatewayHeartbeat({ capabilities: VERIFIED });
  assert.equal(hb.commands.length, 0);
  // Phone events.
  await orch.gatewayEvent({ type: 'alerting', call_id: r.call.id });
  const conn = await orch.gatewayEvent({ type: 'active', call_id: r.call.id });
  assert.equal(conn.action, 'speak');
  const turn = await orch.liveTurn(r.call.id, 'please book a demo');
  assert.ok(turn.reply.length > 0);
  await orch.gatewayEvent({ type: 'disconnected', call_id: r.call.id, reason: 'remote hangup' });
  const done = await prisma.voiceCall.findUnique({ where: { id: r.call.id } });
  assert.equal(done.state, 'CRM_SYNCED');
  assert.ok(done.duration_seconds >= 0);
  const logged = await prisma.callLog.findFirst({ where: { client_id: client.id, action: 'VOICE_CALL_SUMMARY' } });
  assert.ok(logged, 'summary written to the CRM activity log');
  // Line free → the second call is dialled next.
  hb = await orch.gatewayHeartbeat({ capabilities: VERIFIED });
  assert.equal(hb.commands[0]?.call_id, r2.call.id);
});

test('no answer schedules one capped retry', async () => {
  const c = await prisma.voiceCall.findFirst({ where: { state: 'DIALING' } });
  await orch.gatewayEvent({ type: 'disconnected', call_id: c.id, reason: 'no answer' });
  const after = await prisma.voiceCall.findUnique({ where: { id: c.id } });
  assert.equal(after.state, 'RETRY_PENDING');
  assert.ok(after.next_attempt_at > new Date());
});

test('opt-out on a live call sets do-not-call', async () => {
  const c = await prisma.voiceCall.create({ data: { agent_id: agents.FOLLOW_UP.id, client_id: client.id, direction: 'OUTBOUND', mode: 'LIVE', state: 'AI_ACTIVE' } });
  await orch.liveTurn(c.id, 'please stop calling me');
  const cl = await prisma.client.findUnique({ where: { id: client.id } });
  assert.equal(cl.do_not_call, true);
  const e = await crm.getCallEligibility({ clientId: client.id });
  assert.ok(e.reasons.some((x) => /opted out/.test(x)));
});

test('owner approval request for a discount (live)', async () => {
  const other = await prisma.client.findFirst({ where: { business_name: 'VoiceTest Second' } });
  const c = await prisma.voiceCall.create({ data: { agent_id: agents.SALES.id, client_id: other.id, direction: 'OUTBOUND', mode: 'LIVE', state: 'AI_ACTIVE' } });
  const before = approvals.length;
  await orch.liveTurn(c.id, 'can you give me a discount?');
  assert.equal(approvals.length, before + 1);
  assert.equal(approvals[approvals.length - 1].type, 'VOICE_APPROVAL');
});

test('incoming call is not answered unless auto-answer is on', async () => {
  await prisma.voiceCall.updateMany({ where: { state: { in: ['DIALING', 'RINGING', 'CONNECTED', 'AI_ACTIVE'] } }, data: { state: 'CANCELLED' } });
  delete process.env.VOICE_AUTO_ANSWER;
  let r = await orch.gatewayEvent({ type: 'incoming', number: '+919812345678' });
  assert.equal(r.action, 'ignore');
  await prisma.voiceCall.update({ where: { id: r.call_id }, data: { state: 'CANCELLED' } });
  process.env.VOICE_AUTO_ANSWER = 'true';
  await orch.gatewayHeartbeat({ capabilities: VERIFIED });
  r = await orch.gatewayEvent({ type: 'incoming', number: '+919812345678' });
  assert.equal(r.action, 'answer');
  const call = await prisma.voiceCall.findUnique({ where: { id: r.call_id } });
  assert.equal(call.client_id, client.id); // recognised by caller ID
});

test('emergency stop hangs up and cancels the queue', async () => {
  const res = await orch.emergencyStop(true);
  assert.equal(res.emergency_stop, true);
  const hb = await orch.gatewayHeartbeat({ capabilities: VERIFIED });
  assert.equal(hb.config.emergency_stop, true);
  assert.ok(hb.commands.every((c) => c.command === 'HANGUP'));
  assert.equal(await prisma.voiceCall.count({ where: { mode: 'LIVE', state: { in: ['QUEUED', 'RETRY_PENDING'] } } }), 0);
  await orch.emergencyStop(false);
});

// ── Cold-call campaigns on Infinity Voice ──
const vc = require('../src/services/voice/voiceCampaigns');
const pipeline = require('../src/services/pipeline');
const booked = [];
pipeline.runBookedAutomation = async (c) => { booked.push(c.id); return {}; };

test('cold calls need the authorisation switch and reference; consent is not required', async () => {
  await prisma.voiceCall.updateMany({ where: { mode: 'LIVE', state: { notIn: ['CRM_SYNCED', 'CANCELLED', 'BLOCKED'] } }, data: { state: 'CANCELLED' } });
  process.env.VOICE_LIVE_CALLING = 'true';
  const lead = await prisma.client.create({ data: { business_name: 'VoiceTest Cold Gym', phone_number: '+919800000001', call_outcome: 'MANUAL' } });
  delete process.env.VOICE_COLD_CALLING_AUTHORIZED;
  let e = await crm.getCallEligibility({ clientId: lead.id, purpose: 'cold' });
  assert.ok(e.reasons.some((x) => /switched off/.test(x)));
  process.env.VOICE_COLD_CALLING_AUTHORIZED = 'true';
  delete process.env.VOICE_TELEMARKETER_ID;
  e = await crm.getCallEligibility({ clientId: lead.id, purpose: 'cold' });
  assert.ok(e.reasons.some((x) => /registration reference/.test(x)));
  process.env.VOICE_TELEMARKETER_ID = 'TEST-REF-1';
  e = await crm.getCallEligibility({ clientId: lead.id, purpose: 'cold' });
  assert.equal(e.eligible, true, e.reasons.join('; '));
  // A follow-up to the same person still needs consent.
  e = await crm.getCallEligibility({ clientId: lead.id });
  assert.ok(e.reasons.some((x) => /consent/.test(x)));
  // Do-not-call always wins.
  await prisma.client.update({ where: { id: lead.id }, data: { do_not_call: true } });
  e = await crm.getCallEligibility({ clientId: lead.id, purpose: 'cold' });
  assert.ok(e.reasons.some((x) => /opted out/.test(x)));
});

test('daily call cap blocks further cold calls', async () => {
  const lead = await prisma.client.create({ data: { business_name: 'VoiceTest Cap', phone_number: '+919800000009', call_outcome: 'MANUAL' } });
  process.env.VOICE_DAILY_CALL_CAP = '0';
  delete require.cache[require.resolve('../src/services/voice/crmAdapter')];
  const fresh = require('../src/services/voice/crmAdapter');
  const e = await fresh.getCallEligibility({ clientId: lead.id, purpose: 'cold' });
  assert.ok(e.reasons.some((x) => /Daily call limit/.test(x)));
  delete process.env.VOICE_DAILY_CALL_CAP;
});

test('voice campaign: skips do-not-call, dials one lead at a time, books, then summary call', async () => {
  await prisma.voiceCall.updateMany({ where: { mode: 'LIVE', state: { notIn: ['CRM_SYNCED', 'CANCELLED', 'BLOCKED'] } }, data: { state: 'CANCELLED' } });
  const { campaign, added, skipped } = await vc.startVoiceCampaign({
    campaign_name: 'VoiceTest campaign',
    contacts: [
      { phone_number: '9800000002', business_name: 'VoiceTest Salon' },
      { phone_number: '9800000003', business_name: 'VoiceTest Clinic' },
      { phone_number: '9800000003', business_name: 'dup' },
      { phone_number: '9800000001', business_name: 'VoiceTest Cold Gym' }, // on do-not-call
      { phone_number: '12', business_name: 'bad' },
    ],
  });
  assert.equal(added, 2);
  assert.equal(skipped.length, 1);
  assert.equal(campaign.engine, 'infinity_voice');

  const runCall = async (outcome) => {
    await vc.tick();
    await orch.tick();
    const q = await prisma.voiceCall.findMany({ where: { purpose: 'cold', state: { in: ['QUEUED', 'DIALING'] } } });
    assert.equal(q.length, 1, 'exactly one cold call queued');
    assert.equal(q[0].authorization_ref, 'TEST-REF-1');
    await vc.tick(); // line busy → no second call
    assert.equal(await prisma.voiceCall.count({ where: { purpose: 'cold', state: { in: ['QUEUED', 'DIALING'] } } }), 1);
    const hb = await orch.gatewayHeartbeat({ capabilities: VERIFIED, health: { call_active: false } });
    assert.ok(hb.commands.some((c) => c.command === 'DIAL' && c.call_id === q[0].id));
    await orch.gatewayEvent({ type: 'active', call_id: q[0].id });
    if (outcome) await prisma.voiceCall.update({ where: { id: q[0].id }, data: { outcome } });
    await orch.gatewayEvent({ type: 'disconnected', call_id: q[0].id, reason: 'remote hangup' });
    return prisma.voiceCall.findUnique({ where: { id: q[0].id } });
  };

  const first = await runCall('BOOKED');
  assert.equal(first.state, 'CRM_SYNCED');
  assert.deepEqual(booked, [first.client_id]);
  const second = await runCall('NOT_INTERESTED');
  assert.equal(second.state, 'CRM_SYNCED');

  const before = approvals.length;
  await vc.tick();
  const done = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.booked, 1);
  assert.equal(done.rejected, 1);
  assert.equal(approvals.length, before + 1);
  assert.equal(approvals[approvals.length - 1].type, 'SUMMARY');
});
