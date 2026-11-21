#!/usr/bin/env node
// Infinity Voice hardware self-test (Phase 5). The ONLY place capabilities become VERIFIED / FAILED.
//   node src/selftest.js status                          → what is detected right now (no calls)
//   node src/selftest.js call <number> --consent         → real test call to a consenting person
//   node src/selftest.js answer                          → waits for you to ring the phone, answers it
// Real calls happen only with an explicit command + --consent. Nothing runs automatically.
const readline = require('readline');
const fs = require('fs');
const path = require('path');
try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch { /* no .env */ }
const { BluetoothTelephonyGateway } = require('./telephony');
const { AudioBridge, rms } = require('./audio');
const { synthesize } = require('./speech');
const caps = require('./capabilities');

const tel = new BluetoothTelephonyGateway({ callscootUrl: process.env.CALLSCOOT_API_BASE || 'http://127.0.0.1:8788', callscootToken: process.env.CALLSCOOT_API_TOKEN || '' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (q) => new Promise((res) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); res(a.trim().toLowerCase()); }); });

async function waitState(want, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const calls = await tel.getCalls().catch(() => []);
    const c = calls.find((x) => want.includes(x.state));
    if (c) return c;
    await sleep(500);
  }
  return null;
}

async function status() {
  const d = await tel.discover();
  console.log('Telephony backend:', d.backend || 'NONE', d.ag || '');
  if (d.backend === 'pipewire') caps.set('bluetooth', 'VERIFIED', `PipeWire telephony audio gateway ${d.ag}`);
  console.log(JSON.stringify(caps.load().states, null, 2));
  console.log('Capabilities file:', caps.FILE);
}

/** Measure caller audio + play a test phrase over the live call. */
async function audioCheck(label) {
  const bridge = new AudioBridge({ rxDevice: process.env.CALLSCOOT_RX || 'callscoot.agent.rx.monitor', txDevice: process.env.CALLSCOOT_TX || 'callscoot.agent.tx' });
  let peak = 0;
  const { spawn } = require('child_process');
  const rec = spawn('pacat', ['--record', `--device=${bridge.rxDevice}`, '--rate=16000', '--channels=1', '--format=s16le', '--raw']);
  rec.stdout.on('data', (d) => { peak = Math.max(peak, rms(d)); });
  console.log(`[${label}] Ask the other person to speak for 6 seconds now…`);
  await sleep(6000);
  rec.kill();
  console.log(`[${label}] Peak caller level: ${peak.toFixed(3)}`);
  caps.set('incoming_audio', peak > 0.02 ? 'VERIFIED' : 'FAILED', `peak RMS ${peak.toFixed(3)} from ${bridge.rxDevice}`);
  console.log(`[${label}] Playing a test phrase to the caller (digital, no speaker)…`);
  try {
    const t = await synthesize('This is a test from Infinity Web and Apps. If you can hear me, please say yes.');
    await bridge.playPcm(t.pcm);
  } catch (err) {
    console.log('TTS failed:', err.message);
  }
  const heard = await ask(`[${label}] Did the other person clearly hear the test phrase? (y/n) `);
  caps.set('outgoing_audio', heard === 'y' ? 'VERIFIED' : 'FAILED', heard === 'y' ? `heard on ${bridge.txDevice}` : 'not heard');
}

async function testCall(number) {
  await tel.discover();
  if (!tel.backend) { console.log('No telephony backend. Pair/connect the phone (HFP) and start CallScoot first.'); process.exit(1); }
  caps.set('bluetooth', 'VERIFIED', `backend ${tel.backend}`);
  console.log(`Dialling ${number} via ${tel.backend}…`);
  const t0 = Date.now();
  try { await tel.dial(number); } catch (err) { caps.set('call_initiation', 'FAILED', err.message); console.log('Dial failed:', err.message); process.exit(1); }
  const active = await waitState(['active'], 45000);
  if (!active) { caps.set('call_initiation', 'FAILED', 'call never became active within 45 s'); console.log('Call did not connect.'); await tel.hangup().catch(() => {}); process.exit(1); }
  caps.set('call_initiation', 'VERIFIED', `connected in ${Date.now() - t0} ms`);
  caps.set('hfp', 'VERIFIED', 'call became active over the Bluetooth audio gateway');
  await audioCheck('outbound');
  await tel.hangup(active.path).catch((e) => console.log('hangup error', e.message));
  const gone = !(await waitState(['active', 'alerting', 'dialing'], 3000));
  console.log(gone ? 'Hung up cleanly.' : 'Call still present after hangup!');
  console.log(JSON.stringify(caps.load().states, null, 2));
}

async function testAnswer() {
  await tel.discover();
  if (!tel.backend) { console.log('No telephony backend.'); process.exit(1); }
  console.log('Ring the phone now from another number (waiting 60 s)…');
  const inc = await waitState(['incoming'], 60000);
  if (!inc) { console.log('No incoming call seen.'); caps.set('call_answering', 'FAILED', 'no incoming call state observed'); process.exit(1); }
  try { await tel.answer(inc.path); } catch (err) { caps.set('call_answering', 'FAILED', err.message); console.log('Answer failed:', err.message); process.exit(1); }
  const active = await waitState(['active'], 10000);
  caps.set('call_answering', active ? 'VERIFIED' : 'FAILED', active ? 'answered without touching the phone' : 'did not become active');
  if (active) await audioCheck('inbound');
  await tel.hangup(active?.path).catch(() => {});
  console.log(JSON.stringify(caps.load().states, null, 2));
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'status') return status();
  if (cmd === 'call') {
    if (!arg || !process.argv.includes('--consent')) { console.log('Usage: node src/selftest.js call +91XXXXXXXXXX --consent   (only a person who agreed to a test call)'); process.exit(1); }
    return testCall(arg);
  }
  if (cmd === 'answer') return testAnswer();
  console.log('Usage: node src/selftest.js status | call <number> --consent | answer');
})().catch((e) => { console.error(e); process.exit(1); });
