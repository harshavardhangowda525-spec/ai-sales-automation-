// Infinity Voice conversation engine: one customer utterance in → one spoken reply out.
// Runs the model with typed CRM tools, validates every tool input, enforces the agent's tool
// permissions, and records transcript, tool calls, latency and token usage on the call.
const prisma = require('../../lib/prisma');
const crm = require('./crmAdapter');
const { logEvent } = require('./stateMachine');
const { getProvider } = require('./aiProvider');

const MAX_TOOL_ROUNDS = 4;

// ── Tool definitions (strict JSON schemas) ──
const str = (description) => ({ type: 'string', description });
const TOOLS = {
  get_customer_context: {
    description: "Look up this caller's CRM record and recent history (only the customer on this call).",
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  check_availability: {
    description: 'Free 30-minute slots for the free Google Meet consultation with the founder. Always call this before offering times.',
    input_schema: { type: 'object', properties: { days: { type: 'integer', description: 'How many days ahead to look (1-14)' } }, required: ['days'], additionalProperties: false },
  },
  book_appointment: {
    description: 'Book the consultation in a slot returned by check_availability, after the customer agreed to that exact time.',
    input_schema: { type: 'object', properties: { start: str('Slot start time exactly as returned by check_availability (ISO 8601)') }, required: ['start'], additionalProperties: false },
  },
  update_qualification: {
    description: 'Save what you learned: requirements, plan interest, name, email. Use empty strings for unknown fields.',
    input_schema: {
      type: 'object',
      properties: {
        requirements: str('What they need, one or two sentences'),
        plan_interest: { type: 'string', enum: ['BASIC', 'PREMIUM', 'ADVANCED', 'UNKNOWN'] },
        contact_name: str('Their name'),
        email: str('Their email if they gave it'),
      },
      required: ['requirements', 'plan_interest', 'contact_name', 'email'],
      additionalProperties: false,
    },
  },
  create_follow_up: {
    description: 'Schedule a follow-up call/task when the customer asks to be contacted later.',
    input_schema: { type: 'object', properties: { when: str('ISO 8601 date-time in IST'), note: str('What to follow up about') }, required: ['when', 'note'], additionalProperties: false },
  },
  request_owner_approval: {
    description: 'Anything you are not allowed to decide alone (discounts, custom quotes, unusual commitments, schedule exceptions, escalations). Tell the customer the founder will confirm — never promise it.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['discount', 'custom_quote', 'commitment', 'schedule_exception', 'escalation', 'other'] },
        request: str('What the customer wants, one sentence'),
        details: str('Relevant details'),
      },
      required: ['kind', 'request', 'details'],
      additionalProperties: false,
    },
  },
  record_opt_out: {
    description: 'The customer does not want to be called again. Record it immediately, apologise and end the call.',
    input_schema: { type: 'object', properties: { reason: str('Their words') }, required: ['reason'], additionalProperties: false },
  },
  end_call: {
    description: 'End the call after a polite goodbye. Summarise the call for the CRM.',
    input_schema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['BOOKED', 'INTERESTED', 'CALLBACK', 'NOT_INTERESTED', 'OPT_OUT', 'INFO_ONLY'] },
        summary: str('2-4 sentence summary of the call'),
        next_action: str('What should happen next (empty if nothing)'),
      },
      required: ['outcome', 'summary', 'next_action'],
      additionalProperties: false,
    },
  },
};
const ALWAYS_ALLOWED = ['get_customer_context', 'record_opt_out', 'end_call', 'request_owner_approval'];

function toolsFor(agent) {
  const allowed = new Set([...ALWAYS_ALLOWED, ...(agent.allowed_tools || [])]);
  return Object.entries(TOOLS).filter(([name]) => allowed.has(name)).map(([name, t]) => ({ name, ...t, strict: true }));
}

// Lightweight runtime validation (strict mode already constrains the model; this guards the mock and
// any malformed input before it touches the CRM).
function validate(name, input) {
  const schema = TOOLS[name]?.input_schema;
  if (!schema) return 'Unknown tool';
  if (!input || typeof input !== 'object') return 'Input must be an object';
  for (const key of schema.required) if (!(key in input)) return `Missing ${key}`;
  for (const [k, v] of Object.entries(input)) {
    const p = schema.properties[k];
    if (!p) return `Unexpected field ${k}`;
    if (p.type === 'string' && typeof v !== 'string') return `${k} must be a string`;
    if (p.type === 'integer' && !Number.isInteger(v)) return `${k} must be an integer`;
    if (p.enum && !p.enum.includes(v)) return `${k} must be one of ${p.enum.join(', ')}`;
  }
  return null;
}

async function businessKnowledge() {
  const { PLANS } = require('../proposalGenerator');
  const plans = Object.entries(PLANS).map(([k, p]) => `- ${p.name || k}: ₹${p.price}${p.tagline ? ` — ${p.tagline}` : ''}`).join('\n');
  const kb = await prisma.voiceKnowledge.findMany({ where: { active: true }, orderBy: { created_at: 'asc' }, take: 30 });
  return [
    'Infinity Web & Apps (Bengaluru) builds premium websites, web apps and Android/iOS apps for local businesses. Founder: Harshavardhan.',
    'Websites go live in about 7 days. Every site is mobile-first with WhatsApp and call buttons, Google Maps and a contact form.',
    `Website plans (the ONLY prices you may quote):\n${plans}`,
    'The free 15-minute Google Meet consultation with the founder is the main next step for interested customers.',
    ...kb.map((k) => `## ${k.title}\n${k.content.slice(0, 4000)}`),
  ].join('\n\n');
}

function systemPrompt(agent, knowledge) {
  return [
    `You are ${agent.name}, the ${agent.role.toLowerCase().replace('_', '-')} voice agent for Infinity Web & Apps, speaking with a customer on a PHONE CALL.`,
    agent.personality ? `Personality: ${agent.personality}` : null,
    agent.objectives ? `Objectives: ${agent.objectives}` : null,
    agent.escalation_rules ? `Escalation rules: ${agent.escalation_rules}` : null,
    `You opened the call with: "${agent.greeting}"`,
    'VOICE RULES: replies are spoken aloud — 1 to 3 short sentences, no lists, no markdown, no emojis, no URLs. Ask one question at a time. Match the caller\'s language (English, Hindi or Kannada).',
    'TRUTH RULES: never invent prices, availability, discounts, delivery dates or promises. Only quote the plans below. For anything else, use request_owner_approval and say the founder will confirm.',
    'Use check_availability before offering meeting times and book_appointment only after the customer agrees to a specific slot. If the customer asks not to be called again, use record_opt_out immediately. Always end with end_call after saying goodbye.',
    `BUSINESS KNOWLEDGE:\n${knowledge}`,
  ].filter(Boolean).join('\n\n');
}

async function customerContextBlock(call) {
  if (!call.client_id) return `This caller is not in the CRM yet${call.phone ? ` (number ${call.phone})` : ''}. Ask for their name and business.`;
  const lead = await crm.getLead(call.client_id);
  if (!lead) return 'Unknown caller.';
  return `CUSTOMER ON THIS CALL: ${lead.business_name}${lead.contact_name ? `, contact ${lead.contact_name}` : ''}. Plan interest: ${lead.plan_interest}. `
    + `Requirements: ${lead.requirements || 'unknown'}. Stage: ${lead.portal_status}. ${lead.meeting_time ? `Has a consultation on ${lead.meeting_time.toISOString()}. ` : ''}`
    + `${lead.proposal_sent ? 'A proposal was already sent. ' : ''}Direction: ${call.direction}.`;
}

/** Run one tool with authorization + validation. Returns { content, is_error, endCall } */
async function runTool(call, agent, use) {
  const allowed = new Set([...ALWAYS_ALLOWED, ...(agent.allowed_tools || [])]);
  if (!allowed.has(use.name)) return { content: `Tool ${use.name} is not permitted for this agent.`, is_error: true };
  const problem = validate(use.name, use.input);
  if (problem) return { content: `INVALID_INPUT: ${problem}`, is_error: true };
  const i = use.input;
  const needClient = () => { if (!call.client_id) throw new Error('This caller is not a CRM customer yet — collect their name and business first'); };
  try {
    switch (use.name) {
      case 'get_customer_context': {
        const lead = await crm.getLead(call.client_id);
        const history = await crm.getPreviousInteractions(call.client_id);
        return { content: JSON.stringify({ customer: lead, history }).slice(0, 6000) };
      }
      case 'check_availability':
        return { content: JSON.stringify({ slots: await crm.checkCalendarAvailability({ days: Math.min(Math.max(i.days, 1), 14) }) }) };
      case 'book_appointment': {
        needClient();
        if (call.mode !== 'LIVE') return { content: JSON.stringify({ simulated: true, booked: i.start, note: 'Simulated call — no real booking was made' }) };
        return { content: JSON.stringify(await crm.bookAppointment(call.client_id, i.start)) };
      }
      case 'update_qualification':
        needClient();
        if (call.mode === 'LIVE') await crm.updateQualification(call.client_id, i);
        return { content: call.mode === 'LIVE' ? 'Saved.' : 'Saved (simulated — CRM not changed).' };
      case 'create_follow_up':
        needClient();
        if (call.mode !== 'LIVE') return { content: `Simulated follow-up at ${i.when} — not saved.` };
        return { content: JSON.stringify(await crm.createFollowUp(call.client_id, i)) };
      case 'request_owner_approval': {
        if (call.mode !== 'LIVE') return { content: 'Simulated approval request — the founder was not contacted. Tell the customer the founder will confirm.' };
        const r = await crm.createApprovalRequest({ clientId: call.client_id, callId: call.id, ...i });
        return { content: `Approval requested (${r.approval_id}). Do not promise it; say the founder will confirm.` };
      }
      case 'record_opt_out':
        await prisma.voiceCall.update({ where: { id: call.id }, data: { outcome: 'OPT_OUT' } });
        if (call.client_id && call.mode === 'LIVE') {
          await prisma.client.update({ where: { id: call.client_id }, data: { do_not_call: true, voice_consent: false, consent_note: `Opted out: ${i.reason.slice(0, 300)}` } });
        }
        return { content: 'Opt-out recorded. Apologise briefly, say goodbye and call end_call with outcome OPT_OUT.' };
      case 'end_call':
        await prisma.voiceCall.update({ where: { id: call.id }, data: { outcome: i.outcome, summary: i.summary, next_action: i.next_action || null } });
        return { content: 'Call will end after your goodbye.', endCall: true };
      default:
        return { content: 'Unknown tool', is_error: true };
    }
  } catch (err) {
    return { content: `ERROR: ${err.message}`, is_error: true };
  }
}

function appendTranscript(call, role, text) {
  const t = Array.isArray(call.transcript) ? call.transcript : [];
  t.push({ role, text, final: true, at: new Date().toISOString() });
  return t;
}

/**
 * One conversational turn.
 * @param callId  VoiceCall id (must be CONNECTED / AI_ACTIVE / ESCALATED)
 * @param customerText  finalized transcript of what the customer said
 * @returns {{ reply: string, endCall: boolean, latencyMs: number, provider: string }}
 */
async function runTurn(callId, customerText, { provider = getProvider() } = {}) {
  const t0 = Date.now();
  let call = await prisma.voiceCall.findUnique({ where: { id: callId }, include: { agent: true } });
  if (!call) throw new Error('Call not found');
  const agent = call.agent;
  const knowledge = await businessKnowledge();
  const system = [
    { type: 'text', text: systemPrompt(agent, knowledge), cache_control: { type: 'ephemeral' } }, // stable → cached
    { type: 'text', text: await customerContextBlock(call) }, // per call, after the cache breakpoint
  ];
  const tools = toolsFor(agent);
  const messages = Array.isArray(call.ai_messages) ? [...call.ai_messages] : [];
  const said = String(customerText || '').trim().slice(0, 2000) || '(silence)';
  messages.push({ role: 'user', content: said });
  let transcript = appendTranscript(call, 'customer', said);

  let reply = '';
  let endCall = false;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  let providerName = provider.name;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let res;
    try {
      res = await provider.respond({ system, messages, tools });
    } catch (err) {
      await logEvent(call.id, 'ERROR', { where: 'ai', message: err.message });
      reply = "Sorry, I'm having a little trouble on my side. Our founder will call you back shortly.";
      endCall = true;
      break;
    }
    providerName = res.provider;
    for (const k of Object.keys(usage)) usage[k] += res.usage?.[k] || 0;
    messages.push({ role: 'assistant', content: res.content });
    if (res.stopReason === 'refusal') {
      reply = "I'm sorry, I can't help with that on this call. Our founder will get back to you.";
      break;
    }
    if (res.text) reply = res.text;
    if (!res.toolUses.length || res.stopReason !== 'tool_use') break;
    const results = [];
    for (const use of res.toolUses) {
      const r = await runTool(call, agent, use);
      if (r.endCall) endCall = true;
      await logEvent(call.id, 'TOOL', { name: use.name, input: use.input, result: String(r.content).slice(0, 500), error: Boolean(r.is_error) });
      results.push({ type: 'tool_result', tool_use_id: use.id, content: String(r.content), ...(r.is_error ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results }); // all results of one turn in a single message
    if (endCall && round >= 1 && reply) break;
  }
  if (!reply) reply = endCall ? 'Thank you for your time. Have a great day!' : 'Sorry, could you say that again?';

  transcript.push({ role: 'agent', text: reply, final: true, at: new Date().toISOString() });
  const latencyMs = Date.now() - t0;
  const prev = call.usage || {};
  const turns = (prev.turns || 0) + 1;
  await prisma.voiceCall.update({
    where: { id: call.id },
    data: {
      ai_messages: messages,
      transcript,
      usage: {
        provider: providerName,
        turns,
        input_tokens: (prev.input_tokens || 0) + usage.input_tokens,
        output_tokens: (prev.output_tokens || 0) + usage.output_tokens,
        cache_read_input_tokens: (prev.cache_read_input_tokens || 0) + usage.cache_read_input_tokens,
        avg_latency_ms: Math.round(((prev.avg_latency_ms || 0) * (turns - 1) + latencyMs) / turns),
      },
    },
  });
  await logEvent(call.id, 'LATENCY', { turn_ms: latencyMs, provider: providerName });
  return { reply, endCall, latencyMs, provider: providerName };
}

module.exports = { runTurn, TOOLS, toolsFor, validate, systemPrompt };
