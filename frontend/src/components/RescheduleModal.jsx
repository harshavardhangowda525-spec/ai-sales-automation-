import { useState } from 'react';
import { api } from '../lib/api';
import { useToast } from './Toast';

/** Default to tomorrow 10:00 in local (IST) time. */
function defaultValue() {
  const d = new Date(Date.now() + 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`;
}

export default function RescheduleModal({ client, onClose, onDone }) {
  const [when, setWhen] = useState(defaultValue());
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      // The datetime-local value is interpreted as IST wall-clock time.
      await api(`/api/clients/${client.id}/reschedule`, { method: 'POST', body: { start_time: `${when}:00+05:30`, notify } });
      toast(`Meeting for ${client.business_name} rescheduled`, 'success');
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
        <h3 className="text-lg">Reschedule consultation</h3>
        <p className="mt-1 text-sm">{client.business_name}</p>
        <label className="label mt-5 block" htmlFor="when">New date & time (IST)</label>
        <input id="when" type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} className="input mt-1.5 [color-scheme:dark]" />
        <label className="mt-4 flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="h-4 w-4 accent-blue-500" />
          Send updated proposal + Meet link on WhatsApp
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" disabled={busy} className="btn-primary">{busy ? 'Saving…' : 'Reschedule'}</button>
        </div>
      </form>
    </div>
  );
}
