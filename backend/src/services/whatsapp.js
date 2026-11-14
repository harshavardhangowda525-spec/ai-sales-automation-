const config = require('../lib/config');
const { logAction } = require('../lib/logger');
const { formatMeetingTime } = require('../lib/time');
const { toWhatsAppId } = require('../lib/phone');

const hasDocumentHeader = () => (process.env.WHATSAPP_TEMPLATE_HAS_DOCUMENT || 'true') !== 'false';

/** The exact message body (used for the free-form fallback and shown in the dashboard log). */
function buildMessageText({ name, businessName, proposalUrl, meetTime, meetLink }) {
  return `Hey ${name}! 👋

Thanks for your time today — really great speaking with you!

Here's your personalised website proposal for *${businessName}*:
📄 ${proposalUrl}

We've also scheduled your *FREE 30-minute consultation*:
📅 ${meetTime}
🔗 ${meetLink}

We'll walk you through exactly what your website will look like, answer all your questions, and get things moving fast! 🚀

*Infinity Web & Apps* — Building Bengaluru's Digital Future
Any questions? Just reply here! 😊`;
}

// Meta rejects template params containing newlines, tabs or 4+ consecutive spaces.
const param = (text) => ({ type: 'text', text: String(text || '-').replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, ' ').slice(0, 1000) });

async function callGraph(body) {
  const { apiVersion, phoneNumberId, token } = config.whatsapp;
  const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`WhatsApp API ${res.status}: ${JSON.stringify(json.error || json).slice(0, 600)}`);
  }
  return json;
}

/**
 * Send the proposal + Meet details to the client on WhatsApp.
 * Business-initiated messages must use an approved template (WHATSAPP_TEMPLATE_NAME).
 * Set WHATSAPP_TEMPLATE_NAME=none to send a free-form text instead (only works inside a 24h
 * customer-service window, i.e. if the client messaged you first).
 */
async function sendWhatsAppMessage(client, proposalUrl, meetLink, meetTime, { proposalNumber } = {}) {
  const vars = {
    name: client.contact_name?.split(' ')[0] || 'there',
    businessName: client.business_name,
    proposalUrl,
    meetTime: formatMeetingTime(meetTime),
    meetLink: meetLink || 'Link will be shared shortly',
  };
  const to = toWhatsAppId(client.phone_number);

  if (!config.isConfigured.whatsapp) {
    await logAction(client.id, 'WHATSAPP_SENT_MOCK',
      `WhatsApp not configured — message that would be sent to +${to}:\n\n${buildMessageText(vars)}`);
    return { mock: true, messageId: null };
  }

  const { templateName, templateLang } = config.whatsapp;
  let body;
  if (templateName && templateName !== 'none') {
    const components = [];
    if (hasDocumentHeader()) {
      components.push({
        type: 'header',
        parameters: [{
          type: 'document',
          document: { link: proposalUrl, filename: `${proposalNumber || 'Proposal'} - ${client.business_name}.pdf` },
        }],
      });
    }
    components.push({
      type: 'body',
      parameters: [vars.name, vars.businessName, vars.proposalUrl, vars.meetTime, vars.meetLink].map(param),
    });
    body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: templateName, language: { code: templateLang }, components },
    };
  } else {
    body = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: true, body: buildMessageText(vars) },
    };
  }

  const json = await callGraph(body);
  const messageId = json.messages?.[0]?.id || null;
  await logAction(client.id, 'WHATSAPP_SENT',
    `Sent ${body.type === 'template' ? `template "${templateName}"` : 'text'} to +${to} (message id ${messageId})`);
  return { mock: false, messageId };
}

function buildWebsiteText({ name, businessName, websiteUrl }) {
  return `Hey ${name}! 🎉

Great news — your website for *${businessName}* is live:
🌐 ${websiteUrl}

Take a look and tell us what you think. If you'd like any changes, just reply here and we'll take care of it.

*Infinity Web & Apps* — Building Bengaluru's Digital Future`;
}

/**
 * Send the live website link to the client (after Harshavardhan approves on the call).
 * Template WHATSAPP_WEBSITE_TEMPLATE_NAME, body params: {{1}} name, {{2}} business, {{3}} website URL.
 */
async function sendWebsiteReadyMessage(client, websiteUrl) {
  const vars = {
    name: client.contact_name?.split(' ')[0] || 'there',
    businessName: client.business_name,
    websiteUrl,
  };
  const to = toWhatsAppId(client.phone_number);

  if (!config.isConfigured.whatsapp) {
    await logAction(client.id, 'WEBSITE_LINK_SENT_MOCK',
      `WhatsApp not configured — message that would be sent to +${to}:\n\n${buildWebsiteText(vars)}`);
    return { mock: true, messageId: null };
  }

  const { websiteTemplateName, templateLang } = config.whatsapp;
  const body = websiteTemplateName && websiteTemplateName !== 'none'
    ? {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: websiteTemplateName,
        language: { code: templateLang },
        components: [{ type: 'body', parameters: [vars.name, vars.businessName, vars.websiteUrl].map(param) }],
      },
    }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: true, body: buildWebsiteText(vars) } };

  const json = await callGraph(body);
  const messageId = json.messages?.[0]?.id || null;
  await logAction(client.id, 'WEBSITE_LINK_SENT', `Sent website link ${websiteUrl} to +${to} (message id ${messageId})`);
  return { mock: false, messageId };
}

module.exports = { sendWhatsAppMessage, sendWebsiteReadyMessage, buildMessageText, buildWebsiteText };
