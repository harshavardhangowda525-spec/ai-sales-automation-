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
  const enc = path.split('/').map(encodeURIComponent).join('/'); // keep folder slashes
  let sha;
  try {
    sha = (await gh('GET', `/repos/${fullName}/contents/${enc}`)).sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  return gh('PUT', `/repos/${fullName}/contents/${enc}`, {
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

// ── Claude builds via GitHub Actions ───────────────────────────────────────────────────────
// Anthropic's official claude-code-action, authenticated with the owner's Claude subscription
// (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`) — no pay-per-use API key.
const BUILD_WORKFLOW = `name: Claude build

on:
  workflow_dispatch:
    inputs:
      prompt:
        description: What Claude should build or change
        required: false
        default: '-'
      mode:
        description: build (Claude writes the code) or deploy (publish the code to Vercel)
        required: false
        default: build

permissions:
  contents: write
  pull-requests: write
  issues: write
  id-token: write

concurrency:
  group: claude-build
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    env:
      VERCEL_TOKEN: \${{ secrets.VERCEL_TOKEN }}
      VERCEL_SCOPE: \${{ secrets.VERCEL_SCOPE }}
    steps:
      - uses: actions/checkout@v4

      - name: Claude builds the project
        if: inputs.mode != 'deploy'
        uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          github_token: \${{ secrets.GITHUB_TOKEN }}
          prompt: \${{ inputs.prompt }}
          claude_args: --max-turns 250 --permission-mode acceptEdits --allowedTools "Bash,Edit,Write,Read,Glob,Grep,WebFetch"

      - name: Keep Claude's work log (3 days)
        if: always() && inputs.mode != 'deploy'
        uses: actions/upload-artifact@v4
        with:
          name: claude-log
          path: \${{ runner.temp }}/claude-execution-output.json
          retention-days: 3
          if-no-files-found: ignore

      - name: Commit and push the work
        if: inputs.mode != 'deploy'
        run: |
          git config user.name "Claude (Infinity Web & Apps)"
          git config user.email "claude-build@users.noreply.github.com"
          git add -A
          if git diff --cached --quiet; then echo "No uncommitted changes"; else git commit -m "Claude build #\${{ github.run_number }}"; fi
          # Claude often commits by itself — always push whatever is on HEAD to the default branch.
          git pull --rebase origin "\${{ github.event.repository.default_branch }}" || true
          git push origin "HEAD:\${{ github.event.repository.default_branch }}"
          echo "Files in the repo now: $(git ls-files | wc -l)"

      - name: Check that real project files exist
        run: |
          n=$(git ls-files | grep -vE '^(CLAUDE\\.md|README\\.md|PLAN\\.md|\\.github/)' | wc -l)
          echo "Project files: $n"
          if [ "$n" -lt 3 ]; then echo "::error::Claude did not create the project files"; exit 1; fi

      - name: Deploy a live preview to Vercel
        if: inputs.mode == 'deploy'
        run: |
          if [ -z "$VERCEL_TOKEN" ]; then echo "::error::No Vercel token on the server"; exit 1; fi
          SCOPE=""
          if [ -n "$VERCEL_SCOPE" ]; then SCOPE="--scope $VERCEL_SCOPE"; fi
          URL=$(npx --yes vercel@latest deploy --prod --yes --token "$VERCEL_TOKEN" $SCOPE 2>vercel.err | tail -n 1)
          cat vercel.err | tail -n 20
          # The deployment URL is login-protected; send the public production alias (shortest *.vercel.app) instead.
          Q=""; if [ -n "$VERCEL_SCOPE" ]; then case "$VERCEL_SCOPE" in team_*) Q="?teamId=$VERCEL_SCOPE";; *) Q="?slug=$VERCEL_SCOPE";; esac; fi
          ALIAS=$(curl -sS "https://api.vercel.com/v9/projects/\${{ github.event.repository.name }}$Q" -H "Authorization: Bearer $VERCEL_TOKEN" | jq -r '.targets.production.alias[]? // empty' | awk '{ print length, $0 }' | sort -n | head -n 1 | cut -d' ' -f2)
          if [ -n "$ALIAS" ]; then URL="https://$ALIAS"; fi
          case "$URL" in https://*) echo "PREVIEW_URL=$URL" >> "$GITHUB_ENV"; echo "Live preview: $URL";; *) echo "::error::Vercel deploy failed: $(tail -n 3 vercel.err | tr '\\n' ' ')"; exit 1;; esac

      - name: Tell the Infinity dashboard
        if: always()
        env:
          CALLBACK_URL: \${{ secrets.INFINITY_CALLBACK_URL }}
          STATUS: \${{ job.status }}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: |
          if [ -n "$CALLBACK_URL" ]; then
            curl -sS -X POST "$CALLBACK_URL" -H 'Content-Type: application/json' \\
              -d "{\\"repo\\":\\"$GITHUB_REPOSITORY\\",\\"status\\":\\"$STATUS\\",\\"run_url\\":\\"$RUN_URL\\",\\"preview_url\\":\\"\${PREVIEW_URL:-}\\",\\"mode\\":\\"\${{ inputs.mode }}\\"}" || true
          fi
`;

/** Encrypt and store an Actions secret on the repo (GitHub requires a libsodium sealed box). */
async function setRepoSecret(fullName, name, value) {
  const sodium = require('libsodium-wrappers');
  await sodium.ready;
  const { key, key_id: keyId } = await gh('GET', `/repos/${fullName}/actions/secrets/public-key`);
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key, sodium.base64_variants.ORIGINAL));
  await gh('PUT', `/repos/${fullName}/actions/secrets/${name}`, {
    encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
    key_id: keyId,
  });
}

/** Make sure the repo has the build workflow and its two secrets. */
async function ensureBuildSetup(fullName, { claudeToken, callbackUrl, vercelToken, vercelScope }) {
  await putFile(fullName, '.github/workflows/claude-build.yml', BUILD_WORKFLOW, 'Update Claude build workflow');
  await setRepoSecret(fullName, 'CLAUDE_CODE_OAUTH_TOKEN', claudeToken);
  await setRepoSecret(fullName, 'INFINITY_CALLBACK_URL', callbackUrl);
  if (vercelToken) {
    await setRepoSecret(fullName, 'VERCEL_TOKEN', vercelToken);
    if (vercelScope) await setRepoSecret(fullName, 'VERCEL_SCOPE', vercelScope);
  }
}

/** Start the build workflow with a prompt. */
async function dispatchBuild(fullName, prompt, mode = 'build') {
  const repo = await gh('GET', `/repos/${fullName}`);
  await gh('POST', `/repos/${fullName}/actions/workflows/claude-build.yml/dispatches`, {
    ref: repo.default_branch || 'main',
    inputs: { prompt: String(prompt || '-').slice(0, 60000), mode },
  });
  return `${repo.html_url}/actions/workflows/claude-build.yml`;
}

module.exports = { createClientRepo, slugify, putFile, ensureBuildSetup, dispatchBuild, setRepoSecret, BUILD_WORKFLOW };
