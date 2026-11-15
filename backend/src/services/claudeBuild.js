// Start Claude (claude-code-action in GitHub Actions) building a client's website or app, and
// handle the "build finished" callback from the workflow.
const config = require('../lib/config');
const prisma = require('../lib/prisma');
const { logAction } = require('../lib/logger');
const { generateWebsitePrompt } = require('./websitePrompt');
const { createClientRepo, putFile, ensureBuildSetup, dispatchBuild } = require('./github');

function buildPrompt(client, { kind = 'website', instructions }) {
  return [
    `Build the ${kind === 'app' ? 'web app' : 'website'} for ${client.business_name} exactly as described in CLAUDE.md in this repository.`,
    'Follow the "How to work" section: write or update PLAN.md first, then build, then complete the README and the done checklist.',
    'If the project already exists, continue from where it is and improve it rather than starting over.',
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
  await logAction(client.id, 'CLAUDE_BUILD_STARTED',
    `Claude is building the ${kind} in ${client.github_repo} (requested from ${source})${instructions ? ` — "${instructions.slice(0, 200)}"` : ''}`);
  return updated;
}

/** Callback from the workflow's last step. */
async function handleBuildDone({ repo, status, run_url: runUrl }) {
  const client = await prisma.client.findFirst({ where: { github_repo: repo } });
  if (!client) return { ignored: true };
  const ok = status === 'success';
  await prisma.client.update({
    where: { id: client.id },
    data: {
      build_status: ok ? 'success' : 'failure',
      build_run_url: runUrl || client.build_run_url,
      build_finished_at: new Date(),
      ...(ok && client.website_stage === 'IN_DEVELOPMENT' ? { website_stage: 'IN_REVIEW' } : {}),
    },
  });
  await logAction(client.id, ok ? 'CLAUDE_BUILD_DONE' : 'CLAUDE_BUILD_ERROR',
    ok ? `Claude finished building — code in ${client.github_repo}. Run: ${runUrl}` : `Claude build ${status} — see ${runUrl}`);

  // Let the founder know on WhatsApp (from his own linked number, to himself).
  try {
    const waLinked = require('./waLinked');
    if (config.ownerPhone && (await waLinked.hasSession())) {
      await waLinked.sendText(config.ownerPhone, ok
        ? `✅ Sir, Claude finished building *${client.business_name}*.\nCode: https://github.com/${repo}\nRun: ${runUrl}\nCheck it, add the preview link in the dashboard and mark it Ready when you're happy.`
        : `⚠️ Sir, Claude's build for *${client.business_name}* ${status}. Details: ${runUrl}`);
    }
  } catch {
    // notification is best-effort
  }
  return { ok: true };
}

module.exports = { requestBuild, handleBuildDone, buildPrompt };
