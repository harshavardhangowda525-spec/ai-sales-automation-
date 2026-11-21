#!/usr/bin/env node
// Infinity Voice local gateway — runs on the Linux machine paired with the phone.
//   • polls the Infinity backend for commands (the cloud never connects into this machine)
//   • watches phone call states (PipeWire telephony / CallScoot) and reports them
//   • on a live call: caller audio → whisper.cpp → backend AI turn → Piper → caller
// Start:  node src/gateway.js     (config in voice-gateway/.env — see SETUP_GUIDE.md)
const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dependency).
try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch { /* no .env */ }

const { BluetoothTelephonyGateway } = require('./telephony');
const { AudioBridge } = require('./audio');
const { transcribe, synthesize, sentences } = require('./speech');
const caps = require('./capabilities');

const API = (process.env.INFINITY_API_URL || '').replace(/\/$/, '');
const TOKEN = process.env.VOICE_GATEWAY_TOKEN || '';
const POLL_MS = Number(process.env.POLL_MS || 2000);
if (!API || !TOKEN) { console.error('Set INFINITY_API_URL and VOICE_GATEWAY_TOKEN in voice-gateway/.env'); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString(), ...a);
const tel = new BluetoothTelephonyGateway({ callscootUrl: process.env.CALLSCOOT_API_BASE || 'http://127.0.0.1:8788', callscootToken: process.env.CALLSCOOT_API_TOKEN || '' });

async function api(method, p, body) {
  const res = await fetch(`${API}${p}`, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p} → ${res.status} ${j.error || ''}`);
  return j;
}

// ── Live call state ──
const state = {
  calls: new Map(),          // phone call path → { state, number }
  active: null,              // { callId, path, bridge, busy, ending }
  pendingCallId: null,       // cloud call id we just dialled
  lastDiscover: 0,
  backend: null,
  stats: { turns: 0, last_turn_ms: null, last_stt_ms: null, last_tts_ms: null, errors: 0 },
  emergency: false,
};

async function speak(text) {
  const a = state.active;
  if (!a) return;
  for (const s of sentences(text)) {
    if (!state.active || state.active !== a || a.interrupted) break;
    const t = await synthesize(s);
    state.stats.last_tts_ms = t.ms;
    await a.bridge.playPcm(t.pcm);
  }
}

function startConversation(callId, callPath, greeting) {
  const bridge = new AudioBridge({
    rxDevice: process.env.CALLSCOOT_RX || 'callscoot.agent.rx.monitor',
    txDevice: process.env.CALLSCOOT_TX || 'callscoot.agent.tx',
    vadThreshold: Number(process.env.VAD_THRESHOLD || 0.02),
  });
  const a = { callId, path: callPath, bridge, busy: false, ending: false, interrupted: false };
  state.active = a;
  bridge.on('error-text', (t) => { state.stats.errors += 1; state.stats.last_audio_error = String(t).slice(0, 200); log(`[${callId}] audio: ${t}`); });
  bridge.on('barge-in', () => { a.interrupted = true; });
  bridge.on('speech-start', () => { a.interrupted = false; });
  bridge.on('utterance', async (pcm, meta) => {
    if (a.busy || a.ending) return; // one turn at a time
    a.busy = true;
    try {
      const stt = await transcribe(pcm);
      state.stats.last_stt_ms = stt.ms;
      if (!stt.text) return;
      log(`[${callId}] customer: ${stt.text}`);
      const r = await api('POST', `/voice-gateway/calls/${callId}/turn`, { text: stt.text });
      state.stats.turns += 1;
      state.stats.last_turn_ms = Date.now() - meta.endpointAt; // speech end → reply text ready
      log(`[${callId}] agent (${state.stats.last_turn_ms} ms): ${r.reply}`);
      a.interrupted = false;
      await speak(r.reply);
      if (r.end_call) a.ending = true; // the backend also queues HANGUP(after_speaking)
    } catch (err) {
      state.stats.errors += 1;
      log(`[${callId}] turn error: ${err.message}`);
    } finally {
      a.busy = false;
    }
  });
  bridge.start();
  speak(greeting).catch((e) => log('greeting failed:', e.message));
}

function endConversation() {
  if (state.active) { state.active.bridge.stop(); state.active = null; }
}

// ── Commands from the backend ──
async function runCommand(c) {
  log('command', c.command, c.call_id || '');
  try {
    if (state.emergency && c.command !== 'HANGUP') throw new Error('emergency stop is on');
    if (c.command === 'DIAL') {
      if (state.active || [...state.calls.values()].some((x) => x.state !== 'disconnected')) throw new Error('line busy');
      state.pendingCallId = c.call_id;
      await tel.dial(c.payload.number);
    } else if (c.command === 'ANSWER') {
      const incoming = [...state.calls.entries()].find(([, x]) => x.state === 'incoming');
      if (!incoming) throw new Error('no incoming call to answer');
      state.pendingCallId = c.call_id;
      await tel.answer(incoming[0]);
    } else if (c.command === 'HANGUP' || c.command === 'REJECT') {
      if (c.payload?.after_speaking && state.active) {
        const t0 = Date.now();
        while (state.active && (state.active.bridge.speaking || state.active.busy) && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200));
      }
      const live = [...state.calls.entries()].find(([, x]) => x.state !== 'disconnected');
      await tel.hangup(live?.[0]);
    }
    await api('POST', `/voice-gateway/commands/${c.id}/result`, { ok: true });
  } catch (err) {
    log('command failed', c.command, err.message);
    await api('POST', `/voice-gateway/commands/${c.id}/result`, { ok: false, error: err.message }).catch(() => {});
  }
}

// ── Phone state → events ──
async function pollPhone() {
  if (Date.now() - state.lastDiscover > 30000 || !tel.backend) {
    state.lastDiscover = Date.now();
    const d = await tel.discover();
    if (d.backend !== state.backend) log('telephony backend:', d.backend || 'none', d.ag || '');
    state.backend = d.backend;
  }
  if (!tel.backend) return;
  let calls = [];
  try { calls = await tel.getCalls(); } catch (err) { log('getCalls failed:', err.message); return; }
  const seen = new Set();
  for (const c of calls) {
    seen.add(c.path);
    const prev = state.calls.get(c.path);
    if (prev?.state === c.state) continue;
    state.calls.set(c.path, { state: c.state, number: c.number });
    await onPhoneState(c.path, c.state, c.number);
  }
  for (const [p, prev] of state.calls) {
    if (!seen.has(p) && prev.state !== 'disconnected') {
      state.calls.set(p, { ...prev, state: 'disconnected' });
      await onPhoneState(p, 'disconnected', prev.number);
    }
    if (!seen.has(p)) state.calls.delete(p);
  }
}

async function onPhoneState(callPath, phoneState, number) {
  log('phone', callPath, phoneState, number || '');
  const callId = state.active?.path === callPath ? state.active.callId : state.pendingCallId;
  if (phoneState === 'incoming') {
    const r = await api('POST', '/voice-gateway/events', { type: 'incoming', number });
    if (r.action === 'answer') state.pendingCallId = r.call_id;
    return;
  }
  if (['dialing', 'alerting', 'active', 'disconnected'].includes(phoneState) && callId) {
    const r = await api('POST', '/voice-gateway/events', { type: phoneState, call_id: callId, number });
    if (phoneState === 'active' && r.action === 'speak') { state.pendingCallId = null; startConversation(r.call_id, callPath, r.greeting); }
    if (phoneState === 'disconnected') { if (state.active?.path === callPath || state.active?.callId === callId) endConversation(); state.pendingCallId = null; }
  }
}

// ── Heartbeat loop ──
async function loop() {
  try {
    await pollPhone();
    const { states } = caps.load();
    const hb = await api('POST', '/voice-gateway/heartbeat', {
      status: {
        backend: state.backend,
        capabilities: states,
        health: {
          call_active: Boolean(state.active) || [...state.calls.values()].some((c) => c.state !== 'disconnected'),
          levels: state.active ? state.active.bridge.levels : { in: 0, out: 0 },
          ...state.stats,
          hostname: require('os').hostname(),
          uptime_s: Math.round(process.uptime()),
        },
      },
    });
    state.emergency = Boolean(hb.config?.emergency_stop);
    for (const c of hb.commands || []) await runCommand(c);
  } catch (err) {
    log('loop error:', err.message);
  }
  setTimeout(loop, POLL_MS);
}

process.on('SIGINT', () => { endConversation(); process.exit(0); });
process.on('SIGTERM', () => { endConversation(); process.exit(0); });
log(`Infinity Voice gateway → ${API} (poll ${POLL_MS} ms)`);
loop();
