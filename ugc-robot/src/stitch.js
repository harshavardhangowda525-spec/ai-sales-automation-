// Join the clips into one Instagram-ready reel: 1080×1920, 30 fps, H.264 + AAC, fast start.
// Every clip is normalised first (Flow clips can differ in size, fps or have no audio track).
const { execFileSync } = require('child_process');
const fs = require('fs');

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
}

function hasAudio(file) {
  try {
    return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]).toString().trim() !== '';
  } catch { return false; }
}

function stitch(clips, out) {
  if (!clips.length) throw new Error('no clips to join');
  const parts = clips.map((c, i) => {
    const p = `${c}.norm${i}.mp4`;
    const vf = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p';
    const input = hasAudio(c) ? ['-i', c] : ['-i', c, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest'];
    ffmpeg([...input, '-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k', p]);
    return p;
  });
  const list = `${out}.txt`;
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
  for (const p of [...parts, list]) fs.rmSync(p, { force: true });
  const size = fs.statSync(out).size;
  if (size > 75 * 1024 * 1024) throw new Error(`ad is ${Math.round(size / 1048576)} MB, too big to upload`);
  return out;
}

module.exports = { stitch };
