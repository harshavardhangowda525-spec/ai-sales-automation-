// Daily Instagram reel, fully coded motion graphics:
//   5 PM IST  → Claude (claude-code-action, sir's subscription) writes today's Remotion reel + caption in the
//               private iwa-reels repo; GitHub Actions renders the MP4 and uploads it here.
//   ready     → sir gets the preview on WhatsApp and Jarvis calls for approval.
//   7:30 PM   → approved reel is published to Instagram (immediately if approved later).
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const prisma = require('../lib/prisma');
const { logAction, logError } = require('../lib/logger');
const { istParts, istDate } = require('../lib/time');

const TEMPLATE_DIR = path.join(__dirname, '..', 'reelTemplate');

// Topics rotate day by day — every reel explains a service, its price and what it does for the business.
const TOPICS = [
  'Why every local business needs a website in 2026 — customers Google you first; show our 3 website plans and prices',
  'What our ₹4,999 Basic website includes and how it brings customers: WhatsApp button, Google Maps, contact form, mobile-first premium design',
  'What a website AUTOMATES for a business: enquiries on WhatsApp 24/7, bookings while you sleep, Google reviews, less phone time',
  'Premium plan ₹8,999: show up on Google search (SEO), reviews, social links, motion design — how it turns searches into calls',
  'Advanced plan ₹15,000: online bookings + payments + admin panel + WhatsApp alerts — walk through how a booking works step by step',
  'Web apps for bookings, orders and memberships: how a gym / clinic / salon / restaurant saves hours every week',
  'Mobile apps (Android + iOS) for your business: loyalty, orders, notifications — what it costs and how it works',
  'Before vs after: a business with no website vs one with a premium site — lost customers vs new enquiries',
  'How we work: free 15-min Google Meet → design → live in about 7 days → you get enquiries; prices from ₹4,999',
  'Myths: "websites are expensive / I get customers by word of mouth / I am too small" — busted, with our prices',
];

function todayIST(now = new Date()) {
  const p = istParts(now);
  return `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function topicFor(day) {
  const n = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000);
  return TOPICS[n % TOPICS.length];
}

async function getSetting(key) {
  return (await prisma.appSetting.findUnique({ where: { key } }))?.value || null;
}
async function setSetting(key, value) {
  await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

async function notifyOwner(text) {
  try {
    const waLinked = require('./waLinked');
    if (config.ownerPhone && (await waLinked.hasSession())) await waLinked.sendText(config.ownerPhone, text);
  } catch {
    // best effort
  }
}

function ctaPhone() {
  const raw = String(config.reels.ctaPhone || config.ownerPhone || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
  return raw.length === 10 ? `+91 ${raw.slice(0, 5)} ${raw.slice(5)}` : '';
}

// ── The reels repo (private) ──────────────────────────────────────────────────────────────
const REEL_WORKFLOW = `name: Daily reel

on:
  workflow_dispatch:
    inputs:
      reel_id:
        required: true
      prompt:
        required: true

permissions:
  contents: write
  pull-requests: write
  issues: write
  id-token: write

concurrency:
  group: daily-reel
  cancel-in-progress: false

jobs:
  reel:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install
        run: npm install --no-audit --no-fund

      - name: Claude codes today's reel
        uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          github_token: \${{ secrets.GITHUB_TOKEN }}
          prompt: \${{ inputs.prompt }}
          claude_args: --max-turns 120 --permission-mode acceptEdits --allowedTools "Bash,Edit,Write,Read,Glob,Grep"

      - name: Render the reel
        run: |
          if ! npx remotion render src/index.ts Reel out/reel.mp4 --codec h264 --crf 26 --timeout 120000; then
            echo "::warning::Today's reel didn't render — falling back to the last good version"
            git checkout \${{ github.sha }} -- src reel.json
            npx remotion render src/index.ts Reel out/reel.mp4 --codec h264 --crf 26 --timeout 120000
          fi
          ls -la out

      - name: Save the source
        run: |
          git config user.name "Claude (Infinity Web & Apps)"
          git config user.email "claude-build@users.noreply.github.com"
          git add -A src reel.json || true
          git diff --cached --quiet || git commit -m "Reel \${{ inputs.reel_id }}"
          git pull --rebase origin "\${{ github.event.repository.default_branch }}" || true
          git push origin "HEAD:\${{ github.event.repository.default_branch }}" || true

      - name: Send the video to the Infinity dashboard
        env:
          UPLOAD_URL: \${{ secrets.INFINITY_REEL_UPLOAD_URL }}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: |
          META=$(base64 -w0 reel.json)
          curl -sS --fail -X POST "$UPLOAD_URL&reel_id=\${{ inputs.reel_id }}" \\
            -H "Content-Type: video/mp4" -H "X-Reel-Meta: $META" -H "X-Run-Url: $RUN_URL" \\
            --data-binary @out/reel.mp4

      - name: Report a failure
        if: failure()
        env:
          UPLOAD_URL: \${{ secrets.INFINITY_REEL_UPLOAD_URL }}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: |
          curl -sS -X POST "$UPLOAD_URL&reel_id=\${{ inputs.reel_id }}&failed=1" -H "X-Run-Url: $RUN_URL" || true
`;

function templateFiles() {
  const files = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) walk(full);
      else files.push(path.relative(TEMPLATE_DIR, full));
    }
  };
  walk(TEMPLATE_DIR);
  return files;
}

const REPO_CLAUDE_MD = () => `# CLAUDE.md — Infinity Web & Apps daily Instagram reels

Every day you write ONE new vertical reel (1080×1920, 30 fps, 15–30 s) as fully coded motion graphics with Remotion.
Goal: win clients for Infinity Web & Apps (Bengaluru) — explain clearly what we build, what it costs and what it automates.

## Files
- \`src/Reel.tsx\` — rewrite it completely each day. Export \`Reel\` and \`REEL_DURATION\` (frames, 30 fps).
- \`src/brand.ts\` — brand colours, plans, prices, WhatsApp number. Use it; don't change prices.
- \`reel.json\` — \`{ "topic": "...", "caption": "..." }\` for Instagram.

## Rules
- Only use \`remotion\` and \`@remotion/google-fonts\` (already installed). No external images or video files — everything is drawn in code (shapes, gradients, SVG, text, emoji).
- Load fonts with a small set of weights only, e.g. \`loadFont('normal', { weights: ['400', '800'], subsets: ['latin'] })\`.
- Make it look premium and scroll-stopping: a 1-second hook, kinetic typography, spring animations, animated gradients/shapes, phone or browser mockups drawn in code, smooth transitions every 2–4 s, bold readable text (min 44 px), safe margins of 80 px.
- Always show the prices from brand.ts when talking about plans and end with a CTA: free 15-minute consultation + the WhatsApp number.
- Caption: hook line, 2–4 short lines explaining the value, prices, CTA ("WhatsApp us for a free 15-min consultation"), then 8–12 relevant hashtags (Bengaluru, small business, website design…). Max 2,000 characters.
- Before finishing, run \`npx remotion still src/index.ts Reel out/check.jpg --frame 60\` to make sure it renders. Fix any error.
`;

async function ensureReelsRepo() {
  const { gh, putFile, setRepoSecret } = require('./github');
  let fullName = config.reels.repo || (await getSetting('reels_repo'));
  if (!fullName) {
    const createPath = config.github.owner ? `/orgs/${config.github.owner}/repos` : '/user/repos';
    try {
      const repo = await gh('POST', createPath, { name: 'iwa-reels', private: true, description: 'Daily Instagram reels — coded motion graphics (Remotion)', auto_init: true });
      fullName = repo.full_name;
    } catch (err) {
      if (!(err.status === 422 && /already exists/i.test(JSON.stringify(err.github || {})))) throw err;
      const me = await gh('GET', '/user');
      fullName = `${config.github.owner || me.login}/iwa-reels`;
    }
    await setSetting('reels_repo', fullName);
    await logAction(null, 'REELS_REPO_CREATED', `Private repo ${fullName} for daily reels`);
  }
  // Template files go in once (Claude then rewrites Reel.tsx / reel.json every day).
  if (!(await getSetting('reels_template_v1'))) {
    for (const rel of templateFiles()) {
      let content = fs.readFileSync(path.join(TEMPLATE_DIR, rel), 'utf8');
      if (rel.endsWith('brand.ts')) content = content.replace('{{CTA_PHONE}}', ctaPhone());
      await putFile(fullName, rel.split(path.sep).join('/'), content, `Add ${rel}`);
    }
    await putFile(fullName, 'CLAUDE.md', REPO_CLAUDE_MD(), 'Add CLAUDE.md');
    await setSetting('reels_template_v1', new Date().toISOString());
  }
  await putFile(fullName, '.github/workflows/daily-reel.yml', REEL_WORKFLOW, 'Update daily reel workflow');
  const secret = config.webhookSecret ? `secret=${encodeURIComponent(config.webhookSecret)}` : 'x=1';
  await setRepoSecret(fullName, 'CLAUDE_CODE_OAUTH_TOKEN', config.claudeCodeToken);
  await setRepoSecret(fullName, 'INFINITY_REEL_UPLOAD_URL', `${config.publicBaseUrl}/webhook/reels/upload?${secret}`);
  return fullName;
}

function reelPrompt(day, topic, instructions) {
  return [
    `Today is ${day}. Write today's Instagram reel for Infinity Web & Apps, following CLAUDE.md.`,
    `Topic: ${topic}.`,
    'Rewrite src/Reel.tsx completely with a fresh design (different layout, colours from brand.ts and animations from previous days) and update reel.json with the topic and caption.',
    'Explain the service simply: what we build, the price, and what it automates or improves for the business owner. End with the free 15-minute consultation + WhatsApp CTA.',
    instructions ? `Sir's changes for this reel (follow them first): ${instructions}` : null,
    'Run the still-frame check from CLAUDE.md before you finish. Work autonomously — no questions.',
  ].filter(Boolean).join('\n\n');
}

/** Start today's reel (or redo it with sir's changes). */
async function requestReel({ day = todayIST(), instructions = null, source = 'schedule' } = {}) {
  if (!config.isConfigured.reels) throw Object.assign(new Error('Reels need GITHUB_TOKEN and CLAUDE_CODE_OAUTH_TOKEN on the server'), { status: 400 });
  const existing = await prisma.reel.findUnique({ where: { day } });
  if (existing && ['posting', 'posted'].includes(existing.status)) {
    throw Object.assign(new Error(`Today's reel is already ${existing.status}`), { status: 409 });
  }
  // Already running on GitHub (has a run URL) → don't start a second one. A reel stuck without a run URL
  // (the server restarted mid-setup) is started again.
  if (existing?.status === 'generating' && existing.run_url && Date.now() - existing.updated_at.getTime() < 50 * 60000 && !instructions) {
    return existing; // already being made
  }
  const topic = existing?.topic && instructions ? existing.topic : topicFor(day);
  const reel = existing
    ? await prisma.reel.update({ where: { id: existing.id }, data: { status: 'generating', instructions, error: null, video: null, video_size: null, approved_at: null } })
    : await prisma.reel.create({ data: { day, topic, instructions } });
  try {
    const repo = await ensureReelsRepo();
    const { gh } = require('./github');
    const info = await gh('GET', `/repos/${repo}`);
    for (let i = 0; i < 6; i++) {
      try {
        await gh('POST', `/repos/${repo}/actions/workflows/daily-reel.yml/dispatches`, {
          ref: info.default_branch || 'main',
          inputs: { reel_id: reel.id, prompt: reelPrompt(day, topic, instructions).slice(0, 60000) },
        });
        break;
      } catch (err) {
        if (err.status !== 404 || i === 5) throw err;
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    const runUrl = `${info.html_url}/actions/workflows/daily-reel.yml`;
    await prisma.reel.update({ where: { id: reel.id }, data: { run_url: runUrl } });
    await logAction(null, 'REEL_STARTED', `Claude is coding the ${day} reel (${source}): ${topic.slice(0, 140)}`);
    return prisma.reel.findUnique({ where: { id: reel.id } });
  } catch (err) {
    await prisma.reel.update({ where: { id: reel.id }, data: { status: 'failed', error: err.message } });
    await logError(null, 'REEL_START', err);
    throw err;
  }
}

function postTimeToday(now = new Date()) {
  const p = istParts(now);
  return istDate(p.year, p.month, p.day, config.reels.postHour, config.reels.postMinute);
}

function reelVideoUrl(reel) {
  return `${config.publicBaseUrl}/reels/${reel.id}.mp4`;
}

/** Upload from the workflow: store the MP4 + caption, tell sir, ask for approval. */
async function handleReelUpload({ reelId, video, meta, runUrl, failed }) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) return { ignored: true };
  // A late/duplicate run must not replace a reel that's already ready, approved or posted.
  if (reel.status !== 'generating' && reel.status !== 'failed') return { ignored: true, status: reel.status };
  if (failed) {
    await prisma.reel.update({ where: { id: reel.id }, data: { status: 'failed', error: 'The reel workflow failed', run_url: runUrl || reel.run_url } });
    await notifyOwner(`⚠️ Sir, today's reel couldn't be made. Details: ${runUrl || reel.run_url}\nTell Jarvis "make today's reel again" to retry.`);
    return { ok: true };
  }
  let info = {};
  try { info = JSON.parse(Buffer.from(String(meta || ''), 'base64').toString('utf8')); } catch { /* keep defaults */ }
  const caption = String(info.caption || '').slice(0, 2200) || null;
  const updated = await prisma.reel.update({
    where: { id: reel.id },
    data: {
      status: 'ready', video, video_size: video.length, caption, topic: info.topic ? String(info.topic).slice(0, 300) : reel.topic,
      run_url: runUrl || reel.run_url, ready_at: new Date(), error: null,
    },
  });
  // Older videos aren't needed once posted — keep the database small.
  await prisma.reel.updateMany({
    where: { status: { in: ['posted', 'rejected'] }, video: { not: null }, updated_at: { lt: new Date(Date.now() - 3 * 86400000) } },
    data: { video: null },
  }).catch(() => {});

  const when = Date.now() < postTimeToday().getTime() ? 'at 7:30 PM' : 'right away';
  await notifyOwner(`🎬 Sir, today's Instagram reel is ready:\n${reelVideoUrl(updated)}\n\n📝 Caption:\n${(caption || '').slice(0, 900)}\n\n`
    + `It will NOT be posted until you approve. Say yes when Jarvis calls, tell him "approve the reel", or approve it in the dashboard — it posts ${when}.`);
  try {
    await require('./ownerCalls').requestOwnerCall('REEL', {
      data: { reel_id: updated.id, notice: `Today's Instagram reel is ready, sir — I've sent the video and caption to your WhatsApp. It's about ${String(updated.topic || 'our services').split(/[—:]/)[0].trim()}. Shall I post it ${when}?` },
    });
  } catch (err) {
    await logError(null, 'REEL_APPROVAL_CALL', err);
  }
  await logAction(null, 'REEL_READY', `${updated.day} reel ready (${Math.round(video.length / 1024)} KB) — waiting for your approval`);
  return { ok: true };
}

async function approveReel(reelId, source = 'dashboard') {
  const reel = reelId ? await prisma.reel.findUnique({ where: { id: reelId } }) : await latestOpenReel();
  if (!reel) throw Object.assign(new Error('There is no reel waiting for approval'), { status: 404 });
  if (reel.status !== 'ready') throw Object.assign(new Error(`This reel is ${reel.status}, not waiting for approval`), { status: 409 });
  const updated = await prisma.reel.update({ where: { id: reel.id }, data: { status: 'approved', approved_at: new Date() } });
  await prisma.ownerCall.updateMany({ where: { type: 'REEL', status: { in: ['QUEUED', 'NEEDS_MANUAL', 'CALLING'] } }, data: { status: 'APPROVED', decided_at: new Date(), decision_note: `Approved on ${source}` } });
  await logAction(null, 'REEL_APPROVED', `${reel.day} reel approved (${source})`);
  if (Date.now() >= postTimeToday().getTime() || reel.day < todayIST()) postDueReels().catch(() => {});
  return updated;
}

async function rejectReel(reelId, { instructions = null, source = 'dashboard' } = {}) {
  const reel = reelId ? await prisma.reel.findUnique({ where: { id: reelId } }) : await latestOpenReel();
  if (!reel) throw Object.assign(new Error('There is no reel waiting for approval'), { status: 404 });
  await prisma.ownerCall.updateMany({ where: { type: 'REEL', status: { in: ['QUEUED', 'NEEDS_MANUAL', 'CALLING'] } }, data: { status: 'REJECTED', decided_at: new Date(), decision_note: instructions || `Rejected on ${source}` } });
  if (instructions) return requestReel({ day: reel.day, instructions, source });
  const updated = await prisma.reel.update({ where: { id: reel.id }, data: { status: 'rejected' } });
  await logAction(null, 'REEL_REJECTED', `${reel.day} reel rejected (${source})`);
  return updated;
}

async function latestOpenReel() {
  return prisma.reel.findFirst({ where: { status: { in: ['ready', 'generating', 'approved'] } }, orderBy: { day: 'desc' } });
}

// ── Instagram ────────────────────────────────────────────────────────────────────────────
async function igToken() {
  return (await getSetting('instagram_token')) || config.instagram.token;
}

async function ig(method, p, params = {}) {
  const token = await igToken();
  if (!token) throw Object.assign(new Error('Instagram is not connected — add INSTAGRAM_ACCESS_TOKEN on Render'), { status: 400 });
  const qs = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${config.instagram.graph}${p}${method === 'GET' ? `?${qs}` : ''}`, {
    method,
    ...(method === 'GET' ? {} : { body: qs, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const err = new Error(`Instagram ${p} → ${res.status}: ${json.error?.message || JSON.stringify(json).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function igUserId() {
  if (config.instagram.userId) return config.instagram.userId;
  const cached = await getSetting('instagram_user_id');
  if (cached) return cached;
  const me = await ig('GET', '/me', { fields: 'user_id,username' });
  const id = String(me.user_id || me.id);
  await setSetting('instagram_user_id', id);
  if (me.username) await setSetting('instagram_username', me.username);
  return id;
}

/** Long-lived Instagram tokens last 60 days; refresh weekly so posting never stops. */
async function refreshTokenIfDue() {
  if (!(await igToken())) return;
  const last = await getSetting('instagram_token_refreshed_at');
  if (last && Date.now() - Date.parse(last) < 7 * 86400000) return;
  try {
    const token = await igToken();
    const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(30000) });
    const json = await res.json().catch(() => ({}));
    if (json.access_token) {
      await setSetting('instagram_token', json.access_token);
      await logAction(null, 'INSTAGRAM_TOKEN_REFRESHED', `Instagram token refreshed (valid ~${Math.round((json.expires_in || 0) / 86400)} days)`);
    } else {
      await logError(null, 'INSTAGRAM_TOKEN_REFRESH', new Error(json.error?.message || 'refresh failed'));
    }
  } finally {
    await setSetting('instagram_token_refreshed_at', new Date().toISOString());
  }
}

async function publishReel(reel) {
  await prisma.reel.update({ where: { id: reel.id }, data: { status: 'posting', error: null } });
  try {
    const userId = await igUserId();
    let containerId = reel.ig_container_id;
    if (!containerId) {
      const c = await ig('POST', `/${userId}/media`, { media_type: 'REELS', video_url: reelVideoUrl(reel), caption: reel.caption || '', share_to_feed: 'true' });
      containerId = c.id;
      await prisma.reel.update({ where: { id: reel.id }, data: { ig_container_id: containerId } });
    }
    // Instagram downloads and processes the video — wait until it's FINISHED (up to ~5 min).
    for (let i = 0; i < 30; i++) {
      const st = await ig('GET', `/${containerId}`, { fields: 'status_code,status' });
      if (st.status_code === 'FINISHED') break;
      if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram couldn't process the video: ${st.status || st.status_code}`);
      await new Promise((r) => setTimeout(r, 10000));
    }
    const pub = await ig('POST', `/${userId}/media_publish`, { creation_id: containerId });
    let permalink = null;
    try { permalink = (await ig('GET', `/${pub.id}`, { fields: 'permalink' })).permalink; } catch { /* optional */ }
    await prisma.reel.update({ where: { id: reel.id }, data: { status: 'posted', ig_media_id: pub.id, ig_permalink: permalink, posted_at: new Date() } });
    await logAction(null, 'REEL_POSTED', `${reel.day} reel posted on Instagram${permalink ? `: ${permalink}` : ''}`);
    await notifyOwner(`✅ Sir, today's reel is live on Instagram${permalink ? `:\n${permalink}` : '.'}`);
    // Jarvis calls with the Instagram briefing right after the post goes live.
    require('./weeklyReport').sendInstagramBriefing({ justPosted: { topic: reel.topic, ig_media_id: pub.id } })
      .catch((err) => logError(null, 'INSTAGRAM_BRIEFING', err));
  } catch (err) {
    await prisma.reel.update({ where: { id: reel.id }, data: { status: 'failed', error: err.message } });
    await logError(null, 'REEL_POST', err);
    await notifyOwner(`⚠️ Sir, I couldn't post today's reel on Instagram: ${err.message.slice(0, 300)}`);
  }
}

let posting = false;
async function postDueReels() {
  if (posting) return;
  posting = true;
  try {
    const due = await prisma.reel.findMany({ where: { status: 'approved' }, orderBy: { day: 'asc' } });
    for (const r of due) {
      if (r.day === todayIST() && Date.now() < postTimeToday().getTime()) continue;
      await publishReel(r);
    }
  } finally {
    posting = false;
  }
}

/** Put the 7:30 PM reel slot on sir's Google Calendar for today and the next 6 days (once per day). */
let lastCalendarSync = 0;
async function syncReelCalendar(now = new Date()) {
  if (!config.isConfigured.google || now.getTime() - lastCalendarSync < 60 * 60000) return;
  lastCalendarSync = now.getTime();
  const { addCalendarEvent } = require('./googleCalendar');
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const day = todayIST(d);
    const key = `reel_event_${day}`;
    if (await getSetting(key)) continue;
    const p = istParts(d);
    const start = istDate(p.year, p.month, p.day, config.reels.postHour, config.reels.postMinute);
    if (start.getTime() < now.getTime()) { await setSetting(key, 'past'); continue; }
    const topic = topicFor(day);
    try {
      const ev = await addCalendarEvent({
        title: `📲 Instagram reel goes live — ${topic.split(/[—:]/)[0].trim()}`.slice(0, 120),
        start,
        minutes: 15,
        description: `Daily Instagram reel for @infinitywebapps.\n\nTopic: ${topic}\n\n`
          + `${config.reels.prepareHour}:00 — Claude makes the reel; you get it on WhatsApp and Jarvis calls for your approval.\n`
          + `${config.reels.postHour}:${String(config.reels.postMinute).padStart(2, '0')} — it's posted on Instagram (only if you approved it).\n\nManage it on the Reels page of the dashboard.`,
      });
      await setSetting(key, ev.id || 'added');
    } catch (err) {
      await logError(null, 'REEL_CALENDAR', err);
      break;
    }
  }
}

/** Called every minute by the worker. */
let lastTick = 0;
async function reelsTick(now = new Date()) {
  if (!config.isConfigured.reels || now.getTime() - lastTick < 60000) return;
  lastTick = now.getTime();
  const p = istParts(now);
  if (p.hour >= config.reels.prepareHour && p.hour < 22) {
    const day = todayIST(now);
    const existing = await prisma.reel.findUnique({ where: { day } });
    const stuck = existing?.status === 'generating' && !existing.run_url && Date.now() - existing.updated_at.getTime() > 3 * 60000;
    if (!existing || stuck) await requestReel({ day, source: stuck ? 'restart after interrupted setup' : 'daily 5 PM schedule' }).catch(() => {});
  }
  await postDueReels().catch((err) => logError(null, 'REEL_POST', err));
  await syncReelCalendar(now).catch((err) => logError(null, 'REEL_CALENDAR', err));
  await refreshTokenIfDue().catch((err) => logError(null, 'INSTAGRAM_TOKEN_REFRESH', err));
}

module.exports = {
  requestReel, handleReelUpload, approveReel, rejectReel, publishReel, postDueReels, reelsTick, latestOpenReel,
  todayIST, topicFor, reelVideoUrl, ensureReelsRepo, REEL_WORKFLOW, getSetting, setSetting, postTimeToday, syncReelCalendar, ig, igUserId,
};
