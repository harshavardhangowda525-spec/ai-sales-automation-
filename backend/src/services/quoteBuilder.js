// Quotation builder: a plan + add-on features → line items and a total. Used by Jarvis
// ("prepare a quotation for a basic website", "add online booking", "remove the logo"),
// the proposal PDF and the Client Portal. Prices can be overridden without a deploy by saving
// JSON in AppSetting "quote_addon_prices" (e.g. {"booking": 4500}).
const prisma = require('../lib/prisma');

// Default add-on prices (INR, one-time unless `per`). Suggested defaults — sir can change them.
const ADDONS = {
  extra_page:     { name: 'Extra page', price: 800, per: 'page', match: /extra pages?|more pages?|additional pages?|(\d+)\s*(more|extra|additional)?\s*pages?/ },
  logo:           { name: 'Logo design', price: 1499, match: /\blogo\b/ },
  booking:        { name: 'Online booking / appointment system', price: 3999, match: /booking|appointment|reservation|slot/ , includedIn: ['ADVANCED'] },
  payment:        { name: 'Payment gateway (Razorpay)', price: 2999, match: /payment|razorpay|upi|pay online|online pay/, includedIn: ['ADVANCED'] },
  ecommerce:      { name: 'Online store (up to 50 products)', price: 7999, match: /e-?commerce|online (store|shop)|shop(ping)? cart|sell products|products? catalog/ },
  blog:           { name: 'Blog / news section', price: 1499, match: /\bblog|news section|articles/ },
  seo:            { name: 'On-page SEO setup', price: 1999, match: /\bseo\b|google ranking|search engine/, includedIn: ['PREMIUM', 'ADVANCED'] },
  gbp:            { name: 'Google Business Profile setup', price: 999, match: /google business|google my business|\bgmb\b|google profile|maps listing/, includedIn: ['PREMIUM', 'ADVANCED'] },
  multilingual:   { name: 'Multi-language (e.g. Kannada / Hindi)', price: 2499, match: /multi-?lingual|languages?|kannada|hindi|translation/ },
  chatbot:        { name: 'AI / WhatsApp chatbot', price: 2999, match: /chat ?bot|ai assistant|auto reply|whatsapp bot/ },
  admin_panel:    { name: 'Admin panel to edit content', price: 4999, match: /admin (panel|dashboard)|cms|edit (it|content) (myself|themselves)/ },
  domain_hosting: { name: 'Domain + hosting (1 year)', price: 2499, match: /domain|hosting|\.com/ },
  content:        { name: 'Professional content writing', price: 1499, match: /content writing|copywriting|write (the )?content/ },
  maintenance:    { name: 'Monthly maintenance', price: 999, per: 'month', match: /maintenance|monthly support|updates every month/ },
  mobile_app:     { name: 'Android + iOS mobile app', price: 55000, match: /mobile app|android|ios app|play store|app store/ },
};

const PLAN_PRICES = { BASIC: 4999, PREMIUM: 8999, ADVANCED: 15000 };
const PLAN_WORDS = { BASIC: /\bbasic\b|4,?999/, PREMIUM: /\bpremium\b|8,?999/, ADVANCED: /\badvanced\b|15,?000/ };

async function addonCatalog() {
  let override = {};
  try { override = JSON.parse((await prisma.appSetting.findUnique({ where: { key: 'quote_addon_prices' } }))?.value || '{}'); } catch { override = {}; }
  return Object.fromEntries(Object.entries(ADDONS).map(([k, a]) => [k, { ...a, price: Number(override[k]) > 0 ? Number(override[k]) : a.price }]));
}

/**
 * Understand a spoken/written request.
 * @returns {{ plan: string|null, add: [{key, qty}], remove: [key], reset: boolean }}
 */
function parseRequest(text, catalog = ADDONS) {
  const t = String(text || '').toLowerCase();
  const plan = Object.keys(PLAN_WORDS).find((k) => PLAN_WORDS[k].test(t)) || null;
  // Split into "remove …" and "add …" parts so "add booking and remove the logo" works.
  const removePart = (t.match(/\b(?:remove|without|drop|take out|no)\s+([^.;]*)/) || [])[1] || '';
  const addPart = removePart ? t.replace(removePart, ' ') : t;
  const add = [];
  const remove = [];
  for (const [key, a] of Object.entries(catalog)) {
    if (removePart && a.match.test(removePart)) remove.push(key);
    else if (a.match.test(addPart)) {
      let qty = 1;
      if (a.per === 'page') { const m = addPart.match(/(\d+)\s*(more|extra|additional)?\s*pages?/); if (m) qty = Math.min(Number(m[1]), 30); }
      if (a.per === 'month') { const m = addPart.match(/(\d+)\s*months?/); if (m) qty = Math.min(Number(m[1]), 24); }
      add.push({ key, qty });
    }
  }
  return { plan, add, remove, reset: /new quotation|start over|fresh quotation/.test(t) };
}

/** Apply a request to a quote object { plan, addons: [{key, qty}] }. */
function applyRequest(quote, req) {
  const q = req.reset || !quote ? { plan: null, addons: [] } : { plan: quote.plan, addons: [...(quote.addons || [])] };
  if (req.plan) q.plan = req.plan;
  q.addons = q.addons.filter((a) => !req.remove.includes(a.key));
  for (const a of req.add) {
    const existing = q.addons.find((x) => x.key === a.key);
    if (existing) existing.qty = a.qty; else q.addons.push({ ...a });
  }
  return q;
}

/** Line items + total for a quote. Add-ons a plan already includes cost ₹0. */
async function priceQuote(quote) {
  const catalog = await addonCatalog();
  const plan = PLAN_PRICES[quote?.plan] ? quote.plan : 'BASIC';
  const lines = [{ key: 'plan', name: `${plan[0]}${plan.slice(1).toLowerCase()} website`, qty: 1, unit: PLAN_PRICES[plan], amount: PLAN_PRICES[plan] }];
  for (const a of quote?.addons || []) {
    const c = catalog[a.key];
    if (!c) continue;
    const included = (c.includedIn || []).includes(plan);
    const qty = Math.max(1, Number(a.qty) || 1);
    lines.push({
      key: a.key,
      name: `${c.name}${c.per && qty > 1 ? ` × ${qty} ${c.per}s` : c.per ? ` (per ${c.per})` : ''}`,
      qty, unit: included ? 0 : c.price, amount: included ? 0 : c.price * qty, included,
    });
  }
  return { plan, lines, total: lines.reduce((s, l) => s + l.amount, 0) };
}

const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

function describe(priced) {
  return priced.lines.map((l) => `${l.name}: ${l.included ? 'included' : inr(l.amount)}`).join('; ') + `. Total ${inr(priced.total)}`;
}

module.exports = { ADDONS, PLAN_PRICES, addonCatalog, parseRequest, applyRequest, priceQuote, describe, inr };
