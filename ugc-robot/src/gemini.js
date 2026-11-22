// Ask Gemini (sir's subscription, in the signed-in Chrome) to write the 3 scenes + caption as JSON.
const path = require('path');
const sel = require('./selectors.json').gemini;

async function first(page, list, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const s of list) {
      const l = page.locator(s).last();
      if (await l.isVisible().catch(() => false)) return l;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Gemini page: none of ${JSON.stringify(list)} found (layout changed? run npm run probe)`);
}

function parseScript(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Gemini did not reply with JSON');
  const j = JSON.parse(m[0]);
  if (!Array.isArray(j.scenes) || j.scenes.length < 3 || !j.scenes.every((s) => s.video_prompt)) throw new Error('Gemini JSON is missing the 3 scenes');
  if (!j.caption) throw new Error('Gemini JSON is missing the caption');
  return { topic: String(j.topic || 'UGC ad').slice(0, 200), scenes: j.scenes.slice(0, 3), caption: String(j.caption).slice(0, 2200) };
}

async function writeScenes(ctx, prompt, dir) {
  const page = await ctx.newPage();
  try {
    await page.goto(sel.url, { waitUntil: 'domcontentloaded' });
    if (/accounts\.google\.com/.test(page.url())) throw new Error('Gemini is signed out: sign in again on the robot machine (see README)');
    const input = await first(page, sel.input);
    await input.click();
    await page.keyboard.insertText(prompt);
    const before = await page.locator(sel.response.join(',')).count();
    const send = await first(page, sel.send, 5000).catch(() => null);
    if (send) await send.click(); else await page.keyboard.press('Enter');
    // Wait for a new answer, then for Gemini to stop "typing".
    const end = Date.now() + 4 * 60000;
    while (Date.now() < end && (await page.locator(sel.response.join(',')).count()) <= before) await page.waitForTimeout(1000);
    await page.waitForTimeout(3000);
    while (Date.now() < end && await page.locator(sel.busy.join(',')).first().isVisible().catch(() => false)) await page.waitForTimeout(1000);
    const text = await page.locator(sel.response.join(',')).last().innerText();
    await page.screenshot({ path: path.join(dir, 'gemini.png') }).catch(() => {});
    return parseScript(text);
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { writeScenes, parseScript };
