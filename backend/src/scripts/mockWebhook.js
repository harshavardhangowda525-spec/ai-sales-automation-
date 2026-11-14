/* eslint-disable no-console */
// Fire mock Sarvam webhooks at the backend to test the full pipeline before going live.
// Usage:  node src/scripts/mockWebhook.js [baseUrl]      (default http://localhost:3000)
//   env:  SARVAM_WEBHOOK_SECRET (if the server requires it), ADMIN_TOKEN (to create the campaign)
require('dotenv').config();

const BASE = (process.argv[2] || process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const secret = process.env.SARVAM_WEBHOOK_SECRET ? `&secret=${encodeURIComponent(process.env.SARVAM_WEBHOOK_SECRET)}` : '';
const auth = process.env.ADMIN_TOKEN ? { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` } : {};

const calls = [
  {
    phone_number: '+919845012345',
    business_name: 'Sri Lakshmi Sweets',
    outcome: 'BOOKED',
    duration_seconds: 214,
    transcript: `Agent: Namaste! This is Priya calling from Infinity Web & Apps, Bengaluru. Am I speaking with the owner of Sri Lakshmi Sweets?
Customer: Yes, my name is Ramesh Kumar. Tell me.
Agent: We build websites for local businesses. Do you have a website currently?
Customer: No, only a Google listing. Customers keep asking if they can order sweets online for festivals.
Agent: Our Premium plan at 8,999 includes up to 8 pages, SEO and Google Business setup. Advanced at 15,000 adds online ordering and payments.
Customer: Premium sounds good. I want a menu page with photos, festival offers and WhatsApp ordering. Online payment maybe later.
Agent: Great! Can we schedule a free 30 minute Google Meet consultation?
Customer: Yes, evening is better for me, after 6.
Agent: Perfect, we'll send the proposal and meeting link on WhatsApp.`,
  },
  {
    phone_number: '+919900112233',
    business_name: 'GreenLeaf Dental Clinic',
    outcome: 'BOOKED',
    duration_seconds: 187,
    transcript: `Agent: Hello, this is Priya from Infinity Web & Apps. Is this GreenLeaf Dental Clinic?
Customer: Yes, I'm Dr. Ananya Rao.
Agent: Ma'am, would an online appointment booking system help your clinic?
Customer: Definitely. Patients call all day. I want online booking, payment for consultations and WhatsApp reminders.
Agent: Our Advanced plan at 15,000 covers booking, payment gateway and WhatsApp Business API.
Customer: Okay, let's discuss. Morning works, around 10.`,
  },
  { phone_number: '+918012345678', business_name: 'Royal Tailors', outcome: 'REJECTED', duration_seconds: 42,
    transcript: 'Agent: Hello, this is Infinity Web & Apps...\nCustomer: Not interested, thank you.' },
  { phone_number: '+917022334455', business_name: 'Quick Fix Mobiles', outcome: 'NO_ANSWER', duration_seconds: 0, transcript: '' },
  { phone_number: '+919741556677', business_name: 'Bloom Florist', outcome: 'CALLBACK_LATER', duration_seconds: 63,
    transcript: 'Agent: Hello from Infinity Web & Apps...\nCustomer: I am busy right now, call me next week please. Basic website maybe.' },
];

async function main() {
  console.log(`→ Target: ${BASE}`);
  const campaignRes = await fetch(`${BASE}/api/campaign/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ campaign_name: `Mock campaign ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`, total_calls: calls.length }),
  });
  const campaignJson = await campaignRes.json();
  if (!campaignRes.ok) throw new Error(`campaign start failed: ${JSON.stringify(campaignJson)}`);
  const campaignId = campaignJson.campaign.id;
  console.log(`✓ Campaign ${campaignId} (expects ${calls.length} calls)`);

  for (const [i, c] of calls.entries()) {
    const res = await fetch(`${BASE}/webhook/sarvam?sync=1${secret}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_id: `mock-${Date.now()}-${i}`, campaign_id: campaignId, ...c }),
    });
    const json = await res.json();
    const a = json.result?.automation;
    console.log(`${res.ok ? '✓' : '✗'} ${c.outcome.padEnd(14)} ${c.business_name.padEnd(26)} client=${json.client_id}`
      + (a ? ` meet=${a.meet?.meetLink || '—'} proposal=${a.proposal?.number || '—'} whatsapp=${a.whatsapp ? (a.whatsapp.mock ? 'mock' : 'sent') : '—'}${a.errors.length ? ` errors=${a.errors}` : ''}` : '')
      + (json.error ? ` error=${json.error}` : ''));
  }

  const dash = await (await fetch(`${BASE}/api/dashboard`, { headers: auth })).json();
  const camp = dash.campaigns.find((c) => c.id === campaignId);
  console.log(`\nCampaign status: ${camp.status} | booked ${camp.booked}, rejected ${camp.rejected}, no answer ${camp.no_answer}, callback ${camp.callback_later} | summary call: ${camp.summary_call_sent ? 'triggered' : 'not yet'}`);
  console.log(`Dashboard totals: booked ${dash.total_booked}, meetings ${dash.meetings_scheduled}, proposals ${dash.proposals_sent}, conversion ${dash.conversion_rate}%`);
}

main().catch((err) => { console.error(err); process.exit(1); });
