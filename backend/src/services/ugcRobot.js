// Daily UGC ads made on sir's own Gemini subscription by the robot browser (ugc-robot/ on the free
// Oracle machine). The server only hands out the day's job and receives the finished video through the
// usual reel upload; approval (Jarvis call) and posting stay exactly as for every reel.
const prisma = require('../lib/prisma');
const config = require('../lib/config');
const { logAction } = require('../lib/logger');

// Who is "talking" each day: an AI business owner like the people we sell to (never a real customer).
const SCENARIOS = [
  'a café owner in Jayanagar who used to miss table bookings on busy evenings',
  'a salon owner in Indiranagar whose phone never stopped ringing for appointments',
  'a gym owner in HSR Layout who wanted more trial sign-ups from Google',
  'a dental clinic owner in Koramangala whose patients could not find the clinic online',
  'a boutique owner in Malleshwaram who wanted to sell beyond walk-in customers',
  'a home bakery owner in Whitefield taking every order on WhatsApp by hand',
  'a tuition centre owner in Rajajinagar who wanted parents to enquire online',
  'a physiotherapy clinic owner in BTM Layout losing patients to clinics with websites',
  'a restaurant owner in Basavanagudi paying high commissions to delivery apps',
  'an interior designer in JP Nagar whose portfolio lived only on a phone gallery',
];

const PLANS = 'Basic website ₹4,999 (live in about 7 days, WhatsApp button, Google Maps, contact form); Premium ₹8,999 (SEO, Google reviews, motion design); Advanced ₹15,000 (online bookings, payments, admin panel)';

function scenarioFor(day) {
  const n = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000);
  return SCENARIOS[n % SCENARIOS.length];
}

/** The message the robot types into Gemini to get the 3 scenes + caption as JSON. */
function writerPrompt(reel) {
  const phone = String(config.reels.ctaPhone || config.ownerPhone || '').replace(/\D/g, '').slice(-10);
  return [
    'You are writing a vertical (9:16) UGC-style Instagram ad for Infinity Web & Apps, a Bengaluru agency that builds websites, web apps and automation for local businesses.',
    `Speaker: ${reel.topic}. They are an AI-generated character speaking to the phone camera in a natural, warm, slightly excited way, in Indian English. They are NOT a real customer and must not claim to be one; they speak as "a business owner like you".`,
    'Write exactly 3 scenes, each about 12 seconds of speech (25–32 words). Scene 1: the problem (hook in the first 2 seconds). Scene 2: discovering a website from Infinity Web & Apps and what it automates. Scene 3: the offer and call to action.',
    `Prices to use (do not change them): ${PLANS}. CTA: "free 15-minute consultation — WhatsApp ${phone || 'us'}".`,
    'For each scene give a video prompt for an AI video generator: same person, same outfit and location in all 3 scenes, handheld selfie framing, natural light, and the exact spoken line in double quotes.',
    'Also write an Instagram caption: hook line, 2–4 short lines of value, prices, the CTA, the line "🤖 Made with AI", then 8–12 hashtags (#Bengaluru #SmallBusiness #WebsiteDesign …). Max 1,800 characters.',
    reel.instructions ? `Sir asked for these changes — follow them first: ${reel.instructions}` : null,
    'Reply with ONLY this JSON, no other text: {"topic": "short title", "scenes": [{"line": "...", "video_prompt": "..."}, {"line": "...", "video_prompt": "..."}, {"line": "...", "video_prompt": "..."}], "caption": "..."}',
  ].filter(Boolean).join('\n\n');
}

const MARK = 'ugc-robot';

/** Called by requestReel when REELS_ENGINE=ugc_robot: the reel waits for the robot to pick it up. */
async function queueForRobot(reel) {
  await prisma.ugcClip.deleteMany({ where: { reel_id: reel.id } });
  const updated = await prisma.reel.update({ where: { id: reel.id }, data: { run_url: `${MARK}:queued`, topic: reel.instructions && reel.topic ? reel.topic : scenarioFor(reel.day) } });
  await logAction(null, 'REEL_STARTED', `UGC ad for ${reel.day} queued for the Gemini robot: ${updated.topic}`);
  return updated;
}

/** Robot asks for work. Returns the oldest reel waiting for it, marked as taken. */
async function nextJob() {
  const reel = await prisma.reel.findFirst({ where: { status: 'generating', run_url: `${MARK}:queued` }, orderBy: { day: 'asc' } });
  if (!reel) return null;
  const claimed = await prisma.reel.updateMany({ where: { id: reel.id, run_url: `${MARK}:queued` }, data: { run_url: `${MARK}:working:${new Date().toISOString()}` } });
  if (!claimed.count) return null;
  return {
    reel_id: reel.id, day: reel.day, speaker: reel.topic, writer_prompt: writerPrompt(reel),
    clips: CLIPS, seconds_per_clip: 12, aspect_ratio: '9:16',
    script_url: `${config.publicBaseUrl}/ugc-robot/script?reel_id=${reel.id}`,
    clip_url: `${config.publicBaseUrl}/ugc-robot/clip?reel_id=${reel.id}&n=`,
    upload_url: `${config.publicBaseUrl}/webhook/reels/upload?reel_id=${reel.id}${config.webhookSecret ? `&secret=${encodeURIComponent(config.webhookSecret)}` : ''}`,
  };
}

const CLIPS = 3;
const checkId = (id) => { if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw Object.assign(new Error('reel_id is missing or invalid'), { status: 400 }); };

/** Claude (on sir's laptop) sends the script it wrote: topic + caption. */
async function saveScript(reelId, { topic, caption } = {}) {
  checkId(reelId);
  const reel = await prisma.reel.findUnique({ where: { id: reelId }, select: { id: true, status: true } });
  if (!reel) throw Object.assign(new Error('Unknown reel'), { status: 404 });
  if (reel.status !== 'generating') throw Object.assign(new Error(`This reel is ${reel.status}`), { status: 409 });
  if (!caption) throw Object.assign(new Error('caption is required'), { status: 400 });
  await prisma.reel.update({ where: { id: reelId }, data: { caption: String(caption).slice(0, 2200), ...(topic ? { topic: String(topic).slice(0, 300) } : {}), run_url: `${MARK}:working:${new Date().toISOString()}` } });
  return maybeFinish(reelId);
}

/** One clip (1..3). When all clips and the caption are in, they are joined and sent for approval. */
async function saveClip(reelId, n, data) {
  checkId(reelId);
  n = Number(n);
  if (!(n >= 1 && n <= CLIPS)) throw Object.assign(new Error(`n must be 1..${CLIPS}`), { status: 400 });
  if (!Buffer.isBuffer(data) || data.length < 50000) throw Object.assign(new Error('That is not a video file (too small)'), { status: 400 });
  const reel = await prisma.reel.findUnique({ where: { id: reelId }, select: { id: true, status: true } });
  if (!reel) throw Object.assign(new Error('Unknown reel'), { status: 404 });
  if (reel.status !== 'generating') throw Object.assign(new Error(`This reel is ${reel.status}`), { status: 409 });
  await prisma.ugcClip.upsert({ where: { reel_id_n: { reel_id: reelId, n } }, create: { reel_id: reelId, n, data }, update: { data, created_at: new Date() } });
  await prisma.reel.update({ where: { id: reelId }, data: { run_url: `${MARK}:working:${new Date().toISOString()}` } });
  return maybeFinish(reelId);
}

let finishing = new Set();
async function maybeFinish(reelId) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId }, select: { id: true, caption: true, topic: true, status: true } });
  const clips = await prisma.ugcClip.findMany({ where: { reel_id: reelId }, orderBy: { n: 'asc' } });
  const have = clips.map((c) => c.n);
  if (clips.length < CLIPS || !reel.caption) return { received: have, caption: Boolean(reel.caption), done: false };
  if (finishing.has(reelId)) return { received: have, caption: true, done: false, joining: true };
  finishing.add(reelId);
  try {
    const video = await require('./videoStitch').stitchClips(clips.map((c) => Buffer.from(c.data)));
    const meta = Buffer.from(JSON.stringify({ topic: reel.topic, caption: reel.caption })).toString('base64');
    await require('./reels').handleReelUpload({ reelId, video, meta, runUrl: `${MARK}:done` });
    await prisma.ugcClip.deleteMany({ where: { reel_id: reelId } });
    return { received: have, caption: true, done: true, size_kb: Math.round(video.length / 1024), message: 'Joined and sent to sir for approval (Jarvis is calling).' };
  } finally {
    finishing.delete(reelId);
  }
}

async function heartbeat(status = {}) {
  await prisma.appSetting.upsert({
    where: { key: 'ugc_robot_status' },
    create: { key: 'ugc_robot_status', value: JSON.stringify({ ...status, last_seen: new Date().toISOString() }).slice(0, 5000) },
    update: { value: JSON.stringify({ ...status, last_seen: new Date().toISOString() }).slice(0, 5000) },
  });
}

async function robotStatus() {
  const raw = (await prisma.appSetting.findUnique({ where: { key: 'ugc_robot_status' } }))?.value;
  let s = null;
  try { s = raw ? JSON.parse(raw) : null; } catch { s = null; }
  return { online: Boolean(s?.last_seen && Date.now() - Date.parse(s.last_seen) < 5 * 60000), ...(s || {}) };
}

/**
 * Safety net, run every minute: a job the robot never picked up (offline) or never finished
 * (stuck > 75 min) becomes a failed reel, and sir hears about it the same day.
 */
async function watchdog(now = new Date()) {
  const reels = await prisma.reel.findMany({ where: { status: 'generating', run_url: { startsWith: MARK } } });
  for (const r of reels) {
    const age = now.getTime() - r.updated_at.getTime();
    const queued = r.run_url === `${MARK}:queued`;
    if ((queued && age > 20 * 60000) || (!queued && age > 75 * 60000)) {
      const st = await robotStatus();
      const why = queued ? 'the Claude task on your laptop did not start (is the laptop on with Claude open?)' : 'the Claude task on your laptop did not finish in time';
      await prisma.reel.update({ where: { id: r.id }, data: { status: 'failed', error: why } });
      const reels = require('./reels');
      await reels.notifyOwner?.(`⚠️ Sir, today's UGC ad couldn't be made: ${why}${st.error ? ` (${String(st.error).slice(0, 200)})` : ''}. Tell Jarvis "make today's reel again" to retry.`);
      await require('./ownerCalls').requestOwnerCall('NOTICE', { data: { notice: `Sir, today's Instagram ad couldn't be made because ${why}. I've sent the details to your WhatsApp.` } }).catch(() => {});
      await logAction(null, 'REEL_FAILED', `${r.day}: ${why}`);
    }
  }
}

module.exports = { queueForRobot, nextJob, saveScript, saveClip, heartbeat, robotStatus, watchdog, writerPrompt, scenarioFor, MARK };
