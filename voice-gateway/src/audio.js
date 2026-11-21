// Digital audio bridge (no microphone, no speaker): CallScoot's virtual PipeWire devices.
//   caller → HFP → callscoot.agent.rx (sink) → read .monitor   (16 kHz mono s16le, per CallScoot docs)
//   AI     → write callscoot.agent.tx (sink) → CallScoot → HFP → caller
// Plus: energy-based voice activity detection, real RMS levels for the dashboard, and barge-in.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const RATE = 16000;
const FRAME_MS = 20;
const FRAME_BYTES = (RATE * FRAME_MS / 1000) * 2;

function rms(buf) {
  let sum = 0;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2); sum += s * s; }
  return n ? Math.sqrt(sum / n) / 32768 : 0;
}

class AudioBridge extends EventEmitter {
  constructor({ rxDevice = 'callscoot.agent.rx.monitor', txDevice = 'callscoot.agent.tx', vadThreshold = 0.02, endSilenceMs = 600, minSpeechMs = 250, maxUtteranceMs = 15000 } = {}) {
    super();
    Object.assign(this, { rxDevice, txDevice, vadThreshold, endSilenceMs, minSpeechMs, maxUtteranceMs });
    this.rec = null;
    this.play = null;
    this.levels = { in: 0, out: 0 };
    this.speaking = false; // AI is playing audio
  }

  /** Start capturing caller audio; emits 'utterance' (Buffer PCM) when the caller finishes a phrase. */
  start() {
    if (this.rec) return;
    this.rec = spawn('pacat', ['--record', `--device=${this.rxDevice}`, `--rate=${RATE}`, '--channels=1', '--format=s16le', '--raw', '--latency-msec=20']);
    let pending = Buffer.alloc(0);
    let speech = [];
    let speechMs = 0;
    let silenceMs = 0;
    let inSpeech = false;
    this.rec.stdout.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= FRAME_BYTES) {
        const frame = pending.subarray(0, FRAME_BYTES);
        pending = pending.subarray(FRAME_BYTES);
        const level = rms(frame);
        this.levels.in = level;
        const voiced = level > this.vadThreshold;
        if (voiced) {
          if (!inSpeech) { inSpeech = true; this.emit('speech-start', { at: Date.now() }); }
          if (this.speaking) this.bargeIn(); // caller interrupts the AI
          silenceMs = 0;
        } else if (inSpeech) silenceMs += FRAME_MS;
        if (inSpeech) { speech.push(Buffer.from(frame)); speechMs += FRAME_MS; }
        if (inSpeech && (silenceMs >= this.endSilenceMs || speechMs >= this.maxUtteranceMs)) {
          const pcm = Buffer.concat(speech);
          const voicedMs = speechMs - silenceMs;
          inSpeech = false; speech = []; speechMs = 0; silenceMs = 0;
          if (voicedMs >= this.minSpeechMs) this.emit('utterance', pcm, { endpointAt: Date.now(), ms: voicedMs });
        }
      }
    });
    this.rec.on('error', (err) => { this.rec = null; this.emit('error-text', `capture failed: ${err.message}`); });
    this.rec.on('exit', (code) => { this.rec = null; this.emit('rx-closed', code); });
    this.rec.stderr.on('data', (d) => this.emit('error-text', String(d)));
  }

  /** Play 16 kHz mono s16le PCM to the caller. Resolves when done or interrupted. */
  playPcm(pcm) {
    this.stopPlayback();
    return new Promise((resolve) => {
      this.speaking = true;
      const p = spawn('pacat', ['--playback', `--device=${this.txDevice}`, `--rate=${RATE}`, '--channels=1', '--format=s16le', '--raw']);
      this.play = p;
      const meter = setInterval(() => { this.levels.out = this.speaking ? 0.2 : 0; }, 100);
      p.on('exit', () => { clearInterval(meter); if (this.play === p) this.play = null; this.speaking = false; this.levels.out = 0; resolve(); });
      p.stdin.on('error', () => {});
      p.on('error', (err) => { this.emit('error-text', `playback failed: ${err.message}`); });
      p.stdin.end(pcm);
    });
  }

  bargeIn() {
    this.emit('barge-in', { at: Date.now() });
    this.stopPlayback();
  }

  stopPlayback() {
    if (this.play) { try { this.play.kill('SIGTERM'); } catch { /* gone */ } this.play = null; }
    this.speaking = false;
  }

  stop() {
    this.stopPlayback();
    if (this.rec) { try { this.rec.kill('SIGTERM'); } catch { /* gone */ } this.rec = null; }
  }
}

/** 16-bit PCM → WAV (for whisper.cpp server). */
function wav(pcm, rate = RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Linear resampler (mono s16le) — e.g. Piper 22.05 kHz → 16 kHz. */
function resample(pcm, from, to = RATE) {
  if (from === to) return pcm;
  const inN = pcm.length >> 1;
  const outN = Math.floor(inN * to / from);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const x = i * from / to;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, inN - 1);
    const f = x - i0;
    const s = pcm.readInt16LE(i0 * 2) * (1 - f) + pcm.readInt16LE(i1 * 2) * f;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  return out;
}

module.exports = { AudioBridge, wav, resample, rms, RATE };
