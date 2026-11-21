// BluetoothTelephonyGateway — call control for the POCO C55 over Bluetooth HFP.
// Primary: PipeWire's org.pipewire.Telephony D-Bus service (documented in PipeWire's
// spa/plugins/bluez5/README-Telephony.md), driven through `busctl --user` (no native deps).
// Fallback: CallScoot's local HTTP API (127.0.0.1:8788), whose outbound path uses ADB for dialing.
// Neither carries audio: audio flows over HFP → PipeWire → CallScoot virtual devices (see audio.js).
const { execFile } = require('child_process');

const SERVICE = 'org.pipewire.Telephony';
const ROOT = '/org/pipewire/Telephony';

function busctl(args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile('busctl', ['--user', '--json=short', ...args], { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : null); } catch { resolve(stdout); }
    });
  });
}

class BluetoothTelephonyGateway {
  constructor({ callscootUrl = 'http://127.0.0.1:8788', callscootToken = '' } = {}) {
    this.callscootUrl = callscootUrl;
    this.callscootToken = callscootToken;
    this.backend = null; // 'pipewire' | 'callscoot' | null
    this.agPath = null;
  }

  /** Find the audio gateway (the phone) on PipeWire telephony; else check CallScoot. */
  async discover() {
    try {
      const r = await busctl(['call', SERVICE, ROOT, 'org.ofono.Manager', 'GetModems']);
      // busctl JSON: { type: "a(oa{sv})", data: [[ [path, {props}] , ... ]] }
      const modems = r?.data?.[0] || [];
      if (modems.length) {
        this.agPath = modems[0][0];
        this.backend = 'pipewire';
        return { backend: this.backend, ag: this.agPath, props: modems[0][1] };
      }
    } catch { /* service not present */ }
    try {
      const res = await fetch(`${this.callscootUrl}/v1/health`, { signal: AbortSignal.timeout(2000), headers: this.#csHeaders() });
      if (res.ok) { this.backend = 'callscoot'; return { backend: this.backend }; }
    } catch { /* not running */ }
    this.backend = null;
    this.agPath = null;
    return { backend: null };
  }

  #csHeaders() {
    return { 'Content-Type': 'application/json', ...(this.callscootToken ? { Authorization: `Bearer ${this.callscootToken}` } : {}) };
  }

  async #cs(method, path, body) {
    const res = await fetch(`${this.callscootUrl}${path}`, { method, headers: this.#csHeaders(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`CallScoot ${path} → ${res.status} ${JSON.stringify(j).slice(0, 200)}`);
    return j;
  }

  /** Current calls: [{ path, number, state }] — state: incoming|dialing|alerting|active|held|waiting|disconnected */
  async getCalls() {
    if (this.backend === 'pipewire') {
      const r = await busctl(['call', SERVICE, this.agPath, 'org.ofono.VoiceCallManager', 'GetCalls']);
      return (r?.data?.[0] || []).map(([path, props]) => ({
        path,
        number: props?.LineIdentification?.data || '',
        state: props?.State?.data || 'unknown',
      }));
    }
    if (this.backend === 'callscoot') {
      const j = await this.#cs('GET', '/v1/current-call').catch(() => null);
      const c = j?.call || j?.current_call || (j && j.state ? j : null);
      return c ? [{ path: 'callscoot', number: c.number || c.remote_number || '', state: String(c.state || 'active').toLowerCase() }] : [];
    }
    return [];
  }

  async dial(number) {
    if (!/^\+?[0-9]{10,15}$/.test(number)) throw new Error('Refusing to dial an invalid number');
    if (this.backend === 'pipewire') return busctl(['call', SERVICE, this.agPath, 'org.pipewire.Telephony.AudioGateway1', 'Dial', 's', number]);
    if (this.backend === 'callscoot') return this.#cs('POST', '/v1/outbound-calls', { number });
    throw new Error('No telephony backend (phone not connected over HFP?)');
  }

  async answer(callPath) {
    if (this.backend === 'pipewire') return busctl(['call', SERVICE, callPath, 'org.pipewire.Telephony.Call1', 'Answer']);
    if (this.backend === 'callscoot') return this.#cs('POST', '/v1/current-call/answer');
    throw new Error('No telephony backend');
  }

  async hangup(callPath) {
    if (this.backend === 'pipewire') {
      if (callPath) return busctl(['call', SERVICE, callPath, 'org.pipewire.Telephony.Call1', 'Hangup']);
      return busctl(['call', SERVICE, this.agPath, 'org.pipewire.Telephony.AudioGateway1', 'HangupAll']);
    }
    if (this.backend === 'callscoot') return this.#cs('POST', '/v1/current-call/hangup');
    throw new Error('No telephony backend');
  }
}

module.exports = { BluetoothTelephonyGateway, busctl };
