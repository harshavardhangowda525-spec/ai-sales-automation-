// Central place to read environment configuration. Never hardcode credentials.
const env = (key, fallback = undefined) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};

const config = {
  port: Number(env('PORT', 3000)),
  nodeEnv: env('NODE_ENV', 'development'),
  publicBaseUrl: (env('PUBLIC_BASE_URL', `http://localhost:${env('PORT', 3000)}`)).replace(/\/$/, ''),
  frontendUrls: env('FRONTEND_URL', 'http://localhost:5173').split(',').map((s) => s.trim().replace(/\/$/, '')),
  adminToken: env('ADMIN_TOKEN'),
  webhookSecret: env('SARVAM_WEBHOOK_SECRET'),

  sarvam: {
    apiKey: env('SARVAM_API_KEY'),
    baseUrl: env('SARVAM_API_BASE', 'https://apps.sarvam.ai/api').replace(/\/$/, ''),
    orgId: env('SARVAM_ORG_ID'),
    workspaceId: env('SARVAM_WORKSPACE_ID'),
    connectionId: env('SARVAM_CONNECTION_ID'),
    agentPhoneNumber: env('SARVAM_AGENT_PHONE_NUMBER'),
    salesAgentId: env('SARVAM_SALES_AGENT_ID'),
    salesAgentVersion: Number(env('SARVAM_SALES_AGENT_VERSION', 1)),
    summaryAgentId: env('SARVAM_SUMMARY_AGENT_ID'),
    summaryAgentVersion: Number(env('SARVAM_SUMMARY_AGENT_VERSION', 1)),
  },
  ownerPhone: env('HARSHAVARDHAN_PHONE'),
  ownerWhatsApp: env('HARSHAVARDHAN_WHATSAPP', env('HARSHAVARDHAN_PHONE')),
  businessEmail: env('BUSINESS_EMAIL', 'akagaminodfshanks@gmail.com'),
  businessWebsite: env('BUSINESS_WEBSITE', 'infinity-web-apps.com'),

  google: {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    redirectUri: env('GOOGLE_REDIRECT_URI', 'http://localhost:3000/oauth2callback'),
    refreshToken: env('GOOGLE_REFRESH_TOKEN'),
    calendarId: env('GOOGLE_CALENDAR_ID', 'primary'),
    workingDays: env('WORKING_DAYS', '1,2,3,4,5,6').split(',').map(Number), // 0=Sun … 6=Sat
  },

  whatsapp: {
    token: env('WHATSAPP_API_TOKEN'),
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    apiVersion: env('WHATSAPP_API_VERSION', 'v21.0'),
    templateName: env('WHATSAPP_TEMPLATE_NAME', 'infinity_proposal'),
    templateLang: env('WHATSAPP_TEMPLATE_LANG', 'en'),
  },

  openai: {
    apiKey: env('OPENAI_API_KEY'),
    model: env('OPENAI_MODEL', 'gpt-4o'),
  },
};

config.isConfigured = {
  sarvam: Boolean(config.sarvam.apiKey && config.sarvam.orgId && config.sarvam.workspaceId),
  google: Boolean(config.google.clientId && config.google.clientSecret && config.google.refreshToken),
  whatsapp: Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId),
  openai: Boolean(config.openai.apiKey),
};

module.exports = config;
