// Writes a ready-to-paste build prompt for Claude Code (run locally by Harsha) that describes
// exactly what website to build for a client. Uses Groq (GROQ_API_KEY) when set, otherwise a
// built-in template filled with the client's details and plan scope.
const config = require('../lib/config');
const prisma = require('../lib/prisma');
const { logAction } = require('../lib/logger');
const { PLANS } = require('./proposalGenerator');

// Scope per plan — keeps the prompt aligned with what the client is paying for.
const PLAN_SCOPE = {
  BASIC: {
    pages: '3–5 pages: Home, About, Services/Menu, Gallery (optional), Contact',
    features: [
      'Fully mobile-responsive layout',
      'Floating WhatsApp chat button (wa.me link to the business number)',
      'Google Maps embed of the business location on Contact',
      'Contact form (name, phone, message) — submissions via a simple form service or mailto',
    ],
    stack: 'Static site: Vite + React + Tailwind CSS (or plain HTML + Tailwind), deployable to Vercel/Netlify/Render static',
  },
  PREMIUM: {
    pages: 'Up to 8 pages: Home, About, Services (with detail sections), Gallery, Testimonials, FAQ, Blog/Offers, Contact',
    features: [
      'Everything in Basic',
      'On-page SEO: unique titles/meta descriptions, Open Graph tags, sitemap.xml, robots.txt, LocalBusiness JSON-LD schema',
      'Google Business Profile link + reviews call-to-action',
      'Social media links/embeds (Instagram, Facebook, YouTube as relevant)',
      'Fast loading: optimised images, lazy loading, Lighthouse 90+ on mobile',
    ],
    stack: 'Next.js (static export) + Tailwind CSS, deployable to Vercel',
  },
  ADVANCED: {
    pages: 'Custom page set agreed with the client (typically 8–12): Home, About, Services, Booking, Pricing, Gallery, Testimonials, FAQ, Contact, Admin',
    features: [
      'Everything in Premium',
      'Custom UI/UX design — distinctive, brand-led visual system',
      'Online booking / appointment system (date + time slot picker, confirmation screen, admin list of bookings)',
      'Payment gateway integration (Razorpay, INR) for bookings/orders',
      'WhatsApp Business API notifications for new bookings (stubbed behind an env var)',
      'Simple admin page protected by a password',
    ],
    stack: 'Next.js (App Router) + Tailwind CSS + a Postgres database (Neon) via Prisma, deployable to Vercel/Render',
  },
};

function planKey(client) {
  return PLANS[client.plan_interest] ? client.plan_interest : 'PREMIUM';
}

function businessFacts(client) {
  return [
    `Business name: ${client.business_name}`,
    `Owner / contact: ${client.contact_name || 'unknown'}`,
    `Phone / WhatsApp: ${client.phone_number}`,
    'Location: Bengaluru, Karnataka, India (confirm exact address with the client)',
    `Plan purchased: ${PLANS[planKey(client)].name} (₹${PLANS[planKey(client)].price})`,
    `Client requirements (from the sales call): ${client.requirements || 'not captured — infer sensible defaults for this type of business'}`,
    client.notes ? `Agency notes: ${client.notes}` : null,
  ].filter(Boolean).join('\n');
}

/** Deterministic fallback — no API key needed. */
function templatePrompt(client) {
  const key = planKey(client);
  const scope = PLAN_SCOPE[key];
  return `# Build: ${client.business_name} website (${PLANS[key].name} plan)

You are building a production-ready website for a local business client of **Infinity Web & Apps** (Bengaluru).
Work in this folder, create the project from scratch, and keep going until the checklist at the end is complete.

## Client
${businessFacts(client)}

## Scope
- **Pages:** ${scope.pages}
- **Features:**
${scope.features.map((f) => `  - ${f}`).join('\n')}
- **Tech stack:** ${scope.stack}

## Content
- Write real, specific copy for this business (no lorem ipsum). Tone: warm, trustworthy, local.
- Hero: clear headline about what the business offers + primary call-to-action ("Call now" / "WhatsApp us" / "Book now").
- Use the client's requirements above to decide sections, services and offers.
- Use placeholder images from https://images.unsplash.com relevant to the business; mark each with a TODO to replace with the client's photos.
- Add the phone number as tap-to-call and a WhatsApp link: https://wa.me/${String(client.phone_number).replace(/\D/g, '')}

## Design
- Mobile-first (most visitors are on phones). Large tap targets, readable 16px+ body text.
- Pick a colour palette that suits the business type; define it once as CSS variables / Tailwind theme.
- Accessible: semantic HTML, alt text, sufficient contrast, keyboard navigable.

## Deliverables
1. Working project with a README (how to run, how to edit content, how to deploy).
2. All content in one easy-to-edit place (e.g. \`src/content.ts\`) so the agency can update text quickly.
3. Deployed preview link if deployment credentials are available; otherwise exact deploy steps.

## Done checklist
- [ ] All pages above exist and are linked in the navigation
- [ ] WhatsApp button and tap-to-call work on mobile
- [ ] Contact section with Google Maps embed
${key !== 'BASIC' ? '- [ ] SEO meta tags, sitemap.xml, robots.txt, LocalBusiness JSON-LD\n' : ''}${key === 'ADVANCED' ? '- [ ] Booking flow works end to end, Razorpay test payment succeeds, admin page lists bookings\n' : ''}- [ ] Lighthouse mobile score ≥ 90 for performance and accessibility
- [ ] No placeholder text left except clearly marked image TODOs
`;
}

const SYSTEM = `You write build prompts for Claude Code (an AI coding agent the agency runs locally).
Given a local Indian business client, their plan scope and what they said on a sales call, write ONE
complete, specific, ready-to-paste prompt in Markdown that makes Claude Code build their website end to end.
The prompt must include: a title; the client facts; exact page list with the sections on each page and what
copy each section should say (specific to this business, not generic); features to implement for the plan;
tech stack; design direction (palette, typography, mood suited to the business); content/SEO details;
WhatsApp + tap-to-call links using the client's number; where to use placeholder images; deliverables;
and a "Done checklist" of verifiable items. Stay within the plan's scope — never add paid features the plan
doesn't include. Output only the prompt Markdown, no preamble.`;

async function groqPrompt(client) {
  const key = planKey(client);
  const scope = PLAN_SCOPE[key];
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groq.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.groq.model,
      temperature: 0.4,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `${businessFacts(client)}\n\nPlan scope:\n- Pages: ${scope.pages}\n- Features:\n${scope.features.map((f) => `  - ${f}`).join('\n')}\n- Tech stack: ${scope.stack}\n\nWrite the Claude Code build prompt now.`,
        },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text || text.length < 200) throw new Error('Groq returned an empty prompt');
  return text.replace(/^```(?:markdown|md)?\n/, '').replace(/\n```$/, '');
}

/**
 * Generate (or regenerate) the build prompt for a client and save it.
 * Moves the website stage to PROMPT_READY if it hadn't started yet.
 */
async function generateWebsitePrompt(clientOrId) {
  const id = typeof clientOrId === 'string' ? clientOrId : clientOrId.id;
  const client = await prisma.client.findUnique({ where: { id } });
  let prompt;
  let source = 'template';
  if (config.isConfigured.groq) {
    try {
      prompt = await groqPrompt(client);
      source = 'groq';
    } catch (err) {
      await logAction(client.id, 'WEBSITE_PROMPT_GROQ_ERROR', `${err.message} — used the built-in template instead`);
    }
  }
  if (!prompt) prompt = templatePrompt(client);

  const updated = await prisma.client.update({
    where: { id },
    data: {
      website_prompt: prompt,
      website_prompt_source: source,
      website_prompt_at: new Date(),
      ...(client.website_stage === 'NOT_STARTED' ? { website_stage: 'PROMPT_READY' } : {}),
    },
  });
  await logAction(client.id, 'WEBSITE_PROMPT_READY', `Claude Code build prompt written (${source}, ${prompt.length} chars)`);
  return updated;
}

module.exports = { generateWebsitePrompt, templatePrompt };
