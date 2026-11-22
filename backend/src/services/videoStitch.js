// Join UGC clips into one Instagram-ready reel (1080×1920, 30 fps, H.264 + AAC, fast start) with the
// ffmpeg binary bundled by ffmpeg-static. Clips can differ in size/fps or lack audio.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, ['-y', '-hide_banner', ...args], { maxBuffer: 20 * 1024 * 1024, timeout: 10 * 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg: ${String(stderr || err.message).split('\n').filter(Boolean).slice(-3).join(' | ')}`));
      else resolve(String(stderr));
    });
  });
}

async function hasAudio(file) {
  const info = await run(['-i', file, '-f', 'null', '-t', '0.1', '-']).catch((e) => e.message);
  return /Audio:/.test(info);
}

/** @param {Buffer[]} clips → Buffer (MP4) */
async function stitchClips(clips) {
  if (!clips.length) throw new Error('no clips to join');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugc-'));
  try {
    const parts = [];
    for (let i = 0; i < clips.length; i++) {
      const src = path.join(dir, `in${i}.mp4`);
      const out = path.join(dir, `n${i}.mp4`);
      fs.writeFileSync(src, clips[i]);
      const input = (await hasAudio(src)) ? ['-i', src] : ['-i', src, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest'];
      await run([...input, '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k', out]);
      parts.push(out);
    }
    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
    const final = path.join(dir, 'ad.mp4');
    await run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final]);
    return fs.readFileSync(final);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { stitchClips };
