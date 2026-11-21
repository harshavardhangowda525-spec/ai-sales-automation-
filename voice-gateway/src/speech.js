// Local speech engines (no hosted quotas):
//   STT — whisper.cpp's HTTP server (`whisper-server`), POST /inference with a WAV file.
//   TTS — Piper (`piper --output_raw`), resampled to the 16 kHz the HFP bridge expects.
const fs = require('fs');
const { spawn } = require('child_process');
const { wav, resample } = require('./audio');

async function transcribe(pcm, { url = process.env.WHISPER_URL || 'http://127.0.0.1:8080/inference', language = process.env.WHISPER_LANGUAGE || 'auto' } = {}) {
  const t0 = Date.now();
  const form = new FormData();
  form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'utterance.wav');
  form.append('response_format', 'json');
  form.append('language', language);
  form.append('temperature', '0');
  const res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`whisper-server ${res.status}`);
  const j = await res.json();
  return { text: String(j.text || '').replace(/\[[^\]]*\]/g, '').trim(), ms: Date.now() - t0 };
}

function piperRate(model) {
  try { return JSON.parse(fs.readFileSync(`${model}.json`, 'utf8')).audio?.sample_rate || 22050; } catch { return 22050; }
}

/** Text → 16 kHz mono s16le PCM. */
function synthesize(text, { bin = process.env.PIPER_BIN || 'piper', model = process.env.PIPER_MODEL } = {}) {
  return new Promise((resolve, reject) => {
    if (!model) return reject(new Error('PIPER_MODEL is not set'));
    const t0 = Date.now();
    const p = spawn(bin, ['--model', model, '--output_raw', '--quiet']);
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`piper exited ${code}: ${err.slice(-300)}`));
      resolve({ pcm: resample(Buffer.concat(chunks), piperRate(model)), ms: Date.now() - t0 });
    });
    p.stdin.end(String(text).replace(/\s+/g, ' '));
  });
}

/** Split a reply into sentences so the first one can start playing sooner. */
function sentences(text) {
  return String(text).match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) || [];
}

module.exports = { transcribe, synthesize, sentences };
