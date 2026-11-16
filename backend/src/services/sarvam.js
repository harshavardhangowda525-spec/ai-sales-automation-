// Sarvam Voice Agents API (https://docs.sarvam.ai/voice-agents). Auth: X-API-Key header.
const config = require('../lib/config');
const prisma = require('../lib/prisma');
const { logAction, logError } = require('../lib/logger');
const { toE164 } = require('../lib/phone');
const { istParts, istDate } = require('../lib/time');

function base() {
  const { baseUrl, orgId, workspaceId } = config.sarvam;
  return { baseUrl, orgId, workspaceId };
}

async function sarvamRequest(method, urlPath, body) {
  const res = await fetch(`${config.sarvam.baseUrl}${urlPath}`, {
    method,
    headers: { 'X-API-Key': config.sarvam.apiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sarvam ${method} ${urlPath} → ${res.status}: ${JSON.stringify(json).slice(0, 1500)}`);
  return json;
}

function connectionConfig() {
  return {
    connection_id: config.sarvam.connectionId,
    agent_phone_number: config.sarvam.agentPhoneNumber,
  };
}

function webhookConfig(campaignId) {
  const secret = config.webhookSecret ? `?secret=${encodeURIComponent(config.webhookSecret)}` : '';
  return {
    url: `${config.publicBaseUrl}/webhook/sarvam${secret}`,
    metadata: { campaign_id: campaignId },
  };
}

/** Names Sarvam reports as "not found in agent variables", or [] if that isn't the error. */
function missingAgentVariables(err) {
  const m = /Agent variables '\{([^}]*)\}' not found/.exec(err.message || '');
  return m ? m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
}

/**
 * Instant outbound call (used for calls to Harshavardhan).
 * - appOverrides.initial_bot_message sets what the agent says first on this call.
 * - Variables the agent doesn't define are dropped and the call is retried once, so a call still
 *   goes through when the agent hasn't been updated with every variable.
 */
async function placeOutboundCall({ phoneNumber, appId, appVersion, variables, webhook, appOverrides }) {
  const { orgId, workspaceId } = base();
  let agentVariables = Object.fromEntries(Object.entries(variables || {}).map(([k, v]) => [k, String(v)]));
  const send = () => sarvamRequest('POST', `/outbounds/v1/orgs/${orgId}/workspaces/${workspaceId}/outbounds`, {
    app_config: {
      app_id: appId,
      app_version: appVersion,
      connection_config: connectionConfig(),
      agent_variables: agentVariables,
      ...(appOverrides ? { app_overrides: appOverrides } : {}),
    },
    user_config: { user_phone_number: toE164(phoneNumber) },
    ...(webhook ? { webhook_config: webhook } : {}),
  });

  try {
    return await send();
  } catch (err) {
    const missing = missingAgentVariables(err);
    if (!missing.length) throw err;
    agentVariables = Object.fromEntries(Object.entries(agentVariables).filter(([k]) => !missing.includes(k)));
    await logAction(null, 'SARVAM_VARIABLES_SKIPPED',
      `Agent ${appId} v${appVersion} doesn't define: ${missing.join(', ')} — calling without them`);
    return send();
  }
}

/**
 * Create a Sarvam campaign that starts now (calls only between 10:00–19:00 IST, Mon–Sat) and,
 * if contacts are provided, stream them in as the campaign's cohort.
 * Body: { campaign_name, agent_id?, agent_version?, cohort_id?, contacts?: [{phone_number, business_name}] }
 */
async function startCampaign({ campaign_name, agent_id, agent_version, cohort_id, contacts = [] }) {
  const appId = agent_id || config.sarvam.salesAgentId;
  const appVersion = Number(agent_version || config.sarvam.salesAgentVersion);

  const campaign = await prisma.campaign.create({
    data: {
      name: campaign_name,
      cohort_id: cohort_id || null,
      agent_id: appId || null,
      total_calls: contacts.length,
    },
  });

  if (!config.isConfigured.sarvam) {
    await logAction(null, 'CAMPAIGN_STARTED_MOCK',
      `Sarvam not configured — campaign "${campaign_name}" (${campaign.id}) created locally only`);
    return { campaign, sarvam: null, mock: true };
  }

  try {
    const { orgId, workspaceId } = base();
    const now = new Date();
    const p = istParts(now);
    const end = istDate(p.year, p.month, p.day + 7, 19, 0);

    const created = await sarvamRequest('POST', `/scheduling/v1/orgs/${orgId}/workspaces/${workspaceId}/campaigns`, {
      name: campaign_name.slice(0, 100),
      description: `Infinity Web & Apps outreach (${campaign.id})`.slice(0, 150),
      start_timestamp: new Date(now.getTime() + 60000).toISOString(),
      end_timestamp: end.toISOString(),
      allowed_schedule: {
        allowed_start_time: '10:00',
        allowed_end_time: '19:00',
        allowed_days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        timezone: 'Asia/Kolkata',
      },
      app_config: {
        app_type: 'agent', // Sarvam now requires this discriminator on campaigns
        app_id: appId,
        app_version: appVersion,
        attempts_per_second: 0.5,
        // Campaign connection format (as returned by Sarvam for dashboard-created campaigns)
        connection_configs: [{
          connection_id: config.sarvam.connectionId,
          phone_numbers: [config.sarvam.agentPhoneNumber],
          weight: 1,
        }],
        retry_config: {
          max_retries: 2,
          retry_on: {
            busy: { enabled: true },
            failed: { enabled: true },
            no_answer: { enabled: true },
          },
          retry_interval_minutes: [30, 30],
        },
      },
      webhook_config: webhookConfig(campaign.id),
    });

    const sarvamCampaignId = created.campaign_id;
    await prisma.campaign.update({ where: { id: campaign.id }, data: { sarvam_campaign_id: sarvamCampaignId } });

    let cohort = null;
    if (contacts.length) {
      cohort = await sarvamRequest('POST',
        `/scheduling/v1/orgs/${orgId}/workspaces/${workspaceId}/campaigns/${sarvamCampaignId}/cohorts/stream`, {
          name: (cohort_id || `${campaign_name} cohort`).slice(0, 50),
          users: contacts.slice(0, 1000).map((c) => ({
            user_phone_number: toE164(c.phone_number),
            user_identifier: c.business_name || undefined,
            // The sales agent only defines business_name — sending variables it doesn't have gets
            // the upload rejected (Jarvis now has his own agent, so no call_type is needed here).
            app_variables: { business_name: c.business_name || '' },
          })),
        });
    }

    await logAction(null, 'CAMPAIGN_STARTED',
      `Campaign "${campaign_name}" → Sarvam ${sarvamCampaignId}${cohort ? `, cohort ${cohort.cohort_id}` : ''}`);
    return { campaign: { ...campaign, sarvam_campaign_id: sarvamCampaignId }, sarvam: { campaign: created, cohort } };
  } catch (err) {
    await logError(null, 'CAMPAIGN_START', err);
    throw err;
  }
}

/**
 * After all calls in a campaign are processed, phone Harshavardhan with a spoken summary.
 * Idempotent: only fires once per campaign (summary_call_sent flag). The call itself goes
 * through the owner-call queue so it never overlaps an approval call.
 */
async function triggerSummaryCall(campaignId) {
  // Atomically claim the summary so concurrent webhooks can't double-call.
  const claimed = await prisma.campaign.updateMany({
    where: { id: campaignId, summary_call_sent: false },
    data: { summary_call_sent: true, status: 'COMPLETED', completed_at: new Date() },
  });
  if (claimed.count === 0) return { skipped: true };

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  const booked = await prisma.client.findMany({
    where: { campaign_id: campaignId, call_outcome: 'BOOKED' },
    select: { business_name: true, meeting_link: true },
  });
  const variables = {
    booked_count: campaign.booked,
    booked_names: booked.map((c) => c.business_name).join(', ') || 'none',
    callback_count: campaign.callback_later,
    rejected_count: campaign.rejected,
    no_answer_count: campaign.no_answer,
    meets_scheduled: booked.filter((c) => c.meeting_link).length,
  };

  const { requestOwnerCall } = require('./ownerCalls');
  const call = await requestOwnerCall('SUMMARY', { campaignId, data: variables });
  await logAction(null, 'SUMMARY_CALL', `Campaign "${campaign.name}" complete — ${JSON.stringify(variables)}`);
  return { ownerCallId: call.id, variables, mock: call.status === 'DONE' };
}

/** Read a Sarvam campaign (status: scheduled | active | paused | ended | cancelled). */
async function getSarvamCampaign(sarvamCampaignId) {
  const { orgId, workspaceId } = base();
  return sarvamRequest('GET', `/scheduling/v1/orgs/${orgId}/workspaces/${workspaceId}/campaigns/${sarvamCampaignId}`);
}

module.exports = { startCampaign, triggerSummaryCall, placeOutboundCall, getSarvamCampaign };
