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
    // One "assistant" agent calls Harshavardhan for summaries and approvals.
    // SARVAM_ASSISTANT_AGENT_ID is preferred; SARVAM_SUMMARY_AGENT_ID is accepted for compatibility.
    summaryAgentId: env('SARVAM_ASSISTANT_AGENT_ID', env('SARVAM_SUMMARY_AGENT_ID')),
    summaryAgentVersion: Number(env('SARVAM_ASSISTANT_AGENT_VERSION', env('SARVAM_SUMMARY_AGENT_VERSION', 1))),
  },
  ownerPhone: env('HARSHAVARDHAN_PHONE'),
  // Video-call link for consultations when Google isn't connected (e.g. your permanent Meet room).
  // Empty → each consultation gets its own free Jitsi Meet room.
  meetingRoomUrl: env('MEETING_ROOM_URL'),
  // Link clients use to review their project (your client portal). Used in "website ready to review" messages.
  clientPortalUrl: env('CLIENT_PORTAL_URL'),
  // When a lead is interested, WhatsApp them right away (from the linked WhatsApp) so they can
  // call/message the founder directly — no call transfer.
  founderName: env('FOUNDER_NAME', 'Harshavardhan'),
  founderIntroOnInterest: env('FOUNDER_INTRO_ON_INTEREST', 'false') === 'true', // off until enabled
  ownerCalls: {
    // Ask Harshavardhan on a call before a quotation goes to the client (default on)
    requireQuotationApproval: env('REQUIRE_QUOTATION_APPROVAL', 'true') !== 'false',
    callStartHour: Number(env('OWNER_CALL_START_HOUR', 9)), // IST
    callEndHour: Number(env('OWNER_CALL_END_HOUR', 21)),    // IST, exclusive
    maxAttempts: Number(env('OWNER_CALL_MAX_ATTEMPTS', 2)),
    retryMinutes: Number(env('OWNER_CALL_RETRY_MINUTES', 15)),
    resultTimeoutMinutes: Number(env('OWNER_CALL_TIMEOUT_MINUTES', 15)),
    // Jarvis calls automatically once a calling session goes quiet and there's something new
    autoUpdate: env('OWNER_AUTO_UPDATE', 'true') !== 'false',
    updateQuietMinutes: Number(env('OWNER_UPDATE_QUIET_MINUTES', 10)),
  },
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
    websiteTemplateName: env('WHATSAPP_WEBSITE_TEMPLATE_NAME', 'infinity_website_ready'),
    templateLang: env('WHATSAPP_TEMPLATE_LANG', 'en'),
  },

  // Claude Code token from the owner's Claude subscription (`claude setup-token`), used by the
  // claude-code-action workflow in each client repo. Not a pay-per-use API key.
  claudeCodeToken: env('CLAUDE_CODE_OAUTH_TOKEN'),

  // GitHub: one private repo per client website (fine-grained token with Administration + Contents write)
  github: {
    token: env('GITHUB_TOKEN'),
    owner: env('GITHUB_OWNER'), // org name; leave empty to create repos under the token's user
    repoPrefix: env('GITHUB_REPO_PREFIX', 'iwa-'),
  },

  openai: {
    apiKey: env('OPENAI_API_KEY'),
    model: env('OPENAI_MODEL', 'gpt-4o'),
  },
};

config.isConfigured = {
  sarvam: Boolean(config.sarvam.apiKey && config.sarvam.orgId && config.sarvam.workspaceId),
  ownerCalls: Boolean(config.sarvam.apiKey && config.sarvam.orgId && config.sarvam.workspaceId
    && config.sarvam.summaryAgentId && config.sarvam.connectionId && config.sarvam.agentPhoneNumber && config.ownerPhone),
  google: Boolean(config.google.clientId && config.google.clientSecret && config.google.refreshToken),
  whatsapp: Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId),
  openai: Boolean(config.openai.apiKey),
  github: Boolean(config.github.token),
  claudeBuilds: Boolean(config.github.token && config.claudeCodeToken),
};

module.exports = config;
