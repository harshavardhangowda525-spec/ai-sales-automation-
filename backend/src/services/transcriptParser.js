const config = require('../lib/config');

const PLANS = ['BASIC', 'PREMIUM', 'ADVANCED', 'UNKNOWN'];
const OUTCOMES = ['BOOKED', 'REJECTED', 'NO_ANSWER', 'CALLBACK_LATER'];

const SYSTEM_PROMPT = `You extract structured sales data from phone call transcripts for
"Infinity Web & Apps", a Bengaluru digital agency selling websites to local businesses.
Plans offered: BASIC (₹4,999, simple 3–5 page site), PREMIUM (₹8,999, up to 8 pages + SEO + Google Business),
ADVANCED (₹15,000, custom design + booking/payments + WhatsApp API).
Transcripts may mix English, Hindi, Kannada or Hinglish. Return ONLY JSON with these keys:
{
  "contact_name": string|null,         // the customer's name (not the agent's)
  "business_name": string|null,        // only if clearly stated
  "plan_interest": "BASIC"|"PREMIUM"|"ADVANCED"|"UNKNOWN",
  "requirements": string|null,         // concise bullet-style summary of what they need, in English
  "preferred_time": string|null,       // as the customer said it, e.g. "tomorrow evening", "Monday 11am"
  "preferred_slot": "morning"|"afternoon"|"evening"|null,
  "preferred_date": "YYYY-MM-DD"|null, // only if a specific day can be resolved; today's IST date is given
  "preferred_hour": number|null,       // 24h hour in IST if a specific time was stated
  "outcome": "BOOKED"|"REJECTED"|"NO_ANSWER"|"CALLBACK_LATER"|null
}
If a field is unknown use null (or "UNKNOWN" for plan_interest).`;

/** Keep only what the customer said when the transcript has speaker labels (the agent pitches every plan). */
function customerLines(transcript) {
  const lines = transcript.split(/\n+/);
  const labelled = lines.filter((l) => /^\s*(customer|user|client|caller)\s*:/i.test(l));
  return labelled.length ? labelled.map((l) => l.replace(/^\s*\w+\s*:\s*/, '')).join('\n') : transcript;
}

function heuristicParse(transcript = '') {
  const said = customerLines(transcript);
  const t = said.toLowerCase();
  let plan_interest = 'UNKNOWN';
  // Explicit plan names win; otherwise infer from the features asked for.
  const named = ['advanced', 'premium', 'basic'].find((p) => t.includes(p));
  if (named) plan_interest = named.toUpperCase();
  else if (/15,?000|online booking|appointment|payment gateway/.test(t)) plan_interest = 'ADVANCED';
  else if (/8,?999|seo|google business/.test(t)) plan_interest = 'PREMIUM';
  else if (/4,?999|simple website/.test(t)) plan_interest = 'BASIC';

  let preferred_slot = null;
  if (/morning|subah|beligge/.test(t)) preferred_slot = 'morning';
  else if (/evening|shaam|sanje/.test(t)) preferred_slot = 'evening';
  else if (/afternoon|lunch|madhyahna/.test(t)) preferred_slot = 'afternoon';

  const nameMatch = said.match(/(?:[Mm]y name is|[Tt]his is|I am|I'm|[Mm]yself)\s+((?:Dr\.?\s)?[A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
  return {
    contact_name: nameMatch ? nameMatch[1] : null,
    business_name: null,
    plan_interest,
    requirements: said !== transcript ? said.slice(0, 600) : null,
    preferred_time: preferred_slot,
    preferred_slot,
    preferred_date: null,
    preferred_hour: null,
    outcome: null,
  };
}

function sanitize(raw) {
  const out = { ...raw };
  out.plan_interest = PLANS.includes(String(out.plan_interest).toUpperCase())
    ? String(out.plan_interest).toUpperCase() : 'UNKNOWN';
  out.outcome = OUTCOMES.includes(String(out.outcome).toUpperCase())
    ? String(out.outcome).toUpperCase() : null;
  if (!['morning', 'afternoon', 'evening'].includes(out.preferred_slot)) out.preferred_slot = null;
  if (out.preferred_date && !/^\d{4}-\d{2}-\d{2}$/.test(out.preferred_date)) out.preferred_date = null;
  const h = Number(out.preferred_hour);
  out.preferred_hour = Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
  for (const k of ['contact_name', 'business_name', 'requirements', 'preferred_time']) {
    if (typeof out[k] !== 'string' || !out[k].trim()) out[k] = null;
    else out[k] = out[k].trim();
  }
  return out;
}

/**
 * Extract contact name, plan interest, requirements and preferred meeting time from a transcript.
 * Uses OpenAI (GPT-4o) when OPENAI_API_KEY is set; otherwise a keyword heuristic.
 * @returns {Promise<{data: object, source: 'openai'|'heuristic'}>}
 */
async function parseTranscript(transcript) {
  if (!transcript || !transcript.trim()) {
    return { data: sanitize(heuristicParse('')), source: 'heuristic' };
  }
  if (!config.isConfigured.openai) {
    return { data: sanitize(heuristicParse(transcript)), source: 'heuristic' };
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openai.apiKey}`,
    },
    body: JSON.stringify({
      model: config.openai.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Today's date (IST): ${today}\n\nTranscript:\n${transcript.slice(0, 30000)}` },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || '{}';
  return { data: sanitize(JSON.parse(content)), source: 'openai' };
}

module.exports = { parseTranscript, heuristicParse };
