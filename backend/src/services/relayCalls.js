// "Jarvis, call my mom and tell her I'll be late today."
// Jarvis (the same Sarvam agent) calls one of sir's personal contacts, delivers the message,
// answers simple questions about it, and afterwards sir gets a WhatsApp with what they said.
const config = require('../lib/config');
const prisma = require('../lib/prisma');
const { logAction, logError } = require('../lib/logger');
const { toE164 } = require('../lib/phone');

const RELATIONS = {
  mom: ['mom', 'mother', 'amma', 'mummy', 'mum', 'ammi', 'maa', 'aai'],
  dad: ['dad', 'father', 'appa', 'papa', 'daddy', 'abba', 'baba'],
  wife: ['wife', 'hendathi', 'patni'],
  brother: ['brother', 'bro', 'anna', 'bhai', 'thammu'],
  sister: ['sister', 'sis', 'akka', 'didi', 'thangi'],
};

/** Find a contact by name, alias or relation word ("my mom", "amma", "Ravi"). */
async function findContact(spoken) {
  const q = String(spoken || '').toLowerCase().replace(/\b(my|call|to|the|please)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return null;
  const contacts = await prisma.contact.findMany();
  const words = (c) => [c.name, ...(c.aliases || '').split(',')].map((w) => w.trim().toLowerCase()).filter(Boolean);
  // exact name/alias, then relation synonyms, then partial name
  let hit = contacts.find((c) => words(c).includes(q));
  if (!hit) {
    const rel = Object.values(RELATIONS).find((syn) => syn.includes(q));
    if (rel) hit = contacts.find((c) => words(c).some((w) => rel.includes(w)));
  }
  if (!hit) hit = contacts.find((c) => words(c).some((w) => w.includes(q) || q.includes(w)));
  return hit || null;
}

function relayVariables(relay, contact) {
  const owner = config.founderName || 'sir';
  // Family members are greeted respectfully, not by "Mom"; friends/others by name.
  const isRelation = Object.values(RELATIONS).some((syn) => syn.includes(String(contact?.name || relay.to_name).toLowerCase()));
  const hello = isRelation ? 'Namaskara' : `Hello ${relay.to_name}`;
  const intro = `${hello}! This is Jarvis, ${owner}'s assistant. He asked me to give you a message.`;
  const context = [
    `THE PERSON ON THIS CALL IS NOT SIR. You are calling ${relay.to_name}${contact?.name ? '' : ''} on behalf of ${owner} (sir) to pass on his message.`,
    `Sir's message: "${relay.message}"`,
    contact?.notes ? `About ${relay.to_name}: ${contact.notes}` : null,
    `Right after your greeting, pass the message on naturally in your own words, as coming from ${owner} — change "I/me/my" to "he/him/his" (e.g. "I'll be late" → "he'll be a little late today").`,
    'Speak warmly and respectfully, in their language if they switch. Then answer their questions about it kindly.',
    "If they ask something you don't know (e.g. exact time he'll reach), say you'll let him know and he'll call them back.",
    'If they want to pass a message back to sir, say you will tell him.',
    'Never share anything about sir\'s business, clients or money. Keep the call short, then say a warm goodbye and end the call.',
  ].filter(Boolean).join('\n');
  return { harsha_message: intro, jarvis_context: context };
}

/** Place the call now (outside the owner-call queue — sir asked for it). */
async function callContact({ contact, phone, name, message }) {
  if (!config.isConfigured.ownerCalls) throw new Error('Jarvis calling is not set up (Sarvam agent / connection)');
  const toPhone = toE164(contact?.phone || phone);
  if (!toPhone || toPhone.replace(/\D/g, '').length < 10) throw new Error('No valid phone number for that person');
  const relay = await prisma.relayCall.create({
    data: { contact_id: contact?.id || null, to_name: contact?.name || name || 'them', to_phone: toPhone, message: String(message).slice(0, 1000) },
  });
  const vars = relayVariables(relay, contact);
  const { placeOutboundCall } = require('./sarvam');
  const secret = config.webhookSecret ? `?secret=${encodeURIComponent(config.webhookSecret)}` : '';
  try {
    const result = await placeOutboundCall({
      phoneNumber: toPhone,
      appId: config.sarvam.summaryAgentId,
      appVersion: config.sarvam.summaryAgentVersion,
      variables: vars,
      webhook: { url: `${config.publicBaseUrl}/webhook/sarvam/owner${secret}`, metadata: { relay_call_id: relay.id } },
    });
    await prisma.relayCall.update({ where: { id: relay.id }, data: { attempt_id: result.attempt_id || null } });
    await logAction(null, 'RELAY_CALL_PLACED', `Jarvis is calling ${relay.to_name} (${toPhone}): "${relay.message.slice(0, 160)}"`);
    return relay;
  } catch (err) {
    await prisma.relayCall.update({ where: { id: relay.id }, data: { status: 'failed', summary: err.message } });
    await logError(null, 'RELAY_CALL', err);
    throw err;
  }
}

/** While a relay call is ringing, Jarvis's on-start tool must get the relay script, not "not sir". */
async function activeRelayFor(phoneE164) {
  if (!phoneE164) return null;
  const relay = await prisma.relayCall.findFirst({
    where: { to_phone: phoneE164, status: 'calling', created_at: { gt: new Date(Date.now() - 15 * 60000) } },
    orderBy: { created_at: 'desc' },
    include: { contact: true },
  });
  return relay ? relayVariables(relay, relay.contact) : null;
}

function pronoun(name) {
  const n = String(name || '').toLowerCase();
  const female = [...RELATIONS.mom, ...RELATIONS.wife, ...RELATIONS.sister];
  const male = [...RELATIONS.dad, ...RELATIONS.brother];
  return female.includes(n) ? 'her' : male.includes(n) ? 'him' : 'them';
}

/** What Jarvis says when he calls sir back after a relay call. */
function relaySpokenUpdate(relay, connected, theySaid, connectivity) {
  const who = relay.to_name;
  if (!connected) return `I tried calling ${who} to say "${relay.message}", but ${pronoun(who) === 'them' ? 'they' : pronoun(who) === 'her' ? 'she' : 'he'} didn't pick up. Should I try again?`;
  // Drop bare greetings/fillers so only what they actually said is read out.
  const parts = String(theySaid || '').split(' / ').map((x) => x.trim())
    .filter((x) => x && !/^(hello|hi|hmm+|ok(ay)?|haan|ha|yes|ji|namaskara|namaste)[.!?]*$/i.test(x)).map((x) => x.replace(/[.!?]+$/, ''));
  // Only a plain "hello / okay" → no call-back (the WhatsApp summary is enough).
  return parts.length ? `I called ${who} and told ${pronoun(who)}: "${relay.message}". ${who} said: ${parts.join('. ')}.` : null;
}

function summarizeTranscript(body) {
  const t = body.interaction_transcript;
  if (Array.isArray(t)) {
    const said = t.filter((m) => m.role === 'user').map((m) => (m.en_text ?? m.text ?? '').trim()).filter(Boolean);
    return said.length ? said.join(' / ').slice(0, 700) : null;
  }
  return null;
}

/** Sarvam's post-call webhook for a relay call → tell sir what happened on WhatsApp. */
async function handleRelayWebhook(relayId, body) {
  const relay = await prisma.relayCall.findUnique({ where: { id: relayId } });
  if (!relay || relay.status !== 'calling') return { ignored: true };
  const connectivity = String(body.status || body.connectivity_status || '').toLowerCase();
  const connected = !connectivity || ['connected', 'completed', 'success'].includes(connectivity);
  const theySaid = summarizeTranscript(body);
  const summary = connected
    ? `📞 I called ${relay.to_name} and told them: "${relay.message}".${theySaid ? `\n\nThey said: ${theySaid}` : ''}`
    : `📞 I tried calling ${relay.to_name} but they didn't pick up (${connectivity}). Want me to try again?`;
  await prisma.relayCall.update({ where: { id: relay.id }, data: { status: connected ? 'done' : 'no_answer', summary } });
  await logAction(null, connected ? 'RELAY_CALL_DONE' : 'RELAY_CALL_UNANSWERED', summary.slice(0, 400));
  try {
    const waLinked = require('./waLinked');
    if (config.ownerPhone && (await waLinked.hasSession())) await waLinked.sendText(config.ownerPhone, summary);
  } catch {
    // best effort
  }
  // Jarvis also calls sir back and tells him what they said (a short pause so sir isn't still on another call).
  try {
    const notice = relaySpokenUpdate(relay, connected, theySaid, connectivity);
    if (notice) await require('./ownerCalls').requestOwnerCall('NOTICE', { data: { notice }, delayMs: 20000 });
  } catch {
    // best effort
  }
  return { ok: true };
}

module.exports = { findContact, callContact, activeRelayFor, handleRelayWebhook, relayVariables, relaySpokenUpdate };
