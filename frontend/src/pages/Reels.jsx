import { useState } from 'react';
import Icon from '../components/Icon';
import { useToast } from '../components/Toast';
import usePolling from '../lib/usePolling';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';

const STATUS = {
  generating: ['Claude is making it…', 'bg-blue-500/15 text-blue-300'],
  ready: ['Waiting for your approval', 'bg-amber-500/15 text-amber-300'],
  approved: ['Approved — posts at 7:30 PM', 'bg-emerald-500/15 text-emerald-300'],
  posting: ['Posting…', 'bg-blue-500/15 text-blue-300'],
  posted: ['Posted', 'bg-emerald-500/15 text-emerald-300'],
  rejected: ['Rejected', 'bg-line text-muted'],
  failed: ['Failed', 'bg-red-500/15 text-red-300'],
};

function ReelCard({ r, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [changes, setChanges] = useState('');
  const [label, cls] = STATUS[r.status] || [r.status, 'bg-line text-muted'];
  async function act(path, body, msg) {
    setBusy(path);
    try { await api(`/api/reels/${r.id}/${path}`, { method: 'POST', body }); toast(msg, 'success'); setChanges(''); onChanged(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(''); }
  }
  return (
    <li className="card overflow-hidden p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-ink">{r.day}</p>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{label}</span>
      </div>
      {r.topic && <p className="mt-1 text-xs text-muted">{r.topic}</p>}
      <div className="mt-3 grid gap-4 sm:grid-cols-[220px_1fr]">
        {r.video_url
          ? <video src={r.video_url} controls playsInline className="aspect-[9/16] w-full rounded-lg bg-black" />
          : <div className="grid aspect-[9/16] w-full place-items-center rounded-lg bg-navy text-xs text-gray-500">{r.status === 'generating' ? 'Rendering…' : 'No video'}</div>}
        <div className="min-w-0 space-y-3">
          <p className="whitespace-pre-line text-sm text-ink">{r.caption || <span className="text-gray-500">Caption appears when the reel is ready</span>}</p>
          {r.ig_permalink && <a href={r.ig_permalink} target="_blank" rel="noreferrer" className="text-sm text-blue-400 hover:underline">View on Instagram</a>}
          {r.error && <p className="text-xs text-red-300">{r.error}</p>}
          {r.run_url && <a href={r.run_url} target="_blank" rel="noreferrer" className="block text-xs text-gray-500 hover:underline">GitHub run</a>}
          <div className="flex flex-wrap gap-2">
            {r.status === 'ready' && <button className="btn-primary btn-sm" disabled={!!busy} onClick={() => act('approve', {}, 'Approved — it posts at 7:30 PM')}><Icon name="check" /> Approve</button>}
            {['ready', 'approved', 'failed'].includes(r.status) && r.video_url && (
              <button className="btn-ghost btn-sm" disabled={!!busy} onClick={() => window.confirm('Post this reel on Instagram right now?') && act('post-now', {}, 'Posting to Instagram…')}>Post now</button>
            )}
            {['ready', 'approved'].includes(r.status) && <button className="btn-ghost btn-sm" disabled={!!busy} onClick={() => act('reject', {}, 'Reel rejected — it won’t be posted')}>Reject</button>}
          </div>
          {['ready', 'approved', 'rejected', 'failed'].includes(r.status) && (
            <div className="flex gap-2">
              <input className="input text-xs" placeholder="Changes for a new version, e.g. more about mobile apps" value={changes} onChange={(e) => setChanges(e.target.value)} />
              <button className="btn-ghost btn-sm" disabled={!changes.trim() || !!busy} onClick={() => act('reject', { instructions: changes }, 'Claude is making a new version')}>Redo</button>
            </div>
          )}
        </div>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">{r.posted_at ? `Posted ${fmtDateTime(r.posted_at)}` : r.ready_at ? `Ready ${fmtDateTime(r.ready_at)}` : `Started ${fmtDateTime(r.created_at)}`}</p>
    </li>
  );
}

export default function Reels() {
  const toast = useToast();
  const { data, reload } = usePolling(() => api('/api/reels'), 15000);
  const [busy, setBusy] = useState(false);
  const s = data?.settings;
  async function makeNow() {
    setBusy(true);
    try { await api('/api/reels/make', { method: 'POST', body: {} }); toast('Claude has started today’s reel', 'success'); reload(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl">Instagram reels</h1>
          <p className="text-sm">Every day at {s?.prepare_at || '17:00'} Claude codes a new motion-graphics reel about our services and prices. You get it on WhatsApp, Jarvis calls for your OK, and it posts at {s?.post_at || '19:30'}.</p>
        </div>
        <button className="btn-primary" disabled={busy || !s?.enabled} onClick={makeNow}><Icon name="refresh" /> {busy ? 'Starting…' : 'Make today’s reel now'}</button>
      </div>
      {s && (
        <div className="card flex flex-wrap gap-x-6 gap-y-1 p-4 text-sm">
          <span>Instagram: {s.instagram_connected ? <b className="text-emerald-300">connected{s.instagram_username ? ` (@${s.instagram_username})` : ''}</b> : <b className="text-red-300">not connected — add INSTAGRAM_ACCESS_TOKEN</b>}</span>
          <span>Reels: {s.enabled ? <b className="text-emerald-300">on</b> : <b className="text-red-300">off</b>}</span>
          <span className="text-muted">Today’s topic: {s.today_topic}</span>
        </div>
      )}
      {data?.reels?.length
        ? <ul className="space-y-4">{data.reels.map((r) => <ReelCard key={r.id} r={r} onChanged={reload} />)}</ul>
        : <div className="card p-6 text-sm text-muted">No reels yet. The first one is made at {s?.prepare_at || '17:00'} today, or click “Make today’s reel now”.</div>}
    </div>
  );
}
