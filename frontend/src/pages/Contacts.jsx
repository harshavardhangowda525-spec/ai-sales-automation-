import { useState } from 'react';
import Icon from '../components/Icon';
import { useToast } from '../components/Toast';
import usePolling from '../lib/usePolling';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';

function ContactRow({ c, onChanged }) {
  const toast = useToast();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  async function call() {
    setBusy('call');
    try { await api(`/api/contacts/${c.id}/call`, { method: 'POST', body: { message: msg } }); toast(`Jarvis is calling ${c.name}`, 'success'); setMsg(''); onChanged(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(''); }
  }
  async function remove() {
    if (!window.confirm(`Remove ${c.name} from your contacts?`)) return;
    setBusy('del');
    try { await api(`/api/contacts/${c.id}`, { method: 'DELETE' }); onChanged(); } catch (err) { toast(err.message, 'error'); } finally { setBusy(''); }
  }
  return (
    <li className="rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-ink">{c.name} <span className="ml-1 text-sm font-normal text-muted">{c.phone}</span></p>
          {c.aliases && <p className="text-xs text-gray-500">Also: {c.aliases}</p>}
          {c.notes && <p className="mt-1 text-xs text-muted">{c.notes}</p>}
        </div>
        <button className="text-xs text-gray-500 hover:text-red-300" disabled={!!busy} onClick={remove}>Remove</button>
      </div>
      <div className="mt-3 flex gap-2">
        <input className="input" placeholder={`Message for ${c.name}, e.g. I'll be late today`} value={msg} onChange={(e) => setMsg(e.target.value)} />
        <button className="btn-primary" disabled={!msg.trim() || !!busy} onClick={call}><Icon name="phone" /> {busy === 'call' ? 'Calling…' : 'Call now'}</button>
      </div>
    </li>
  );
}

export default function Contacts() {
  const toast = useToast();
  const { data, reload } = usePolling(() => api('/api/contacts'), 10000);
  const [f, setF] = useState({ name: '', phone: '', aliases: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function add(e) {
    e.preventDefault();
    setBusy(true);
    try { await api('/api/contacts', { method: 'POST', body: f }); toast(`${f.name} added`, 'success'); setF({ name: '', phone: '', aliases: '', notes: '' }); reload(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl">Contacts</h1>
        <p className="text-sm">People Jarvis can call for you. Say "Jarvis, call my mom and tell her I'll be late today", and he calls, passes the message on, answers her questions, then WhatsApps you what she said.</p>
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="space-y-3 xl:col-span-2">
          {data?.contacts?.length ? <ul className="space-y-3">{data.contacts.map((c) => <ContactRow key={c.id} c={c} onChanged={reload} />)}</ul>
            : <div className="card p-8 text-center text-sm text-gray-500">No contacts yet. Add Mom, Dad, or anyone Jarvis should be able to call.</div>}
        </div>
        <div className="space-y-5">
          <form onSubmit={add} className="card space-y-3 p-5">
            <h2 className="text-base">Add a contact</h2>
            <input required className="input" placeholder="Name, e.g. Mom" value={f.name} onChange={set('name')} />
            <input required className="input" placeholder="Phone, e.g. 98450 12345" value={f.phone} onChange={set('phone')} />
            <input className="input" placeholder="Other names, e.g. amma, mother" value={f.aliases} onChange={set('aliases')} />
            <textarea rows={2} className="input" placeholder="Notes for Jarvis, e.g. Prefers Kannada" value={f.notes} onChange={set('notes')} />
            <button className="btn-primary w-full" disabled={busy}>{busy ? 'Adding…' : 'Add contact'}</button>
          </form>
          <div className="card p-5">
            <h2 className="mb-3 text-base">Recent calls</h2>
            {data?.recent_calls?.length ? (
              <ul className="space-y-3 text-sm">
                {data.recent_calls.map((r) => (
                  <li key={r.id} className="border-b border-line pb-2 last:border-0">
                    <p className="text-ink">{r.to_name} · <span className="text-xs text-muted">{r.status}</span></p>
                    <p className="text-xs text-gray-500">{fmtDateTime(r.created_at)}: "{r.message}"</p>
                    {r.summary && <p className="mt-1 whitespace-pre-line text-xs text-muted">{r.summary.replace(/^📞 /, '')}</p>}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-gray-500">No calls yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
