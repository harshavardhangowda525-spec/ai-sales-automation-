// Pre-written WhatsApp messages, opened in Harsha's own WhatsApp (no Meta template needed).
const TZ = 'Asia/Kolkata';

function meetingText(d) {
  if (!d) return null;
  const day = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short' }).format(new Date(d));
  const time = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(d)).toUpperCase();
  return `${day} at ${time} IST`;
}

export function proposalMessage(c) {
  const name = c.contact_name?.split(' ')[0] || 'there';
  const lines = [
    `Hey ${name}! 👋`,
    '',
    'Thanks for your time today — really great speaking with you!',
  ];
  if (c.proposal_url) {
    lines.push('', `Here's your personalised website proposal for *${c.business_name}*:`, `📄 ${c.proposal_url}`);
  }
  if (c.meeting_time || c.meeting_link) {
    lines.push('', 'Your *FREE 30-minute consultation* with our founder is booked:');
    if (c.meeting_time) lines.push(`📅 ${meetingText(c.meeting_time)}`);
    if (c.meeting_link) lines.push(`🔗 Join here: ${c.meeting_link}`);
  }
  lines.push(
    '',
    "We'll walk you through exactly what your website will look like, answer all your questions, and get things moving fast! 🚀",
    '',
    "*Infinity Web & Apps* — Building Bengaluru's Digital Future",
    'Any questions? Just reply here! 😊',
  );
  return lines.join('\n');
}

export function websiteMessage(c) {
  const name = c.contact_name?.split(' ')[0] || 'there';
  return [
    `Hey ${name}! 🎉`,
    '',
    `Great news — your website for *${c.business_name}* is live:`,
    `🌐 ${c.website_url}`,
    '',
    "Take a look and tell us what you think. If you'd like any changes, just reply here and we'll take care of it.",
    '',
    "*Infinity Web & Apps* — Building Bengaluru's Digital Future",
  ].join('\n');
}

/** WhatsApp send link (direct, not wa.me — its redirect corrupts emojis) that opens WhatsApp (app or Web) with the message typed in, addressed to the client. */
export function whatsappLink(phone, text) {
  return `https://api.whatsapp.com/send?phone=${String(phone).replace(/\D/g, '')}&text=${encodeURIComponent(text)}`;
}
