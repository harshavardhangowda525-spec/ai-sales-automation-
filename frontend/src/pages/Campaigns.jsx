import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../components/Badge';
import Icon from '../components/Icon';
import { useToast } from '../components/Toast';
import usePolling from '../lib/usePolling';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';

function parseContacts(text) {
  return text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [phone, ...rest] = line.split(/[,\t]/);
    return { phone_number: phone.trim(), business_name: rest.join(',').trim() };
  }).filter((c) => /\d{10}/.test(c.phone_number.replace(/\D/g, '')));
}

function NewCampaign({ onClose, onCreated }) {
  const [form, setForm] = useState({ engine: 'sarvam', campaign_name: '', agent_id: '', cohort_id: '', total_calls: '', contacts: '' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const contacts = parseContacts(form.contacts);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const voice = form.engine === 'infinity_voice';

  async function submit(e) {
    e.preventDefault();
    if (voice && !contacts.length) { toast('Add the leads to call', 'error'); return; }
    setBusy(true);
    try {
      if (voice) {
        const r = await api('/api/campaign/start', { method: 'POST', body: { engine: 'infinity_voice', campaign_name: form.campaign_name, contacts } });
        toast(`Cold-call campaign queued on your line: ${r.added} leads${r.skipped?.length ? `, ${r.skipped.length} skipped (do-not-call)` : ''}`, 'success');
        onCreated();
        onClose();
        return;
      }
      const r = await api('/api/campaign/start', {
        method: 'POST',
        body: {
          campaign_name: form.campaign_name,
          agent_id: form.agent_id || undefined,
          cohort_id: form.cohort_id || undefined,
          total_calls: contacts.length ? undefined : Number(form.total_calls) || undefined,
          contacts: contacts.length ? contacts : undefined,
        },
      });
      toast(r.mock ? 'Campaign created (Sarvam not configured — test mode)' : 'Campaign started on Sarvam', 'success');
      onCreated();
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-center overflow-y-auto bg-black/60 p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card w-full max-w-lg space-y-4 p-6">
        <h3 className="text-lg">Start new campaign</h3>
        <div>
          <label className="label" htmlFor="cn">Campaign name</label>
          <input id="cn" required className="input mt-1.5" placeholder="Jayanagar restaurants – Nov" value={form.campaign_name} onChange={set('campaign_name')} />
        </div>
        <fieldset>
          <legend className="label">Who makes the calls</legend>
          <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[['sarvam', 'Sarvam AI', 'Sarvam number and agent'], ['infinity_voice', 'Infinity Voice', 'Cold calls from your own phone line']].map(([v, t, d]) => (
              <label key={v} className={`cursor-pointer rounded-lg border p-3 text-sm ${form.engine === v ? 'border-primary bg-primary/10' : 'border-line'}`}>
                <input type="radio" name="engine" value={v} checked={form.engine === v} onChange={set('engine')} className="sr-only" />
                <span className="block font-semibold text-ink">{t}</span>
                <span className="block text-xs text-gray-500">{d}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {!voice && <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="ag">Sarvam agent ID</label>
            <input id="ag" className="input mt-1.5" placeholder="default from server" value={form.agent_id} onChange={set('agent_id')} />
          </div>
          <div>
            <label className="label" htmlFor="co">Cohort name / ID</label>
            <input id="co" className="input mt-1.5" placeholder="optional" value={form.cohort_id} onChange={set('cohort_id')} />
          </div>}
        </div>}
        <div>
          <label className="label" htmlFor="ct">Leads — one per line: phone, business name</label>
          <textarea id="ct" rows={6} className="input mt-1.5 font-mono text-xs" placeholder={'9845012345, Sri Lakshmi Sweets\n9900112233, GreenLeaf Dental Clinic'} value={form.contacts} onChange={set('contacts')} />
          <p className="mt-1 text-xs text-gray-500">{contacts.length} valid lead{contacts.length === 1 ? '' : 's'} — {voice ? 'called one at a time by your Sales agent, within calling hours. Do-not-call numbers are skipped.' : 'these are uploaded to Sarvam as the campaign cohort.'}</p>
        </div>
        {!contacts.length && !voice && (
          <div>
            <label className="label" htmlFor="tc">Expected number of calls (if leads are uploaded in Sarvam)</label>
            <input id="tc" type="number" min="0" className="input mt-1.5" placeholder="e.g. 50" value={form.total_calls} onChange={set('total_calls')} />
            <p className="mt-1 text-xs text-gray-500">Used to detect when the campaign is finished and trigger your summary call.</p>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}><Icon name="play" className="h-3.5 w-3.5" /> {busy ? 'Starting…' : 'Start campaign'}</button>
        </div>
      </form>
    </div>
  );
}

export default function Campaigns() {
  const { data, error, loading, reload } = usePolling(() => api('/api/campaigns'), 8000);
  const [open, setOpen] = useState(false);
  const [completing, setCompleting] = useState(null);
  const toast = useToast();

  async function complete(c) {
    if (!window.confirm(`Mark "${c.name}" complete and place your summary call now?`)) return;
    setCompleting(c.id);
    try {
      const r = await api(`/api/campaign/${c.id}/complete`, { method: 'POST' });
      toast(r.mock ? 'Campaign completed (summary call in test mode)' : 'Summary call placed — your phone will ring shortly', 'success');
      reload();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setCompleting(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl">Campaigns</h1>
          <p className="text-sm">Every calling campaign (Sarvam AI or Infinity Voice) and its results.</p>
        </div>
        <button className="btn-primary" onClick={() => setOpen(true)}><Icon name="play" className="h-3.5 w-3.5" /> New campaign</button>
      </div>

      {loading && !data && <p className="text-sm">Loading campaigns…</p>}
      {error && <div className="card p-4 text-sm text-red-300">{error.message}</div>}
      {data && data.length === 0 && <div className="card p-10 text-center text-sm text-gray-500">No campaigns yet. Start your first one.</div>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {data?.map((c) => {
          const done = c.booked + c.rejected + c.no_answer + c.callback_later;
          const total = Math.max(c.total_calls, done);
          const pct = total ? Math.round((done / total) * 100) : 0;
          const conv = done ? Math.round((c.booked / done) * 100) : 0;
          return (
            <div key={c.id} className="card p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ink">{c.name}{c.engine === 'infinity_voice' && <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">Infinity Voice</span>}</p>
                  <p className="text-xs text-gray-500">Started {fmtDateTime(c.created_at)}{c.completed_at ? ` · finished ${fmtDateTime(c.completed_at)}` : ''}</p>
                </div>
                <Badge tone={c.status === 'RUNNING' ? 'blue' : 'green'}>{c.status === 'RUNNING' ? 'Running' : 'Completed'}</Badge>
              </div>
              <div className="mt-4 grid grid-cols-4 gap-2 text-center">
                {[['Booked', c.booked, 'text-emerald-400'], ['Callback', c.callback_later, 'text-amber-400'], ['Rejected', c.rejected, 'text-red-400'], ['No answer', c.no_answer, 'text-gray-400']].map(([l, n, cls]) => (
                  <div key={l} className="rounded-lg bg-navy py-2.5">
                    <p className={`text-xl font-bold tabular-nums ${cls}`}>{n}</p>
                    <p className="text-[11px]">{l}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="tabular-nums">{done}/{total || '?'} calls · {conv}% booked</span>
                <span className="flex items-center gap-3">
                  {c.summary_call_sent && <span className="text-emerald-400">✓ Summary call placed</span>}
                  <Link to={`/clients?campaign_id=${c.id}`} className="text-blue-400 hover:underline">Clients</Link>
                  {c.status === 'RUNNING' && (
                    <button className="text-blue-400 hover:underline disabled:opacity-50" disabled={completing === c.id} onClick={() => complete(c)}>
                      {completing === c.id ? 'Completing…' : 'Complete & call me'}
                    </button>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {open && <NewCampaign onClose={() => setOpen(false)} onCreated={reload} />}
    </div>
  );
}
