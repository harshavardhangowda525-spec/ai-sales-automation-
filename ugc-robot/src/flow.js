// Make one vertical clip in Google Flow (sir's subscription credits) and save the MP4.
// The finished video is captured from the page's own network traffic (the first new video/mp4 the
// page loads after "Generate"), so no download button has to be found.
const fs = require('fs');
const path = require('path');
const sel = require('./selectors.json').flow;

async function first(page, list, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const s of list) {
      const l = page.locator(s).first();
      if (await l.isVisible().catch(() => false)) return l;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function makeClip(ctx, prompt, outFile, { aspect = '9:16', dir, timeoutMin = 12 } = {}) {
  const page = await ctx.newPage();
  const seen = new Set();
  let resolveVideo;
  const video = new Promise((r) => { resolveVideo = r; });
  let armed = false;
  page.on('response', async (res) => {
    try {
      const type = res.headers()['content-type'] || '';
      if (!armed || !/video\/mp4/.test(type) || seen.has(res.url())) return;
      seen.add(res.url());
      const body = await res.body();
      if (body.length > 200000) resolveVideo(body);
    } catch { /* streamed/ranged responses are retried below */ }
  });
  try {
    await page.goto(sel.url, { waitUntil: 'domcontentloaded' });
    if (/accounts\.google\.com/.test(page.url())) throw new Error('Flow is signed out: sign in again on the robot machine (see README)');
    (await first(page, sel.newProject, 15000))?.click();
    await page.waitForTimeout(3000);
    // Portrait 9:16 (open settings first if the toggle is inside it).
    if (aspect === '9:16') {
      let a = await first(page, sel.aspect, 3000);
      if (!a) { (await first(page, sel.settings, 5000))?.click(); a = await first(page, sel.aspect, 5000); }
      if (a) await a.click(); else console.warn('9:16 toggle not found — check selectors.json (npm run probe)');
      await page.keyboard.press('Escape').catch(() => {});
    }
    const box = await first(page, sel.prompt, 20000);
    if (!box) throw new Error('Flow prompt box not found (layout changed? run npm run probe)');
    await box.click();
    await page.keyboard.insertText(prompt);
    armed = true;
    const go = await first(page, sel.generate, 5000);
    if (go) await go.click(); else await page.keyboard.press('Enter');
    const body = await Promise.race([
      video,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`Flow did not return a video within ${timeoutMin} min (out of credits? signed out?)`)), timeoutMin * 60000)),
    ]);
    fs.writeFileSync(outFile, body);
    return outFile;
  } catch (err) {
    if (dir) await page.screenshot({ path: path.join(dir, `flow-error-${path.basename(outFile)}.png`) }).catch(() => {});
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { makeClip };
