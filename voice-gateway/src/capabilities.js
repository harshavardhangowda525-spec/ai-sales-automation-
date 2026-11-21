// Capability states, persisted locally. Only selftest.js may set VERIFIED/FAILED — never assumed.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = process.env.VOICE_CAPABILITIES_FILE || path.join(os.homedir(), '.config', 'infinity-voice', 'capabilities.json');
const KEYS = ['bluetooth', 'hfp', 'incoming_audio', 'outgoing_audio', 'call_initiation', 'call_answering', 'autonomous'];

function load() {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { d = {}; }
  const out = {};
  for (const k of KEYS) out[k] = d[k]?.state || 'UNKNOWN';
  return { states: out, evidence: d };
}

function set(key, state, evidence) {
  if (!KEYS.includes(key) || !['VERIFIED', 'FAILED', 'UNKNOWN'].includes(state)) throw new Error('bad capability');
  let d = {};
  try { d = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { d = {}; }
  d[key] = { state, evidence, at: new Date().toISOString() };
  const core = ['bluetooth', 'hfp', 'incoming_audio', 'outgoing_audio', 'call_initiation', 'call_answering'];
  d.autonomous = core.every((k) => d[k]?.state === 'VERIFIED')
    ? { state: 'VERIFIED', evidence: 'all core capabilities verified on this phone', at: new Date().toISOString() }
    : { state: core.some((k) => d[k]?.state === 'FAILED') ? 'FAILED' : 'UNKNOWN', evidence: 'needs every core capability verified' };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2));
}

module.exports = { load, set, KEYS, FILE };
