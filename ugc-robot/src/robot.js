// UGC robot: runs on the always-on Oracle machine next to a Chrome that sir signed in to once.
// Loop: heartbeat → ask the backend for today's job → Gemini writes 3 scenes + caption → Google Flow
// makes 3 vertical clips → ffmpeg joins them → upload to the backend (which calls sir for approval).
//   node src/robot.js          run forever
//   node src/robot.js --once   do one job if there is one, then exit
//   node src/robot.js --probe  save screenshots + page structure of Gemini and Flow (to fix selectors)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { writeScenes } = require('./gemini');
const { makeClip } = require('./flow');
const { stitch } = require('./stitch');

loadEnv(path.join(__dirname, '..', '.env'));
const API = (process.env.INFINITY_API_URL || '').replace(/\/$/, '');
const TOKEN = process.env.UGC_ROBOT_TOKEN || '';
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const WORK = process.env.WORK_DIR || path.join(require('os').homedir(), 'ugc-work');
const POLL = Number(process.env.POLL_SECONDS || 60) * 1000;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*([^#]*?)\s*(#.*)?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function api(p, body) {
  const res = await fetch(`${API}${p}`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p} → ${res.status} ${j.error || ''}`);
  return j;
}

let state = { state: 'idle', error: null, last_job: null };
async function beat(extra = {}) {
  state = { ...state, ...extra };
  await api('/ugc-robot/heartbeat', state).catch((e) => log('heartbeat failed:', e.message));
}

async function browser() {
  // Attach to the already-running, signed-in Chrome (started by setup.sh), never launch a new one.
  return chromium.connectOverCDP(CDP_URL);
}

async function runJob(job) {
  const dir = path.join(WORK, job.day);
  fs.mkdirSync(dir, { recursive: true });
  await beat({ state: 'working', last_job: job.reel_id, step: 'writing script', error: null });
  const b = await browser();
  const ctx = b.contexts()[0] || await b.newContext();
  try {
    const script = await writeScenes(ctx, job.writer_prompt, dir);
    fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script, null, 2));
    log('script:', script.topic);
    const clips = [];
    for (let i = 0; i < Math.min(job.clips || 3, script.scenes.length); i++) {
      await beat({ step: `making clip ${i + 1} of 3` });
      clips.push(await makeClip(ctx, script.scenes[i].video_prompt, path.join(dir, `clip${i + 1}.mp4`), { aspect: job.aspect_ratio, dir }));
      log('clip', i + 1, 'saved');
    }
    await beat({ step: 'joining clips' });
    const out = await stitch(clips, path.join(dir, 'ad.mp4'));
    await beat({ step: 'uploading' });
    const video = fs.readFileSync(out);
    const meta = Buffer.from(JSON.stringify({ topic: script.topic, caption: script.caption })).toString('base64');
    const res = await fetch(job.upload_url, { method: 'POST', headers: { 'content-type': 'video/mp4', 'x-reel-meta': meta, 'x-run-url': 'ugc-robot' }, body: video });
    if (!res.ok) throw new Error(`upload → ${res.status} ${await res.text()}`);
    log('uploaded', Math.round(video.length / 1024), 'KB');
    await beat({ state: 'idle', step: null, last_success: new Date().toISOString() });
  } catch (err) {
    log('job failed:', err.message);
    for (const p of ctx.pages()) await p.screenshot({ path: path.join(dir, `error-${Date.now()}.png`) }).catch(() => {});
    await fetch(`${job.upload_url}&failed=1`, { method: 'POST', headers: { 'x-run-url': `ugc-robot: ${err.message.slice(0, 200)}` }, body: '' }).catch(() => {});
    await beat({ state: 'idle', step: null, error: err.message.slice(0, 500) });
  } finally {
    await b.close().catch(() => {}); // disconnects only; the signed-in Chrome keeps running
  }
}

async function probe() {
  const dir = path.join(WORK, 'probe');
  fs.mkdirSync(dir, { recursive: true });
  const b = await browser();
  const ctx = b.contexts()[0];
  const sel = require('./selectors.json');
  for (const [name, url] of [['gemini', sel.gemini.url], ['flow', sel.flow.url]]) {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000);
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
    fs.writeFileSync(path.join(dir, `${name}.aria.txt`), await page.locator('body').ariaSnapshot().catch((e) => String(e)));
    log(name, '→', page.url(), '(signed in?', !/accounts\.google\.com/.test(page.url()), ')');
    await page.close();
  }
  await b.close();
  log('probe saved to', dir);
}

async function main() {
  if (!API || !TOKEN) throw new Error('Set INFINITY_API_URL and UGC_ROBOT_TOKEN in ugc-robot/.env');
  if (process.argv.includes('--probe')) return probe();
  const once = process.argv.includes('--once');
  for (;;) {
    try {
      await beat();
      const { job } = await api('/ugc-robot/next');
      if (job) { log('job', job.day, job.reel_id); await runJob(job); }
      else if (once) log('no job waiting');
    } catch (err) {
      log('loop error:', err.message);
      await beat({ error: err.message.slice(0, 500) });
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, POLL));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
