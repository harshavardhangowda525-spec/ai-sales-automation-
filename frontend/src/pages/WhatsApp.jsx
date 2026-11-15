import { useEffect, useState } from 'react';
import Icon from '../components/Icon';
import { useToast } from '../components/Toast';
import usePolling from '../lib/usePolling';
import { api } from '../lib/api';

const LABEL = {
  connected: ['Linked', 'bg-emerald-500/15 text-emerald-300'],
  qr: ['Waiting for scan', 'bg-amber-500/15 text-amber-300'],
  connecting: ['Connecting…', 'bg-blue-500/15 text-blue-300'],
  disconnected: ['Not linked', 'bg-gray-500/15 text-gray-300'],
  logged_out: ['Not linked', 'bg-gray-500/15 text-gray-300'],
};

export default function WhatsApp() {
  const toast = useToast();
  const [linking, setLinking] = useState(false);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const fast = linking; // poll quickly while a QR is on screen
  const { data, reload } = usePolling(() => api('/api/whatsapp'), fast ? 2500 : 10000, [fast]);
  const status = data?.status || 'disconnected';
  useEffect(() => { if (status === 'connected') { setLinking(false); setCode(''); } }, [status]);

  async function act(name, fn, msg) {
    setBusy(name);
    try { await fn(); if (msg) toast(msg, 'success'); await reload(); } catch (err) { toast(err.message, 'error'); } finally { setBusy(''); }
  }
  const [label, cls] = LABEL[status] || LABEL.disconnected;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl">WhatsApp</h1>
        <p className="text-sm">Link your own WhatsApp once — then proposals, meeting links and website links go to clients automatically from your number.</p>
      </div>

      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${cls}`}>{label}</span>
            {data?.linked_number && <span className="text-sm text-ink">{data.linked_number}</span>}
          </div>
          {status === 'connected' ? (
            <div className="flex gap-2">
              <button className="btn-ghost" disabled={!!busy} onClick={() => act('test', () => api('/api/whatsapp/test', { method: 'POST', body: {} }), 'Test message sent to your own number')}>
                {busy === 'test' ? 'Sending…' : 'Send me a test'}
              </button>
              <button className="btn-ghost" disabled={!!busy} onClick={() => window.confirm('Unlink your WhatsApp from the dashboard?') && act('unlink', () => api('/api/whatsapp/unlink', { method: 'POST' }), 'Unlinked')}>Unlink</button>
            </div>
          ) : (
            <button className="btn-primary" disabled={!!busy} onClick={() => act('link', async () => { setLinking(true); await api('/api/whatsapp/link', { method: 'POST' }); })}>
              <Icon name="phone" /> Link my WhatsApp
            </button>
          )}
        </div>

        {status !== 'connected' && linking && (
          <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
            <div>
              <h2 className="text-base">Scan the QR code</h2>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                <li>On your phone open <b className="text-ink">WhatsApp</b> → <b className="text-ink">⋮ / Settings</b> → <b className="text-ink">Linked devices</b>.</li>
                <li>Tap <b className="text-ink">Link a device</b> and scan this code.</li>
              </ol>
              <div className="mt-4 grid h-[300px] w-[300px] max-w-full place-items-center rounded-xl bg-white p-2">
                {data?.qr ? <img src={data.qr} alt="WhatsApp link QR code" className="h-full w-full" /> : <span className="text-sm text-gray-500">Generating QR…</span>}
              </div>
              <p className="mt-2 text-xs text-gray-500">The code refreshes every ~20 seconds.</p>
            </div>
            <div>
              <h2 className="text-base">Or use a pairing code</h2>
              <p className="mt-2 text-sm">Handy when you're on the same phone. In <b className="text-ink">Link a device</b>, tap <b className="text-ink">Link with phone number instead</b> and type the code shown here.</p>
              <div className="mt-3 flex gap-2">
                <input className="input" placeholder="Your WhatsApp number, e.g. 916360471652" value={phone} onChange={(e) => setPhone(e.target.value)} />
                <button className="btn-ghost" disabled={!phone || !!busy} onClick={() => act('pair', async () => setCode((await api('/api/whatsapp/pair', { method: 'POST', body: { phone } })).code))}>
                  {busy === 'pair' ? '…' : 'Get code'}
                </button>
              </div>
              {code && <p className="mt-4 font-mono text-3xl font-bold tracking-widest text-ink">{code}</p>}
            </div>
          </div>
        )}
      </div>

      <div className="card p-5 text-sm">
        <h2 className="mb-2 text-base">What happens once linked</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>When you approve a quotation (on Jarvis's call or in the dashboard), the client gets the proposal + meeting link from your WhatsApp.</li>
          <li>When you approve a finished website, the client gets the website link.</li>
          <li><b className="text-ink">Send on WhatsApp</b> on a client page sends instantly — no tapping.</li>
          <li>Only clients who booked are messaged, one message per event. A short "typing…" pause is added before each message.</li>
        </ul>
        <p className="mt-3 text-xs text-amber-300/90">This uses WhatsApp's linked-devices feature through an unofficial connection. WhatsApp may restrict numbers it sees automating messages — keep volumes low and personal.</p>
      </div>
    </div>
  );
}
