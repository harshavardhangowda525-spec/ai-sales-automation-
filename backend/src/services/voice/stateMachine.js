// Infinity Voice call-state machine. Every state change goes through transition(): it checks the
// move is allowed, stamps timestamps, and writes an auditable VoiceCallEvent.
const prisma = require('../../lib/prisma');

const STATES = [
  'CREATED', 'ELIGIBILITY_CHECK', 'QUEUED', 'GATEWAY_READY', 'DIALING', 'RINGING', 'CONNECTED',
  'AI_ACTIVE', 'COMPLETED', 'CRM_SYNCED',
  'BLOCKED', 'BUSY', 'NO_ANSWER', 'REJECTED', 'FAILED', 'CANCELLED', 'ESCALATED', 'RETRY_PENDING', 'GATEWAY_DISCONNECTED',
];

// Terminal = nothing more will happen on the line for this call (CRM sync may still follow).
const TERMINAL = new Set(['CRM_SYNCED', 'BLOCKED', 'CANCELLED']);
const ENDED = new Set(['COMPLETED', 'BUSY', 'NO_ANSWER', 'REJECTED', 'FAILED', 'GATEWAY_DISCONNECTED']);
// States in which the single SIM is busy with this call.
const ON_LINE = new Set(['DIALING', 'RINGING', 'CONNECTED', 'AI_ACTIVE', 'ESCALATED']);

const ANY_LIVE = ['FAILED', 'CANCELLED', 'GATEWAY_DISCONNECTED'];
const ALLOWED = {
  CREATED: ['ELIGIBILITY_CHECK', 'CONNECTED', 'RINGING', ...ANY_LIVE], // inbound calls start at RINGING/CONNECTED
  ELIGIBILITY_CHECK: ['QUEUED', 'BLOCKED', 'CANCELLED'],
  QUEUED: ['GATEWAY_READY', 'CANCELLED', 'BLOCKED'],
  GATEWAY_READY: ['DIALING', 'QUEUED', ...ANY_LIVE],
  DIALING: ['RINGING', 'CONNECTED', 'BUSY', 'NO_ANSWER', 'REJECTED', ...ANY_LIVE],
  RINGING: ['CONNECTED', 'BUSY', 'NO_ANSWER', 'REJECTED', ...ANY_LIVE],
  CONNECTED: ['AI_ACTIVE', 'COMPLETED', ...ANY_LIVE],
  AI_ACTIVE: ['COMPLETED', 'ESCALATED', ...ANY_LIVE],
  ESCALATED: ['AI_ACTIVE', 'COMPLETED', ...ANY_LIVE],
  COMPLETED: ['CRM_SYNCED'],
  BUSY: ['RETRY_PENDING', 'CRM_SYNCED'],
  NO_ANSWER: ['RETRY_PENDING', 'CRM_SYNCED'],
  REJECTED: ['CRM_SYNCED'],
  FAILED: ['RETRY_PENDING', 'CRM_SYNCED'],
  GATEWAY_DISCONNECTED: ['RETRY_PENDING', 'CRM_SYNCED'],
  RETRY_PENDING: ['QUEUED', 'CANCELLED'],
  CRM_SYNCED: [],
  BLOCKED: [],
  CANCELLED: ['CRM_SYNCED'],
};

class TransitionError extends Error {}

async function logEvent(callId, type, data) {
  await prisma.voiceCallEvent.create({ data: { call_id: callId, type, data: data ?? undefined } }).catch(() => {});
}

/**
 * Move a call to `to`. Idempotent when already there. Throws TransitionError on an illegal move.
 * @returns the updated call
 */
async function transition(callOrId, to, { reason = null, data = {} } = {}) {
  if (!STATES.includes(to)) throw new TransitionError(`Unknown state ${to}`);
  const call = typeof callOrId === 'string' ? await prisma.voiceCall.findUnique({ where: { id: callOrId } }) : callOrId;
  if (!call) throw new TransitionError('Call not found');
  if (call.state === to) return call;
  if (!(ALLOWED[call.state] || []).includes(to)) {
    throw new TransitionError(`Illegal transition ${call.state} → ${to}`);
  }
  const now = new Date();
  const stamp = {};
  if (to === 'DIALING' || (to === 'RINGING' && !call.started_at) || (to === 'CONNECTED' && !call.started_at)) stamp.started_at = now;
  if (to === 'CONNECTED') stamp.connected_at = now;
  if (ENDED.has(to) || to === 'CANCELLED') {
    stamp.ended_at = now;
    if (call.connected_at) stamp.duration_seconds = Math.max(0, Math.round((now - call.connected_at) / 1000));
  }
  // Conditional update guards against two writers racing on the same call.
  const res = await prisma.voiceCall.updateMany({ where: { id: call.id, state: call.state }, data: { state: to, ...stamp, ...data } });
  if (!res.count) {
    const fresh = await prisma.voiceCall.findUnique({ where: { id: call.id } });
    if (fresh.state === to) return fresh;
    throw new TransitionError(`Call moved to ${fresh.state} before ${to} could be applied`);
  }
  await logEvent(call.id, 'STATE', { from: call.state, to, reason });
  return prisma.voiceCall.findUnique({ where: { id: call.id } });
}

module.exports = { STATES, TERMINAL, ENDED, ON_LINE, ALLOWED, transition, logEvent, TransitionError };
