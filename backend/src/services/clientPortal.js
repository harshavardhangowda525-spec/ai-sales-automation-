// Sync approved quotations into the Client Portal (client-portal-delta-liart.vercel.app) through
// its secured /api/integrations/sales-lead endpoint, then send the client the portal links.
const config = require('../lib/config');
const prisma = require('../lib/prisma');
const { logAction } = require('../lib/logger');
const { PLANS } = require('./proposalGenerator');
const waLinked = require('./waLinked');
const { formatMeetingTime } = require('../lib/time');

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function isConfigured() {
  return Boolean(config.clientPortalUrl && config.portalIntegrationSecret);
}

function firstName(client) {
  return client.contact_name?.split(' ')[0] || 'there';
}

/** Create client + proposal in the portal and publish it. Requires client.email. */
async function pushToPortal(client) {
  const plan = PLANS[client.plan_interest] ? client.plan_interest : 'BASIC';
  const p = PLANS[plan];
  const res = await fetch(`${config.clientPortalUrl.replace(/\/$/, '')}/api/integrations/sales-lead`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.portalIntegrationSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      business_name: client.business_name,
      owner_name: client.contact_name || null,
      email: client.email,
      phone: client.phone_number !== '-' ? client.phone_number : null,
      plan,
      kind: 'website',
      plan_price: Number(String(p.price).replace(/,/g, '')),
      plan_name: `${p.name} website`,
      plan_features: p.features,
      requirements: client.requirements || null,
      meeting: client.meeting_time ? formatMeetingTime(client.meeting_time) : null,
    }),
    signal: AbortSignal.timeout(45000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Client Portal ${res.status}: ${json.error || 'request failed'}`);
  const updated = await prisma.client.update({
    where: { id: client.id },
    data: {
      awaiting_email: false,
      portal_client_id: json.client_id,
      portal_proposal_id: json.proposal_id,
      portal_proposal_link: json.proposal_link,
      portal_invite_link: json.invite_link || client.portal_invite_link,
      portal_synced_at: new Date(),
      proposal_sent: true,
      ...(['CONVERTED', 'LOST'].includes(client.portal_status) ? {} : { portal_status: client.meeting_link ? 'MEETING_SCHEDULED' : 'PROPOSAL_SENT' }),
    },
  });
  await logAction(client.id, 'PORTAL_PROPOSAL_CREATED',
    `Proposal ${json.number} (₹${json.total}) published in the Client Portal${json.used_package ? ` using "${json.used_package}"` : ''}`);
  return { client: updated, portal: json };
}

function portalMessage(client, portal) {
  const lines = [
    `Hi ${firstName(client)}! 👋`,
    '',
    `Your proposal for *${client.business_name}* is ready in your private client portal${portal.number ? ` (${portal.number})` : ''}.`,
  ];
  if (portal.invite_link) {
    lines.push('', '1️⃣ Set up your portal access (one-time link):', portal.invite_link, '', '2️⃣ Then review and accept your proposal here:', portal.proposal_link);
  } else {
    lines.push('', '📄 Review and accept it here:', portal.proposal_link);
  }
  if (client.meeting_time && client.meeting_link) {
    lines.push('', `📅 Our consultation: ${formatMeetingTime(client.meeting_time)}`, `🔗 Join: ${client.meeting_link}`);
  }
  lines.push('', '*Infinity Web & Apps* — any questions, just reply here! 😊');
  return lines.join('\n');
}

/**
 * Called when sir approves a quotation. With a known email → portal + links now.
 * Without → ask the client for their email on WhatsApp and wait for the reply.
 * @returns {{ status: 'sent' | 'asked_email' }}
 */
async function deliverApprovedQuotation(client) {
  if (!(await waLinked.hasSession())) throw new Error('Your WhatsApp is not linked');
  if (client.email) {
    const { client: c, portal } = await pushToPortal(client);
    await waLinked.sendText(c.phone_number, portalMessage(c, portal));
    await logAction(c.id, 'WHATSAPP_SENT', 'Client Portal links sent from your WhatsApp');
    return { status: 'sent' };
  }
  await waLinked.sendText(client.phone_number, `Hi ${firstName(client)}! 👋

Thanks again for your interest in *Infinity Web & Apps*. Your website proposal for *${client.business_name}* is ready.

Could you reply with your *email address*? I'll set up your private client portal where you can review and accept it. 😊`);
  await prisma.client.update({ where: { id: client.id }, data: { awaiting_email: true } });
  await logAction(client.id, 'PORTAL_EMAIL_REQUESTED', 'Asked the client for their email on WhatsApp to set up their portal');
  return { status: 'asked_email' };
}

/**
 * Incoming WhatsApp message (from the linked WhatsApp). Only acts for clients we're waiting on
 * for an email, and only when the message contains one — everything else is ignored.
 */
async function handleIncomingMessage(fromDigits, text) {
  const email = String(text || '').match(EMAIL_RE)?.[0]?.toLowerCase();
  if (!email) return false;
  const candidates = await prisma.client.findMany({ where: { awaiting_email: true }, orderBy: { updated_at: 'desc' } });
  const client = candidates.find((c) => String(c.phone_number).replace(/\D/g, '').endsWith(fromDigits.slice(-10)));
  if (!client) return false;
  const withEmail = await prisma.client.update({ where: { id: client.id }, data: { email } });
  await logAction(client.id, 'CLIENT_EMAIL_RECEIVED', `Client replied with email ${email}`);
  try {
    const { client: c, portal } = await pushToPortal(withEmail);
    await waLinked.sendText(c.phone_number, `Thank you! 🙏\n\n${portalMessage(c, portal)}`);
    await logAction(c.id, 'WHATSAPP_SENT', 'Client Portal links sent from your WhatsApp');
  } catch (err) {
    await logAction(client.id, 'PORTAL_SYNC_ERROR', err.message);
  }
  return true;
}

module.exports = { isConfigured, pushToPortal, deliverApprovedQuotation, handleIncomingMessage, portalMessage, EMAIL_RE };
