const PDFDocument = require('pdfkit');
const fontkit = require('fontkit');
const path = require('path');
const config = require('../lib/config');
const prisma = require('../lib/prisma');
const { logAction } = require('../lib/logger');
const { formatDateIN, formatMeetingTime, istParts } = require('../lib/time');

// ── Fonts ────────────────────────────────────────────────────────────────────────────────
// Inter ships split by unicode subset: "latin" has the text glyphs, "latin-ext" has ₹.
const fontDir = path.join(path.dirname(require.resolve('@fontsource/inter/package.json')), 'files');
const FONTS = {
  regular: path.join(fontDir, 'inter-latin-400-normal.woff'),
  medium: path.join(fontDir, 'inter-latin-500-normal.woff'),
  bold: path.join(fontDir, 'inter-latin-700-normal.woff'),
};
// PDFKit caches fonts by PostScript name and both Inter subsets share it, so the ₹ glyph is drawn
// as a vector path straight from the latin-ext font file instead of being typeset.
const RUPEE = {
  bold: fontkit.openSync(path.join(fontDir, 'inter-latin-ext-700-normal.woff')),
  regular: fontkit.openSync(path.join(fontDir, 'inter-latin-ext-400-normal.woff')),
};

// ── Brand ────────────────────────────────────────────────────────────────────────────────
const C = {
  navy: '#0A0F1E',
  card: '#111827',
  blue: '#3B82F6',
  blueSoft: '#EFF6FF',
  green: '#10B981',
  amber: '#F59E0B',
  ink: '#111827',
  body: '#374151',
  muted: '#6B7280',
  line: '#E5E7EB',
  white: '#FFFFFF',
};

const PLANS = {
  BASIC: {
    name: 'Basic',
    price: '4,999',
    tagline: 'A clean, professional presence online',
    features: [
      'Professional 3–5 page website',
      'Mobile responsive design',
      'WhatsApp chat button integration',
      'Google Maps location embed',
      'Contact form',
      '1 round of revisions',
      'Delivery in 5–7 working days',
    ],
  },
  PREMIUM: {
    name: 'Premium',
    price: '8,999',
    tagline: 'Get found on Google and grow faster',
    features: [
      'Everything in Basic',
      'Up to 8 pages',
      'On-page SEO optimisation',
      'Google Business Profile setup assistance',
      'Social media integration',
      '2 rounds of revisions',
      'Delivery in 10–12 working days',
    ],
  },
  ADVANCED: {
    name: 'Advanced',
    price: '15,000',
    tagline: 'A complete digital storefront for your business',
    features: [
      'Everything in Premium',
      'Custom UI/UX design',
      'Online booking / appointment system',
      'Payment gateway integration',
      'WhatsApp Business API integration',
      '1 month free maintenance',
      '3 rounds of revisions',
      'Delivery in 18–21 working days',
    ],
  },
};

// Phone-friendly page: ~A5 width with a taller aspect, so text stays large when viewed on a phone.
const PAGE = { width: 420, height: 760 };
const M = 28; // margin
const W = PAGE.width - M * 2;

// ── Drawing helpers ──────────────────────────────────────────────────────────────────────
/** Draw text that may contain ₹ — switches to the latin-ext font just for that glyph. */
function richText(doc, text, x, y, { font = 'regular', size = 11, color = C.body, width, align = 'left' } = {}) {
  doc.fillColor(color).fontSize(size);
  const parts = String(text).split(/(₹)/).filter(Boolean);
  if (parts.length === 1) {
    doc.font(font).text(text, x, y, { width, align });
    return;
  }
  const rupeeFont = font === 'bold' ? RUPEE.bold : RUPEE.regular;
  const scale = size / rupeeFont.unitsPerEm;
  const glyph = rupeeFont.glyphForCodePoint(0x20B9);
  const widths = parts.map((part) => (part === '₹' ? glyph.advanceWidth * scale : doc.font(font).widthOfString(part)));
  const total = widths.reduce((a, b) => a + b, 0);
  let cx = x;
  if (width && align === 'right') cx = x + width - total;
  else if (width && align === 'center') cx = x + (width - total) / 2;
  const baseline = y + (rupeeFont.ascent / rupeeFont.unitsPerEm) * size;
  parts.forEach((part, i) => {
    if (part === '₹') {
      doc.save().translate(cx, baseline).scale(scale, -scale).path(glyph.path.toSVG()).fill(color).restore();
    } else {
      doc.font(font).fillColor(color).text(part, cx, y, { lineBreak: false });
    }
    cx += widths[i];
  });
}

function checkMark(doc, x, y, color = C.green) {
  doc.save().circle(x + 6, y + 6, 6).fill(color);
  doc.lineWidth(1.6).strokeColor(C.white)
    .moveTo(x + 3.2, y + 6.2).lineTo(x + 5.3, y + 8.3).lineTo(x + 9, y + 4.2).stroke();
  doc.restore();
}

function sectionTitle(doc, title, y) {
  doc.save().rect(M, y + 2, 3, 13).fill(C.blue).restore();
  doc.font('bold').fontSize(13).fillColor(C.ink).text(title, M + 10, y);
  return y + 24;
}

function ensureSpace(doc, y, needed) {
  if (y + needed > PAGE.height - 50) {
    doc.addPage();
    return M + 10;
  }
  return y;
}

function drawHeader(doc, { number, date, client }) {
  // Navy band
  doc.rect(0, 0, PAGE.width, 150).fill(C.navy);
  // Logo placeholder
  doc.roundedRect(M, 24, 46, 46, 10).fill(C.blue);
  doc.font('bold').fontSize(15).fillColor(C.white).text('IWA', M, 40, { width: 46, align: 'center' });
  doc.font('bold').fontSize(14).fillColor(C.white).text('Infinity Web & Apps', M + 58, 28);
  doc.font('regular').fontSize(9.5).fillColor('#9CA3AF').text('Websites · Apps · Digital Growth — Bengaluru', M + 58, 48);

  doc.font('bold').fontSize(22).fillColor(C.white).text('WEBSITE PROPOSAL', M, 92);
  doc.font('regular').fontSize(10).fillColor('#9CA3AF')
    .text(`Proposal #: ${number}`, M, 122, { continued: true })
    .text(`     Date: ${date}`);

  // Prepared for card
  let y = 168;
  doc.roundedRect(M, y, W, 66, 10).fill(C.blueSoft);
  doc.font('medium').fontSize(9).fillColor(C.blue).text('PREPARED FOR', M + 14, y + 12);
  doc.font('bold').fontSize(14).fillColor(C.ink).text(client.business_name, M + 14, y + 25, { width: W - 28, ellipsis: true, height: 18 });
  const contactLine = [client.contact_name, client.phone_number].filter(Boolean).join('  ·  ');
  doc.font('regular').fontSize(10.5).fillColor(C.body).text(`Contact: ${contactLine}`, M + 14, y + 45, { width: W - 28 });
  return y + 66 + 22;
}

function drawPlan(doc, planKey, y, { recommended = false } = {}) {
  const plan = PLANS[planKey];
  const boxH = 70 + plan.features.length * 21;
  y = ensureSpace(doc, y, boxH + 10);

  doc.roundedRect(M, y, W, boxH, 12).lineWidth(1.5).strokeColor(C.blue).stroke();
  doc.roundedRect(M, y, W, 54, 12).fill(C.blue);
  doc.rect(M, y + 40, W, 14).fill(C.blue);

  doc.font('bold').fontSize(15).fillColor(C.white).text(`${plan.name.toUpperCase()} PLAN`, M + 14, y + 11);
  doc.font('regular').fontSize(9.5).fillColor('#DBEAFE').text(plan.tagline, M + 14, y + 31, { width: W - 140 });
  richText(doc, `₹${plan.price}`, M + 14, y + 12, { font: 'bold', size: 20, color: C.white, width: W - 28, align: 'right' });
  if (recommended) {
    doc.font('medium').fontSize(8).fillColor('#DBEAFE').text('RECOMMENDED FOR YOU', M + 14, y + 37, { width: W - 28, align: 'right' });
  } else {
    doc.font('regular').fontSize(8.5).fillColor('#DBEAFE').text('one-time', M + 14, y + 37, { width: W - 28, align: 'right' });
  }

  let fy = y + 66;
  for (const f of plan.features) {
    checkMark(doc, M + 14, fy + 1);
    richText(doc, f, M + 34, fy, { size: 11, color: C.ink, width: W - 48 });
    fy += 21;
  }
  return y + boxH + 18;
}

/** Add-ons table + total (when the quotation has add-ons). */
function drawQuoteTable(doc, priced, y) {
  const rows = priced.lines.slice(1);
  y = ensureSpace(doc, y, 60 + rows.length * 24);
  y = sectionTitle(doc, 'Add-ons & total', y);
  const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`;
  for (const l of rows) {
    doc.roundedRect(M, y, W, 22, 6).fill('#F9FAFB');
    doc.font('medium').fontSize(10.5).fillColor(C.ink).text(l.name, M + 10, y + 6, { width: W - 120, lineBreak: false, ellipsis: true });
    richText(doc, l.included ? 'Included' : inr(l.amount), M + 10, y + 6, { font: 'bold', size: 10.5, color: l.included ? C.muted : C.blue, width: W - 20, align: 'right' });
    y += 26;
  }
  doc.roundedRect(M, y + 4, W, 34, 8).fill(C.blue);
  doc.font('bold').fontSize(12).fillColor(C.white).text('TOTAL (one-time)', M + 14, y + 15);
  richText(doc, inr(priced.total), M + 14, y + 12, { font: 'bold', size: 16, color: C.white, width: W - 28, align: 'right' });
  return y + 50;
}

function drawOtherPlans(doc, exclude, y) {
  const others = Object.keys(PLANS).filter((k) => k !== exclude);
  y = ensureSpace(doc, y, 30 + others.length * 26);
  doc.font('medium').fontSize(10).fillColor(C.muted).text('Other options', M, y);
  y += 18;
  for (const k of others) {
    doc.roundedRect(M, y, W, 22, 6).fill('#F9FAFB');
    doc.font('medium').fontSize(10.5).fillColor(C.ink).text(`${PLANS[k].name} plan`, M + 10, y + 6, { width: W - 90, lineBreak: false });
    richText(doc, `₹${PLANS[k].price}`, M + 10, y + 6, { font: 'bold', size: 10.5, color: C.blue, width: W - 20, align: 'right' });
    y += 26;
  }
  return y + 6;
}

function drawRequirements(doc, requirements, y) {
  if (!requirements) return y;
  y = ensureSpace(doc, y, 80);
  y = sectionTitle(doc, 'What you told us', y);
  doc.font('regular').fontSize(11).fillColor(C.body);
  const h = doc.heightOfString(requirements, { width: W - 24 });
  doc.roundedRect(M, y - 4, W, h + 20, 8).fill('#F9FAFB');
  doc.fillColor(C.body).text(requirements, M + 12, y + 6, { width: W - 24 });
  return y + h + 30;
}

function drawTermsAndProcess(doc, y) {
  y = sectionTitle(doc, 'Payment Terms', y);
  const terms = [
    '50% advance to begin work',
    '50% on final delivery',
    'Hosting & domain: ₹3,000–5,000/year (billed separately)',
    '1 year free support included',
  ];
  for (const t of terms) {
    doc.save().circle(M + 6, y + 7, 2.5).fill(C.blue).restore();
    richText(doc, t, M + 16, y, { size: 11.5, color: C.ink, width: W - 16 });
    y += 21;
  }

  y += 14;
  y = sectionTitle(doc, 'Our Process', y);
  const steps = [
    ['Requirements call', '30 minutes to understand your business'],
    ['Design mockup', 'Shared with you in 2–3 days'],
    ['Development', 'Begins right after your approval'],
    ['Testing & revisions', 'We polish until you are happy'],
    ['Final delivery & handover', 'Your site goes live'],
  ];
  steps.forEach(([title, sub], i) => {
    doc.circle(M + 12, y + 12, 12).fill(C.blue);
    doc.font('bold').fontSize(11).fillColor(C.white).text(String(i + 1), M, y + 6, { width: 24, align: 'center' });
    if (i < steps.length - 1) doc.save().moveTo(M + 12, y + 25).lineTo(M + 12, y + 40).lineWidth(1.5).strokeColor('#BFDBFE').stroke().restore();
    doc.font('bold').fontSize(11.5).fillColor(C.ink).text(title, M + 34, y + 1);
    doc.font('regular').fontSize(10).fillColor(C.muted).text(sub, M + 34, y + 16);
    y += 42;
  });
  return y + 6;
}

function drawClosing(doc, { meetingTime, meetLink }, y) {
  y = ensureSpace(doc, y, 190);
  const boxH = 150;
  doc.roundedRect(M, y, W, boxH, 12).fill(C.navy);
  doc.font('bold').fontSize(14).fillColor(C.white).text('Ready to get started?', M + 16, y + 16);
  doc.font('regular').fontSize(10.5).fillColor('#9CA3AF').text('Join your free consultation:', M + 16, y + 36);

  // Date row
  doc.roundedRect(M + 16, y + 58, 40, 18, 4).fill(C.blue);
  doc.font('bold').fontSize(8).fillColor(C.white).text('DATE', M + 16, y + 63, { width: 40, align: 'center' });
  doc.font('bold').fontSize(11.5).fillColor(C.white).text(formatMeetingTime(meetingTime), M + 64, y + 61, { width: W - 80 });

  // Link row
  doc.roundedRect(M + 16, y + 86, 40, 18, 4).fill(C.green);
  doc.font('bold').fontSize(8).fillColor(C.white).text('MEET', M + 16, y + 91, { width: 40, align: 'center' });
  const link = meetLink || 'Link will be shared on WhatsApp';
  doc.font('medium').fontSize(11).fillColor('#93C5FD')
    .text(link, M + 64, y + 89, { width: W - 80, link: meetLink || undefined, underline: Boolean(meetLink) });

  doc.font('regular').fontSize(9.5).fillColor('#9CA3AF')
    .text('Reply on WhatsApp if you would like a different time.', M + 16, y + 120, { width: W - 32 });
  y += boxH + 22;

  const wa = config.ownerWhatsApp || '+91-XXXXXXXXXX';
  doc.font('bold').fontSize(11.5).fillColor(C.ink).text(`Questions? WhatsApp us: ${wa}`, M, y, { width: W, align: 'center' });
  doc.font('regular').fontSize(10).fillColor(C.muted)
    .text(`${config.businessWebsite} | ${config.businessEmail}`, M, y + 18, { width: W, align: 'center' });
  return y + 40;
}

function drawFooters(doc, number) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = PAGE.height - 30;
    doc.save().moveTo(M, fy - 8).lineTo(PAGE.width - M, fy - 8).lineWidth(0.5).strokeColor(C.line).stroke().restore();
    doc.font('regular').fontSize(8).fillColor(C.muted)
      .text(`Infinity Web & Apps · ${number}`, M, fy, { width: W / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, M + W / 2, fy, { width: W / 2, align: 'right', lineBreak: false });
  }
}

/** Render the proposal PDF and return it as a Buffer. Pure — no DB access. */
function renderProposalPdf({ client, number, date = formatDateIN(), meetingTime, meetLink, priced = null }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [PAGE.width, PAGE.height],
      margins: { top: M, bottom: 20, left: M, right: M },
      bufferPages: true,
      info: {
        Title: `Website Proposal ${number} — ${client.business_name}`,
        Author: 'Infinity Web & Apps',
        Subject: 'Website Proposal',
      },
    });
    for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, file);

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // PAGE 1 — header + proposed plan
    let y = drawHeader(doc, { number, date, client });
    const chosen = priced?.plan || client.plan_interest;
    const planKey = PLANS[chosen] ? chosen : 'PREMIUM';
    y = sectionTitle(doc, 'Proposed Plan', y);
    y = drawPlan(doc, planKey, y, { recommended: !PLANS[chosen] });
    if (priced && priced.lines.length > 1) y = drawQuoteTable(doc, priced, y);
    else if (!PLANS[chosen]) y = drawOtherPlans(doc, planKey, y);
    drawRequirements(doc, client.requirements, y);

    // PAGE 2 — terms, process, closing
    doc.addPage();
    y = drawTermsAndProcess(doc, M + 10);
    drawClosing(doc, { meetingTime, meetLink }, y);

    drawFooters(doc, number);
    doc.end();
  });
}

/**
 * Generate the proposal PDF for a client, store it in Postgres (Neon), and save the public URL.
 * @returns {Promise<{proposalUrl: string, number: string, proposalId: string}>}
 */
async function generateProposal(client) {
  const fresh = await prisma.client.findUnique({ where: { id: client.id } });
  const plan = fresh.plan_interest;

  // Reserve the next sequence number first so the number printed on the PDF is unique.
  const placeholder = await prisma.proposal.create({
    data: { client_id: fresh.id, plan, number: `pending-${fresh.id}-${Date.now()}`, pdf: Buffer.alloc(0) },
  });
  const year = istParts().year;
  const number = `IWA-${year}-${String(placeholder.seq).padStart(4, '0')}`;

  try {
    let priced = null;
    if (fresh.quote) priced = await require('./quoteBuilder').priceQuote(fresh.quote);
    const pdf = await renderProposalPdf({
      priced,
      client: fresh,
      number,
      meetingTime: fresh.meeting_time,
      meetLink: fresh.meeting_link,
    });
    await prisma.proposal.update({ where: { id: placeholder.id }, data: { number, pdf } });
  } catch (err) {
    await prisma.proposal.delete({ where: { id: placeholder.id } }).catch(() => {});
    throw err;
  }

  const proposalUrl = `${config.publicBaseUrl}/proposals/${placeholder.id}.pdf`;
  await prisma.client.update({ where: { id: fresh.id }, data: { proposal_url: proposalUrl } });
  await logAction(fresh.id, 'PROPOSAL_GENERATED', `${number} (${plan}) — ${proposalUrl}`);
  return { proposalUrl, number, proposalId: placeholder.id };
}

module.exports = { generateProposal, renderProposalPdf, PLANS };
