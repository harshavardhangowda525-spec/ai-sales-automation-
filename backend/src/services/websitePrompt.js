// Writes the CLAUDE.md brief for a client's website. Claude Code (on Harsha's Claude plan, no
// API key) reads it in the client's own GitHub repo, plans the site and builds it.
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
    stack: 'Static site: Vite + React + Tailwind CSS + Framer Motion, deployable to Vercel',
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
    stack: 'Next.js (static export) + Tailwind CSS + Framer Motion, deployable to Vercel',
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
    stack: 'Next.js (App Router) + Tailwind CSS + Framer Motion + a Postgres database (Neon) via Prisma, deployable to Vercel/Render',
  },
};

// Every plan must look premium — even Basic (₹4,999). Higher plans add more motion and polish.
const DESIGN_LEVEL = {
  BASIC: [
    'Premium, agency-quality look — it must feel like a ₹50,000 website, not a template.',
    'Motion graphics with Framer Motion: hero headline/CTA entrance, scroll-reveal on every section (fade + slide up, staggered cards), hover lift + glow on buttons and cards, smooth scrolling, animated counters for stats.',
    'Modern textures: subtle film-grain/noise overlay, soft gradient or mesh-gradient backgrounds, glassmorphism (backdrop-blur) cards and a sticky glass header, layered soft shadows, rounded 2xl corners.',
    'Premium typography: a distinctive Google Fonts display face for headings (e.g. Sora, Clash Display-style, Playfair for elegant brands) paired with Inter/Manrope for body; big confident hero type.',
    'Refined details: lucide-react icons, generous whitespace on an 8px spacing scale, section dividers/waves, a services marquee or logo strip, a bold final CTA band.',
  ],
  PREMIUM: [
    'Everything in the Basic design level, plus:',
    'Parallax hero with an animated gradient / aurora background, image reveal masks, page-transition animations between routes.',
    'Interactive service cards (tilt or flip on hover), an auto-playing testimonial carousel, animated FAQ accordions.',
  ],
  ADVANCED: [
    'Everything in the Premium design level, plus:',
    'Scroll-driven storytelling sections (sticky sections that animate as you scroll), a subtle 3D or particle hero element (CSS/Three.js, lightweight).',
    'Animated, delightful booking flow with micro-interactions and a success animation.',
  ],
};

function designLines(key) {
  const lines = [...DESIGN_LEVEL.BASIC];
  if (key === 'PREMIUM' || key === 'ADVANCED') lines.push(...DESIGN_LEVEL.PREMIUM.slice(1));
  if (key === 'ADVANCED') lines.push(...DESIGN_LEVEL.ADVANCED.slice(1));
  return lines;
}

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
  return `# CLAUDE.md — ${client.business_name} website (${PLANS[key].name} plan)

You are building a production-ready website for a local business client of **Infinity Web & Apps** (Bengaluru).
This repository holds only this client's site. Work in it, create the project from scratch, and keep going
until the checklist at the end is complete.

## How to work
1. First write \`PLAN.md\`: the page list, every section on each page with the actual copy you'll use
   (specific to this business — no lorem ipsum), the colour palette and fonts, and the features in scope.
2. Then build the site from the plan. Commit in small, clear steps.
3. Finish with the README and the done checklist below. Stay within the plan's scope — don't add paid
   features the client hasn't bought.

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

## Design — premium look with motion (most important)
${designLines(key).map((l) => `- ${l}`).join('\n')}
- Mobile-first (most visitors are on phones). Large tap targets, readable 16px+ body text; every animation must look great on a phone.
- Pick a rich colour palette that suits the business type (with one bold accent); define it once as CSS variables / Tailwind theme.
- Performance stays high: animate only transform/opacity, lazy-load images, respect \`prefers-reduced-motion\`.
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
- [ ] Looks premium: motion on hero + scroll reveals + hover states, textured/gradient backgrounds, polished typography
- [ ] No placeholder text left except clearly marked image TODOs
`;
}

/**
 * Generate (or regenerate) the build prompt for a client and save it.
 * Moves the website stage to PROMPT_READY if it hadn't started yet.
 */
async function generateWebsitePrompt(clientOrId) {
  const id = typeof clientOrId === 'string' ? clientOrId : clientOrId.id;
  const client = await prisma.client.findUnique({ where: { id } });
  const prompt = templatePrompt(client);
  const source = 'template';

  const updated = await prisma.client.update({
    where: { id },
    data: {
      website_prompt: prompt,
      website_prompt_source: source,
      website_prompt_at: new Date(),
      ...(client.website_stage === 'NOT_STARTED' ? { website_stage: 'PROMPT_READY' } : {}),
    },
  });
  await logAction(client.id, 'WEBSITE_PROMPT_READY', `CLAUDE.md brief written (${prompt.length} chars)`);
  return updated;
}

module.exports = { designLines, generateWebsitePrompt, templatePrompt };
