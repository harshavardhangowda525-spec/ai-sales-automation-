// Hardware-free tests for the gateway's audio helpers and speech detection.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const child = require('child_process');
const { wav, resample, rms, RATE } = require('../src/audio');

function tone(ms, amp, rate = RATE) {
  const n = Math.round(rate * ms / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 300 * i / rate) * amp * 32767), i * 2);
  return b;
}

test('wav header is valid 16 kHz mono PCM', () => {
  const w = wav(Buffer.alloc(3200));
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.readUInt16LE(22), 1);
  assert.equal(w.readUInt32LE(40), 3200);
});

test('resample 22050 → 16000 keeps duration', () => {
  const out = resample(tone(1000, 0.5, 22050), 22050, 16000);
  assert.equal(out.length / 2, 16000);
  assert.ok(Math.abs(rms(out) - 0.5 / Math.SQRT2) < 0.02);
});

test('VAD emits one utterance for speech followed by silence', async () => {
  // Fake `pacat --record` so AudioBridge can be driven without PipeWire.
  const fake = new EventEmitter();
  fake.stdout = new EventEmitter();
  fake.stderr = new EventEmitter();
  fake.kill = () => {};
  const orig = child.spawn;
  child.spawn = () => fake;
  delete require.cache[require.resolve('../src/audio')];
  const { AudioBridge } = require('../src/audio');
  const b = new AudioBridge({ endSilenceMs: 400, minSpeechMs: 200 });
  const got = [];
  b.on('utterance', (pcm, meta) => got.push(meta));
  b.start();
  fake.stdout.emit('data', tone(100, 0.001));   // quiet
  fake.stdout.emit('data', tone(800, 0.3));     // speech
  fake.stdout.emit('data', tone(600, 0.001));   // silence → end of utterance
  child.spawn = orig;
  assert.equal(got.length, 1);
  assert.ok(got[0].ms >= 700 && got[0].ms <= 900, `voiced ms ${got[0].ms}`);
});
