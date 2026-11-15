// Start Claude (claude-code-action in GitHub Actions) building a client's website or app, and
// handle the "build finished" callback from the workflow.
const config = require('../lib/config');
const prisma = require('../lib/prisma');
const { logAction } = require('../lib/logger');
const { generateWebsitePrompt } = require('./websitePrompt');
const { createClientRepo, putFile, ensureBuildSetup, dispatchBuild } = require('./github');

const KIND_LABEL = { website: 'website', app: 'web app', mobile: 'mobile app' };

function buildPrompt(client, { kind = 'website', instructions }) {
  const what = kind === 'mobile'
    ? `a mobile app for ${client.business_name} (React Native with Expo, Android and iOS, in a \`mobile/\` folder), based on the business details, requirements and plan scope in CLAUDE.md`
    : `the ${KIND_LABEL[kind] || 'website'} for ${client.business_name} exactly as described in CLAUDE.md in this repository`;
  return [
    `Build ${what}.`,
    'Follow the "How to work" section: write or update PLAN.md first, then build, then complete the README and the done checklist.',
    kind === 'mobile' ? 'Include clear steps in the README to run it with Expo Go and to make Android/iOS builds with EAS.' : null,
    'If the project already exists, continue from where it is and improve it rather than starting over.',
    'IMPORTANT: create the real project files in this repository NOW with the Write tool — do not stop after planning, do not ask questions, and do not just describe what you would do. The run fails if no project files exist.',
    'It will be deployed to Vercel with zero configuration: use a standard setup (e.g. Vite + React, Next.js, or plain HTML/CSS/JS), keep it at the repository root, make sure `npm install && npm run build` succeeds if it has a package.json, and run the build once to check before you finish.',
    'Finish by listing the files you created.',
    instructions ? `Latest instructions from the founder (take priority over older ones): ${instructions}` : null,
    'Work fully autonomously — there is no one to answer questions. Make sensible decisions and note them in PLAN.md.',
  ].filter(Boolean).join('\n\n');
}

/**
 * Request a Claude build. Creates the repo/brief if needed, installs the workflow + secrets,
 * appends any spoken instructions to CLAUDE.md, and dispatches the run.
 */
async function requestBuild(clientId, { kind = 'website', instructions = null, source = 'dashboard' } = {}) {
  if (!config.isConfigured.github) throw Object.assign(new Error('GitHub is not connected (GITHUB_TOKEN)'), { status: 400 });
  if (!config.claudeCodeToken) throw Object.assign(new Error('Claude is not connected — add CLAUDE_CODE_OAUTH_TOKEN on Render (from `claude setup-token`)'), { status: 400 });

  let client = await prisma.client.findUnique({ where: { id: clientId } });
  // Don't start a second build while one is running (Jarvis may hear "build" twice).
  if (['requested', 'running', 'deploying'].includes(client.build_status)
    && client.build_requested_at && Date.now() - client.build_requested_at.getTime() < 45 * 60000) {
    throw Object.assign(new Error(`${client.business_name} is already ${client.build_status === 'deploying' ? 'deploying' : 'being built'} — I'll call you when it's done`), { status: 409 });
  }
  if (!client.website_prompt) client = await generateWebsitePrompt(client);
  if (!client.github_repo) client = await createClientRepo(client.id);

  if (instructions) {
    const stamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const brief = `${client.website_prompt}\n\n## Update from the founder (${stamp})\n${instructions}\n`;
    client = await prisma.client.update({ where: { id: client.id }, data: { website_prompt: brief, website_prompt_at: new Date() } });
    await putFile(client.github_repo, 'CLAUDE.md', brief, 'Update CLAUDE.md with new instructions');
  }

  const secret = config.webhookSecret ? `?secret=${encodeURIComponent(config.webhookSecret)}` : '';
  await ensureBuildSetup(client.github_repo, {
    claudeToken: config.claudeCodeToken,
    callbackUrl: `${config.publicBaseUrl}/webhook/github/build-done${secret}`,
    vercelToken: config.vercel.token,
    vercelScope: config.vercel.scope,
  });
  // GitHub needs a moment to register a just-added workflow before it can be dispatched.
  let runsUrl;
  for (let i = 0; i < 6 && !runsUrl; i++) {
    try {
      runsUrl = await dispatchBuild(client.github_repo, buildPrompt(client, { kind, instructions }));
    } catch (err) {
      if (err.status !== 404 || i === 5) throw err;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  const updated = await prisma.client.update({
    where: { id: client.id },
    data: {
      build_status: 'running',
      build_run_url: runsUrl,
      build_requested_at: new Date(),
      build_finished_at: null,
      ...(['NOT_STARTED', 'PROMPT_READY', 'IN_REVIEW', 'READY'].includes(client.website_stage) ? { website_stage: 'IN_DEVELOPMENT' } : {}),
    },
  });
  // Let sir know on WhatsApp straight away.
  try {
    const waLinked = require('./waLinked');
    if (config.ownerPhone && (await waLinked.hasSession())) {
      await waLinked.sendText(config.ownerPhone, `🛠️ Sir, Claude has started building the ${KIND_LABEL[kind] || kind} for *${client.business_name}*.`
        + `\nRepo: https://github.com/${client.github_repo}`
        + `\nLive progress: ${runsUrl}`
        + `${instructions ? `\nYour instructions: "${instructions.slice(0, 200)}"` : ''}`
        + '\n\nI\'ll call you when it\'s built.');
    }
  } catch {
    // notification is best-effort
  }
    await logAction(client.id, 'CLAUDE_BUILD_STARTED',
    `Claude is building the ${KIND_LABEL[kind] || kind} in ${client.github_repo} (requested from ${source})${instructions ? ` — "${instructions.slice(0, 200)}"` : ''}`);
  return updated;
}

async function notifyOwner(text) {
  try {
    const waLinked = require('./waLinked');
    if (config.ownerPhone && (await waLinked.hasSession())) await waLinked.sendText(config.ownerPhone, text);
  } catch {
    // best effort
  }
}

async function noticeCall(clientId, notice) {
  try {
    await require('./ownerCalls').requestOwnerCall('NOTICE', { clientId, data: { notice } });
  } catch {
    // best effort
  }
}

/** Publish the code Claude built to Vercel (no Claude run) — sir says "deploy it". */
async function requestDeploy(clientId, { source = 'dashboard' } = {}) {
  let client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) throw Object.assign(new Error('Client not found'), { status: 404 });
  if (!client.github_repo) throw Object.assign(new Error(`Nothing is built for ${client.business_name} yet — build it first`), { status: 400 });
  if (['requested', 'running', 'deploying'].includes(client.build_status)) {
    throw Object.assign(new Error(`${client.business_name} is still ${client.build_status === 'deploying' ? 'deploying' : 'being built'} — I'll call you when it's done`), { status: 409 });
  }
  if (!config.vercel.token) throw Object.assign(new Error('Vercel is not connected (VERCEL_TOKEN missing on the server)'), { status: 400 });
  const secret = config.webhookSecret ? `?secret=${encodeURIComponent(config.webhookSecret)}` : '';
  await ensureBuildSetup(client.github_repo, {
    claudeToken: config.claudeCodeToken,
    callbackUrl: `${config.publicBaseUrl}/webhook/github/build-done${secret}`,
    vercelToken: config.vercel.token,
    vercelScope: config.vercel.scope,
  });
  let runsUrl;
  for (let i = 0; i < 6 && !runsUrl; i++) {
    try {
      runsUrl = await dispatchBuild(client.github_repo, '-', 'deploy');
    } catch (err) {
      if (err.status !== 404 || i === 5) throw err;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  client = await prisma.client.update({
    where: { id: client.id },
    data: { build_status: 'deploying', build_run_url: runsUrl, build_requested_at: new Date(), build_finished_at: null },
  });
  await logAction(client.id, 'DEPLOY_STARTED', `Deploying ${client.business_name} to Vercel (requested from ${source})`);
  await notifyOwner(`🚀 Sir, deploying *${client.business_name}* to a live preview link now. I'll call you and send the link when it's up.`);
  return client;
}

/** Callback from the workflow's last step (build or deploy). */
async function handleBuildDone({ repo, status, run_url: runUrl, preview_url: previewRaw, mode }) {
  const previewUrl = /^https:\/\//.test(String(previewRaw || '')) ? String(previewRaw) : null;
  const client = await prisma.client.findFirst({ where: { github_repo: repo } });
  if (!client) return { ignored: true };
  const ok = status === 'success';
  const deploy = mode === 'deploy';
  await prisma.client.update({
    where: { id: client.id },
    data: {
      // a failed deploy doesn't undo a good build
      build_status: deploy ? (ok ? 'deployed' : 'success') : (ok ? 'success' : 'failure'),
      build_run_url: runUrl || client.build_run_url,
      build_finished_at: new Date(),
      ...(previewUrl ? { website_preview_url: previewUrl } : {}),
      ...(!deploy && ok && client.website_stage === 'IN_DEVELOPMENT' ? { website_stage: 'IN_REVIEW' } : {}),
      ...(deploy && ok && ['IN_DEVELOPMENT', 'IN_REVIEW'].includes(client.website_stage) ? { website_stage: 'READY' } : {}),
    },
  });

  if (deploy) {
    if (ok && previewUrl) {
      await logAction(client.id, 'DEPLOY_DONE', `${client.business_name} is live at ${previewUrl}`);
      await notifyOwner(`🌐 Sir, *${client.business_name}* is live:\n${previewUrl}\n\nHave a look. When you're happy, tell Jarvis "send the quotation to ${client.business_name}" and it goes to the client.`);
      await noticeCall(client.id, `${client.business_name} is now live on its preview link — I've sent it to you on WhatsApp. Have a look, and when you're happy, just tell me to send the quotation to the client.`);
    } else {
      await logAction(client.id, 'DEPLOY_ERROR', `Vercel deploy ${status} — ${runUrl}`);
      await notifyOwner(`⚠️ Sir, the deploy for *${client.business_name}* failed. Usually this is the Vercel token (it needs full access). Details: ${runUrl}`);
      await noticeCall(client.id, `The deploy for ${client.business_name} didn't go through. The details are on WhatsApp — most likely the Vercel token needs full access.`);
    }
    return { ok: true };
  }

  await logAction(client.id, ok ? 'CLAUDE_BUILD_DONE' : 'CLAUDE_BUILD_ERROR',
    ok ? `Claude finished building — code in ${client.github_repo}. Run: ${runUrl}` : `Claude build ${status} — see ${runUrl}`);
  if (ok) {
    await notifyOwner(`✅ Sir, Claude finished building *${client.business_name}*.\nCode: https://github.com/${repo}\n\nTell Jarvis "deploy it" to put it on a live link.`);
    await noticeCall(client.id, `Claude has finished building ${client.business_name}. Say "deploy it" and I'll put it live and send you the link.`);
  } else {
    await notifyOwner(`⚠️ Sir, Claude's build for *${client.business_name}* ${status}. Details: ${runUrl}`);
    await noticeCall(client.id, `Claude's build for ${client.business_name} didn't finish. The details are on WhatsApp — want me to try again?`);
  }
  return { ok: true };
}

/**
 * Sir said "send the quotation to X": make the proposal and send it to the client's registered
 * number (via the Client Portal when connected, else the PDF on WhatsApp). Sir's word is the approval.
 */
async function sendQuotation(clientId, { phone = null, source = 'Jarvis call' } = {}) {
  let client = await prisma.client.findUnique({ where: { id: clientId } });
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 10) {
    const { toE164 } = require('../lib/phone');
    client = await prisma.client.update({ where: { id: client.id }, data: { phone_number: toE164(phone) } });
  }
  if (String(client.phone_number || '').replace(/\D/g, '').length < 10) {
    throw Object.assign(new Error(`I don't have a phone number for ${client.business_name}, sir. Tell me their number and I'll send it.`), { status: 400 });
  }
  const portal = require('./clientPortal');
  if (portal.isConfigured()) {
    const r = await portal.deliverApprovedQuotation(client);
    await logAction(client.id, 'QUOTATION_SENT', `Quotation sent via the Client Portal (${source})${r.status === 'asked_email' ? ' — asked the client for their email first' : ''}`);
    return { client, via: r.status === 'asked_email' ? 'asked_email' : 'portal' };
  }
  const { generateProposal } = require('./proposalGenerator');
  const { sendWhatsAppMessage } = require('./whatsapp');
  const proposal = await generateProposal(client);
  const fresh = await prisma.client.findUnique({ where: { id: client.id } });
  await sendWhatsAppMessage(fresh, fresh.proposal_url, fresh.meeting_link, fresh.meeting_time, { proposalNumber: proposal.number });
  await prisma.client.update({
    where: { id: client.id },
    data: { proposal_sent: true, ...(['CONVERTED', 'LOST', 'MEETING_SCHEDULED'].includes(fresh.portal_status) ? {} : { portal_status: 'PROPOSAL_SENT' }) },
  });
  await logAction(client.id, 'QUOTATION_SENT', `${proposal.number} sent to ${fresh.phone_number} on WhatsApp (${source})`);
  return { client: fresh, via: 'whatsapp', number: proposal.number };
}

module.exports = { requestBuild, requestDeploy, handleBuildDone, sendQuotation, buildPrompt, KIND_LABEL };
