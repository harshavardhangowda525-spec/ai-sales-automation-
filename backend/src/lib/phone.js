/** Normalise an Indian phone number to E.164 (+91XXXXXXXXXX). Leaves other formats mostly intact. */
function toE164(raw) {
  if (!raw) return raw;
  let digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  digits = digits.replace(/^0+/, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return `+${digits}`;
}

/** WhatsApp Cloud API wants the number without the leading "+". */
function toWhatsAppId(raw) {
  return toE164(raw)?.replace(/^\+/, '');
}

module.exports = { toE164, toWhatsAppId };
