// One private GitHub repo per client website, seeded with the client's CLAUDE.md brief.
// Needs GITHUB_TOKEN: a fine-grained personal access token with "All repositories" →
// Administration: Read & write and Contents: Read & write (classic token: "repo" scope).
const config = require('../lib/config');
const prisma = require('../lib/prisma');
const { logAction } = require('../lib/logger');

const API = (process.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, '');

async function gh(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.github.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'infinity-automation',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`GitHub ${method} ${path} → ${res.status}: ${json.message || ''}${json.errors ? ` ${JSON.stringify(json.errors)}` : ''}`);
    err.status = res.status;
    err.github = json;
    throw err;
  }
  return json;
}

function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60) || 'client';
}

/** Create or update a file in the repo (base64 content, with sha when it already exists). */
async function putFile(fullName, path, content, message) {
  let sha;
  try {
    sha = (await gh('GET', `/repos/${fullName}/contents/${encodeURIComponent(path)}`)).sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  return gh('PUT', `/repos/${fullName}/contents/${encodeURIComponent(path)}`, {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    ...(sha ? { sha } : {}),
  });
}

function readme(client) {
  return `# ${client.business_name} — website

Built by **Infinity Web & Apps** for ${client.business_name}${client.contact_name ? ` (${client.contact_name})` : ''}.

## Build with Claude Code
1. Open this repo in Claude Code (claude.ai/code → choose this repository, or \`claude\` in a local clone).
2. Say: **"Build the website described in CLAUDE.md."**
3. Claude writes \`PLAN.md\` first, then builds and commits the site here.

The brief lives in \`CLAUDE.md\`. Regenerate it from the Infinity dashboard if the client's requirements change.
`;
}

/**
 * Create the client's private repo (once) and push CLAUDE.md + README.md.
 * If the repo already exists for this client, only CLAUDE.md is refreshed.
 */
async function createClientRepo(clientId) {
  if (!config.isConfigured.github) {
    throw Object.assign(new Error('GitHub is not connected — add GITHUB_TOKEN on Render first'), { status: 400 });
  }
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client.website_prompt) throw Object.assign(new Error('Write the CLAUDE.md brief first'), { status: 400 });

  if (client.github_repo) {
    await putFile(client.github_repo, 'CLAUDE.md', client.website_prompt, 'Update CLAUDE.md brief from Infinity dashboard');
    await logAction(client.id, 'GITHUB_BRIEF_UPDATED', `CLAUDE.md updated in ${client.github_repo}`);
    return prisma.client.findUnique({ where: { id: clientId } });
  }

  const base = `${config.github.repoPrefix}${slugify(client.business_name)}`;
  const createPath = config.github.owner ? `/orgs/${config.github.owner}/repos` : '/user/repos';
  let repo;
  for (let i = 0; i < 5 && !repo; i++) {
    const name = i === 0 ? base : `${base}-${i + 1}`;
    try {
      repo = await gh('POST', createPath, {
        name,
        private: true,
        description: `Website for ${client.business_name} — Infinity Web & Apps`.slice(0, 350),
        auto_init: false,
        has_wiki: false,
        has_projects: false,
      });
    } catch (err) {
      const taken = err.status === 422 && /already exists/i.test(JSON.stringify(err.github || {}));
      if (!taken) throw err;
    }
  }
  if (!repo) throw new Error(`Could not find a free repo name starting with ${base}`);

  await putFile(repo.full_name, 'README.md', readme(client), 'Add README');
  await putFile(repo.full_name, 'CLAUDE.md', client.website_prompt, 'Add CLAUDE.md brief from Infinity dashboard');

  const updated = await prisma.client.update({
    where: { id: clientId },
    data: {
      github_repo: repo.full_name,
      github_repo_url: repo.html_url,
      ...(['NOT_STARTED', 'PROMPT_READY'].includes(client.website_stage) ? { website_stage: 'IN_DEVELOPMENT' } : {}),
    },
  });
  await logAction(client.id, 'GITHUB_REPO_CREATED', `Private repo ${repo.full_name} created with CLAUDE.md — ${repo.html_url}`);
  return updated;
}

module.exports = { createClientRepo, slugify };
