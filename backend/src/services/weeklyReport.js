// Weekly report: every Sunday 8 PM IST Jarvis calls sir with the week's sales + Instagram results,
// and the full report goes to his WhatsApp. Followers are snapshotted daily (Instagram only offers
// follower history to accounts with 100+ followers).
const config = require('../lib/config');
const prisma = require('../lib/prisma');
const { logAction, logError } = require('../lib/logger');
const { istParts } = require('../lib/time');

const REPORT_DAY = Number(process.env.WEEKLY_REPORT_WEEKDAY ?? 0); // 0 = Sunday
const REPORT_HOUR = Number(process.env.WEEKLY_REPORT_HOUR ?? 20);  // 8 PM IST
const GOAL_LIKES = Number(process.env.REELS_GOAL_LIKES ?? 20);      // a reel "hit the target" at this many likes…
const GOAL_VIEWS = Number(process.env.REELS_GOAL_VIEWS ?? 500);     // …or this many views

const reels = () => require('./reels');
const n = (x) => Number(x) || 0;
const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

function dayKey(d) {
  const p = istParts(d);
  return `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Save today's follower count (called from the worker; once a day). */
async function snapshotFollowers(now = new Date()) {
  const key = `ig_followers_${dayKey(now)}`;
  if (await reels().getSetting(key)) return;
  try {
    const me = await reels().ig('GET', '/me', { fields: 'followers_count' });
    await reels().setSetting(key, String(n(me.followers_count)));
  } catch {
    // Instagram not connected — skip
  }
}

async function followersOn(d) {
  const v = await reels().getSetting(`ig_followers_${dayKey(d)}`);
  return v === null ? null : n(v);
}

async function instagramWeek(since) {
  const out = { connected: false, followers: null, followersBefore: null, posts: [], avgLikesBefore: null };
  try {
    const me = await reels().ig('GET', '/me', { fields: 'followers_count,username' });
    out.connected = true;
    out.followers = n(me.followers_count);
    out.username = me.username;
    // Oldest snapshot within the last 8 days is the "before" number.
    for (let i = 8; i >= 6 && out.followersBefore === null; i--) out.followersBefore = await followersOn(new Date(Date.now() - i * 86400000));
    if (out.followersBefore === null) {
      for (let i = 7; i >= 1 && out.followersBefore === null; i--) out.followersBefore = await followersOn(new Date(Date.now() - i * 86400000));
    }
    const media = await reels().ig('GET', '/me/media', { fields: 'id,media_type,caption,timestamp,like_count,comments_count,permalink', limit: '40' });
    const items = media.data || [];
    const thisWeek = items.filter((m) => Date.parse(m.timestamp) >= since.getTime());
    const before = items.filter((m) => Date.parse(m.timestamp) < since.getTime()).slice(0, 20);
    out.avgLikesBefore = before.length ? Math.round(before.reduce((s, m) => s + n(m.like_count), 0) / before.length) : null;
    for (const m of thisWeek) {
      const post = { id: m.id, when: m.timestamp, permalink: m.permalink, likes: n(m.like_count), comments: n(m.comments_count), title: String(m.caption || '').split('\n')[0].slice(0, 80) };
      try {
        const ins = await reels().ig('GET', `/${m.id}/insights`, { metric: 'views,reach,shares,saved' });
        for (const row of ins.data || []) post[row.name] = n(row.values?.[0]?.value);
      } catch {
        // insights not available for this media type
      }
      post.hit = post.likes >= GOAL_LIKES || n(post.views) >= GOAL_VIEWS;
      out.posts.push(post);
    }
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

async function salesWeek(since) {
  const range = { gte: since };
  const [newCampaigns, campaignClients, manualClients, meetings, quotationsSent, builds, deploys, relays] = await Promise.all([
    prisma.campaign.count({ where: { created_at: range } }),
    prisma.client.findMany({ where: { created_at: range, campaign_id: { not: null } }, select: { call_outcome: true, business_name: true, contact_name: true } }),
    prisma.client.count({ where: { created_at: range, call_outcome: 'MANUAL' } }),
    prisma.client.findMany({ where: { meeting_link: { not: null }, updated_at: range, meeting_time: { not: null } }, select: { business_name: true, contact_name: true, meeting_time: true } }),
    prisma.ownerCall.count({ where: { type: 'QUOTATION', status: 'SENT', updated_at: range } }),
    prisma.callLog.count({ where: { action: 'CLAUDE_BUILD_DONE', timestamp: range } }),
    prisma.callLog.findMany({ where: { action: 'DEPLOY_DONE', timestamp: range }, select: { details: true } }),
    prisma.relayCall.count({ where: { created_at: range } }),
  ]);
  const count = (o) => campaignClients.filter((c) => c.call_outcome === o).length;
  const booked = campaignClients.filter((c) => c.call_outcome === 'BOOKED');
  return {
    newCampaigns,
    calls: campaignClients.length,
    booked: booked.length,
    bookedNames: booked.map((c) => c.contact_name || c.business_name).filter((x) => x && x !== 'Unknown business'),
    callbacks: count('CALLBACK_LATER'),
    rejected: count('REJECTED'),
    noAnswer: count('NO_ANSWER'),
    manualClients,
    meetings: meetings.length,
    quotationsSent,
    builds,
    deploys: deploys.length,
    relays,
  };
}

async function buildWeeklyReport(now = new Date()) {
  const since = new Date(now.getTime() - 7 * 86400000);
  const [s, ig] = await Promise.all([salesWeek(since), instagramWeek(since)]);
  const postedReels = await prisma.reel.count({ where: { status: 'posted', posted_at: { gte: since } } });

  // ── Spoken (Jarvis, ~1 minute) ──
  const say = ["Here's your weekly report, sir."];
  say.push(s.calls ? `This week Jarvis made ${plural(s.calls, 'sales call')}: ${s.booked} booked, ${s.callbacks} want a callback, ${s.rejected} said no and ${s.noAnswer} didn't pick up.` : 'No sales campaigns ran this week.');
  if (s.bookedNames.length) say.push(`Bookings: ${s.bookedNames.slice(0, 4).join(', ')}.`);
  if (s.meetings) say.push(`${plural(s.meetings, 'Google Meet')} scheduled.`);
  if (s.quotationsSent) say.push(`${plural(s.quotationsSent, 'quotation')} went to clients.`);
  if (s.builds || s.deploys) say.push(`Claude finished ${plural(s.builds, 'build')} and ${plural(s.deploys, 'website')} went live.`);
  if (ig.connected) {
    const grew = ig.followersBefore !== null ? ig.followers - ig.followersBefore : null;
    say.push(`On Instagram you have ${ig.followers} followers${grew === null ? '' : grew > 0 ? `, up ${grew} this week` : grew < 0 ? `, down ${-grew} this week` : ', the same as last week'}.`);
    if (ig.posts.length) {
      const likes = ig.posts.reduce((a, p) => a + p.likes, 0);
      const views = ig.posts.reduce((a, p) => a + n(p.views), 0);
      const hits = ig.posts.filter((p) => p.hit).length;
      const best = [...ig.posts].sort((a, b) => (n(b.views) + b.likes * 20) - (n(a.views) + a.likes * 20))[0];
      say.push(`${plural(ig.posts.length, 'post')} this week got ${plural(views, 'view')} and ${plural(likes, 'like')} in total. ${hits} of ${ig.posts.length} reached your target of ${GOAL_LIKES} likes or ${GOAL_VIEWS} views.`);
      if (best && ig.posts.length > 1) say.push(`The best one was "${best.title.slice(0, 60)}" with ${plural(n(best.views), 'view')} and ${plural(best.likes, 'like')}.`);
      if (ig.avgLikesBefore !== null) say.push(`Your usual average is ${ig.avgLikesBefore} likes per post, so this week was ${likes / ig.posts.length >= ig.avgLikesBefore ? 'better than' : 'below'} usual.`);
    } else {
      say.push('No posts went out on Instagram this week.');
    }
  }
  say.push("I've sent the full report to your WhatsApp. Anything you want me to change for next week?");

  // ── WhatsApp (full detail) ──
  const lines = [`📊 *Weekly report* (${dayKey(since)} → ${dayKey(now)})`, '', '*Sales*'];
  lines.push(`• Calls made: ${s.calls}${s.newCampaigns ? ` (${plural(s.newCampaigns, 'campaign')})` : ''}`);
  lines.push(`• ✅ Booked: ${s.booked}${s.bookedNames.length ? ` — ${s.bookedNames.join(', ')}` : ''}`);
  lines.push(`• 🔁 Callback: ${s.callbacks}   ❌ No: ${s.rejected}   📵 No answer: ${s.noAnswer}`);
  lines.push(`• 📅 Meets scheduled: ${s.meetings}   📄 Quotations sent: ${s.quotationsSent}`);
  lines.push(`• 🛠️ Builds: ${s.builds}   🌐 Sites live: ${s.deploys}   ➕ Clients added by you: ${s.manualClients}`);
  lines.push('', '*Instagram*');
  if (!ig.connected) {
    lines.push(`• Not connected${ig.error ? ` (${ig.error.slice(0, 120)})` : ''}`);
  } else {
    const grew = ig.followersBefore !== null ? ig.followers - ig.followersBefore : null;
    lines.push(`• Followers: ${ig.followers}${grew === null ? ' (tracking starts this week)' : ` (${grew >= 0 ? '+' : ''}${grew} this week)`}`);
    lines.push(`• Reels posted by the automation: ${postedReels}   Posts this week: ${ig.posts.length}`);
    if (ig.avgLikesBefore !== null) lines.push(`• Your usual average: ${ig.avgLikesBefore} likes/post   Target: ${GOAL_LIKES} likes or ${GOAL_VIEWS} views`);
    for (const p of ig.posts) {
      lines.push(`${p.hit ? '🎯' : '▫️'} ${p.when.slice(5, 10)} — 👁 ${n(p.views)}  👍 ${p.likes}  💬 ${p.comments}  🔁 ${n(p.shares)}  🔖 ${n(p.saved)}  · ${p.title}`);
    }
  }
  return { spoken: say.join(' '), whatsapp: lines.join('\n'), sales: s, instagram: ig };
}

/** Call sir + WhatsApp the report. */
async function sendWeeklyReport(source = 'weekly schedule') {
  const r = await buildWeeklyReport();
  try {
    const waLinked = require('./waLinked');
    if (config.ownerPhone && (await waLinked.hasSession())) await waLinked.sendText(config.ownerPhone, r.whatsapp);
  } catch (err) {
    await logError(null, 'WEEKLY_REPORT_WHATSAPP', err);
  }
  await require('./ownerCalls').requestOwnerCall('NOTICE', { data: { notice: r.spoken.replace(/ Anything you want me to change for next week\?$/, '') } });
  await logAction(null, 'WEEKLY_REPORT_SENT', `Weekly report (${source}): ${r.sales.calls} calls, ${r.sales.booked} booked, ${r.instagram.posts.length} IG posts`);
  return r;
}

let lastTick = 0;
async function weeklyTick(now = new Date()) {
  if (now.getTime() - lastTick < 5 * 60000) return;
  lastTick = now.getTime();
  await snapshotFollowers(now).catch(() => {});
  const p = istParts(now);
  if (p.weekday !== REPORT_DAY || p.hour < REPORT_HOUR || p.hour >= 23) return;
  const key = `weekly_report_${dayKey(now)}`;
  if (await reels().getSetting(key)) return;
  await reels().setSetting(key, new Date().toISOString());
  await sendWeeklyReport().catch((err) => logError(null, 'WEEKLY_REPORT', err));
}

module.exports = { buildWeeklyReport, sendWeeklyReport, weeklyTick, snapshotFollowers };
