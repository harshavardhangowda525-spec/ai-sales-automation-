import { useState } from 'react';
import { api } from '../lib/api';
import { useToast } from './Toast';

export default function WebsiteReadyModal({ client, onClose, onDone }) {
  const [url, setUrl] = useState(client.website_url || 'https://');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api(`/api/clients/${client.id}/website-ready`, { method: 'POST', body: { website_url: url.trim() } });
      toast(r.owner_call?.status === 'NEEDS_MANUAL'
        ? 'Saved — calling isn\'t set up yet, approve it on this page'
        : 'Saved — you\'ll get a call to confirm before the client is sent the link', 'success');
      onDone?.();
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card w-full max-w-md p-6">
        <h3 className="text-lg">Website ready</h3>
        <p className="mt-1 text-sm">{client.business_name}</p>
        <label className="label mt-5 block" htmlFor="site">Live website link</label>
        <input id="site" type="url" required className="input mt-1.5" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://clientsite.com" />
        <p className="mt-2 text-xs text-gray-500">Your assistant will call you to confirm. When you say yes, the client gets this link on WhatsApp.</p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" disabled={busy} className="btn-primary">{busy ? 'Saving…' : 'Mark ready'}</button>
        </div>
      </form>
    </div>
  );
}
