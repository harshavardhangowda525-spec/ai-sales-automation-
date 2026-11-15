// Clients added by sir himself (by voice through Jarvis, or from the dashboard), not from a sales call.
const prisma = require('../lib/prisma');
const { logAction } = require('../lib/logger');
const { toE164 } = require('../lib/phone');

const PLANS = ['BASIC', 'PREMIUM', 'ADVANCED'];

function normalizePlan(raw) {
  const p = String(raw || '').toUpperCase();
  return PLANS.find((x) => p.includes(x)) || 'UNKNOWN';
}

/** A usable phone number (10+ digits) in E.164, or null. */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 ? toE164(digits) : null;
}

/**
 * Create a client, or update the existing one with the same phone number.
 * @returns {{ client, created: boolean }}
 */
async function addClient({ business_name, contact_name, phone, plan, requirements, notes, email }, source = 'Jarvis') {
  const mail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim()) ? String(email).trim().toLowerCase() : null;
  const name = String(business_name || '').trim();
  if (!name) throw Object.assign(new Error('business name is required'), { status: 400 });
  const phoneE164 = normalizePhone(phone);

  if (phoneE164) {
    const existing = await prisma.client.findFirst({ where: { phone_number: phoneE164 }, orderBy: { created_at: 'desc' } });
    if (existing) {
      const updated = await prisma.client.update({
        where: { id: existing.id },
        data: {
          ...(contact_name && !existing.contact_name ? { contact_name } : {}),
          ...(mail ? { email: mail } : {}),
          ...(plan && normalizePlan(plan) !== 'UNKNOWN' ? { plan_interest: normalizePlan(plan) } : {}),
          ...(requirements ? { requirements: [existing.requirements, requirements].filter(Boolean).join('\n') } : {}),
          ...(notes ? { notes: [existing.notes, notes].filter(Boolean).join('\n') } : {}),
        },
      });
      await logAction(existing.id, 'CLIENT_UPDATED', `Updated by ${source}`);
      return { client: updated, created: false };
    }
  }

  const client = await prisma.client.create({
    data: {
      business_name: name,
      contact_name: contact_name?.trim() || null,
      email: mail,
      phone_number: phoneE164 || '-',
      call_outcome: 'MANUAL',
      plan_interest: normalizePlan(plan),
      requirements: requirements?.trim() || null,
      notes: notes?.trim() || null,
      portal_status: 'NEW_LEAD',
    },
  });
  await logAction(client.id, 'CLIENT_ADDED', `Added by ${source}${phoneE164 ? ` (${phoneE164})` : ' (no phone yet)'}`);
  return { client, created: true };
}

module.exports = { addClient, normalizePhone, normalizePlan };
