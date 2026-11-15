import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { OutcomeBadge, PlanBadge, PortalBadge } from '../components/Badge';
import Icon from '../components/Icon';
import RescheduleModal from '../components/RescheduleModal';
import WebsiteReadyModal from '../components/WebsiteReadyModal';
import { ApprovalRow } from '../components/Approvals';
import WebsiteBuild from '../components/WebsiteBuild';
import { proposalMessage, websiteMessage, whatsappLink } from '../lib/whatsapp';
import { useToast } from '../components/Toast';
import usePolling from '../lib/usePolling';
import { api } from '../lib/api';
import { fmtDateTime, fmtMeeting, PORTAL_LABEL, PLAN_LABEL } from '../lib/format';

function Field({ label, children }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="mt-1 text-sm text-ink">{children || <span className="text-gray-500">—</span>}</dd>
    </div>
  );
}

export default function ClientDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { data: c, error, loading, reload } = usePolling(() => api(`/api/clients/${id}`), 8000, [id]);
  const [notes, setNotes] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [busy, setBusy] = useState('');
  const [rescheduling, setRescheduling] = useState(false);
  const [websiteOpen, setWebsiteOpen] = useState(false);

  useEffect(() => { if (c && !notesDirty) setNotes(c.notes || ''); }, [c, notesDirty]);

  if (loading && !c) return <p className="text-sm">Loading client…</p>;
  if (error && !c) return <div className="card p-6 text-sm text-red-300">{error.message}</div>;

  async function update(body, msg) {
    setBusy('update');
    try {
      await api(`/api/clients/${id}`, { method: 'PATCH', body });
      toast(msg, 'success');
      await reload();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function resend() {
    setBusy('resend');
    try {
      const r = await api(`/api/clients/${id}/resend-proposal`, { method: 'POST' });
      toast(r.ok ? 'Proposal regenerated and sent on WhatsApp' : 'Some steps failed — see activity log', r.ok ? 'success' : 'error');
      await reload();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  function sendWhatsApp(kind) {
    const text = kind === 'website' ? websiteMessage(c) : proposalMessage(c);
    // Open first (synchronously) so the browser doesn't block the new tab, then record it.
    window.open(whatsappLink(c.phone_number, text), '_blank', 'noopener');
    api(`/api/clients/${id}/whatsapp-sent`, { method: 'POST', body: { kind } })
      .then(() => { toast('WhatsApp opened with the message — press Send there', 'success'); reload(); })
      .catch((err) => toast(err.message, 'error'));
  }

  const errors = c.call_logs.filter((l) => l.action.endsWith('_ERROR'));

  return (
    <div className="space-y-6">
      <Link to="/clients" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><Icon name="back" /> All clients</Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl">{c.business_name}</h1>
          <p className="mt-1 text-sm">{[c.contact_name, c.phone_number].filter(Boolean).join(' · ')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <OutcomeBadge value={c.call_outcome} />
            <PlanBadge value={c.plan_interest} />
            <PortalBadge value={c.portal_status} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" onClick={() => sendWhatsApp('proposal')} title="Opens your WhatsApp with the proposal + meeting message typed in">
            <Icon name="send" /> Send on WhatsApp
          </button>
          {c.website_url && (
            <button className="btn-ghost" onClick={() => sendWhatsApp('website')} title="Opens your WhatsApp with the website link message typed in">Send website link</button>
          )}
          <button className="btn-ghost" onClick={() => setRescheduling(true)}><Icon name="calendar" /> Reschedule</button>
          <button className="btn-ghost" onClick={() => setWebsiteOpen(true)}><Icon name="external" /> Website ready</button>
          <button className="btn-ghost" disabled={busy === 'resend'} onClick={resend} title="Regenerates the PDF and sends it via the WhatsApp API (needs an approved template)">{busy === 'resend' ? 'Sending…' : 'Regenerate proposal'}</button>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="card flex gap-3 border-red-500/40 p-4 text-sm">
          <Icon name="alert" className="h-5 w-5 flex-none text-red-400" />
          <div><p className="font-semibold text-red-300">{errors.length} automation error{errors.length > 1 ? 's' : ''}</p><p className="mt-0.5 break-words">{errors[0].details}</p></div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <div className="card p-5">
            <h2 className="mb-4 text-base">Client details</h2>
            <dl className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Field label="Business">{c.business_name}</Field>
              <Field label="Contact">{c.contact_name}</Field>
              <Field label="Phone">{c.phone_number}</Field>
              <Field label="Plan interest">{PLAN_LABEL[c.plan_interest]}</Field>
              <Field label="Preferred time">{c.preferred_time}</Field>
              <Field label="Call duration">{c.duration_seconds != null ? `${Math.floor(c.duration_seconds / 60)}m ${c.duration_seconds % 60}s` : null}</Field>
              <Field label="Campaign">{c.campaign?.name}</Field>
              <Field label="Received">{fmtDateTime(c.created_at)}</Field>
            </dl>
            <div className="mt-5">
              <p className="label">Requirements</p>
              <p className="mt-1 whitespace-pre-line text-sm text-ink">{c.requirements || <span className="text-gray-500">Not captured</span>}</p>
            </div>
          </div>

          {(c.call_outcome === 'BOOKED' || c.website_stage !== 'NOT_STARTED' || c.website_prompt) && (
            <WebsiteBuild client={c} onChanged={reload} onReady={() => setWebsiteOpen(true)} />
          )}

          <div className="card p-5">
            <button className="flex w-full items-center justify-between" onClick={() => setShowTranscript((s) => !s)} aria-expanded={showTranscript}>
              <h2 className="text-base">Call transcript</h2>
              <span className="text-sm text-blue-400">{showTranscript ? 'Hide' : 'Show'}</span>
            </button>
            {showTranscript && (
              <pre className="mt-4 max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg bg-navy p-4 font-sans text-sm leading-relaxed text-gray-300">
                {c.transcript || 'No transcript available.'}
              </pre>
            )}
          </div>

          <div className="card p-5">
            <h2 className="mb-3 text-base">Activity log</h2>
            <ol className="relative space-y-4 border-l border-line pl-5">
              {c.call_logs.map((l) => (
                <li key={l.id} className="relative">
                  <span className={`absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-card ${l.action.endsWith('_ERROR') ? 'bg-red-500' : l.action.endsWith('_MOCK') ? 'bg-amber-400' : 'bg-blue-400'}`} />
                  <p className="text-sm font-medium text-ink">{l.action.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (x) => x.toUpperCase())}</p>
                  <p className="text-xs text-gray-500">{fmtDateTime(l.timestamp)}</p>
                  {l.details && <p className="mt-1 whitespace-pre-line break-words text-xs text-muted">{l.details}</p>}
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="space-y-6">
          {c.owner_calls?.length > 0 && (
            <div className="card p-5">
              <h2 className="mb-1 text-base">Your approvals</h2>
              <p className="mb-4 text-xs">Your assistant calls you before anything is sent to this client.</p>
              <div className="space-y-3">
                {c.owner_calls.map((oc) => <ApprovalRow key={oc.id} call={oc} onChanged={reload} />)}
              </div>
            </div>
          )}
          {c.website_url && (
            <div className="card p-5">
              <h2 className="mb-2 text-base">Website</h2>
              <a href={c.website_url} target="_blank" rel="noreferrer" className="break-all text-sm text-blue-400 hover:underline">{c.website_url}</a>
              <p className="mt-2 text-xs">{c.website_sent ? '✓ Link sent to client on WhatsApp' : 'Waiting for your approval'}</p>
            </div>
          )}
          <div className="card p-5">
            <h2 className="mb-4 flex items-center gap-2 text-base"><Icon name="video" className="h-4 w-4 text-blue-400" /> Consultation</h2>
            <p className="text-lg font-semibold text-ink">{fmtMeeting(c.meeting_time)}</p>
            {c.meeting_link ? (
              <a href={c.meeting_link} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1.5 break-all text-sm text-blue-400 hover:underline">
                {c.meeting_link} <Icon name="external" className="h-3.5 w-3.5 flex-none" />
              </a>
            ) : <p className="mt-2 text-sm text-gray-500">Not scheduled</p>}
            {c.calendar_event_id && <p className="mt-2 text-xs text-gray-500">Calendar event: {c.calendar_event_id}</p>}
          </div>

          <div className="card p-5">
            <h2 className="mb-4 flex items-center gap-2 text-base"><Icon name="file" className="h-4 w-4 text-violet-400" /> Proposal</h2>
            {c.proposal_url ? (
              <>
                <div className="overflow-hidden rounded-lg border border-line bg-white">
                  <iframe title="Proposal preview" src={`${c.proposal_url}#toolbar=0&view=FitH`} className="h-80 w-full" />
                </div>
                <div className="mt-3 flex gap-2">
                  <a href={c.proposal_url} target="_blank" rel="noreferrer" className="btn-ghost btn-sm">Open</a>
                  <a href={`${c.proposal_url}?download=1`} className="btn-ghost btn-sm">Download</a>
                </div>
                <p className="mt-3 text-xs">{c.proposal_sent ? '✓ Sent on WhatsApp' : 'Not sent yet — use "Send on WhatsApp" above'}</p>
                {c.proposals?.length > 1 && <p className="mt-1 text-xs text-gray-500">{c.proposals.length} versions · latest {c.proposals[0].number}</p>}
              </>
            ) : <p className="text-sm text-gray-500">No proposal generated yet.</p>}
          </div>

          <div className="card p-5">
            <h2 className="mb-4 text-base">Pipeline</h2>
            <label className="label" htmlFor="status">Status</label>
            <select id="status" className="input mt-1.5" value={c.portal_status} disabled={busy === 'update'}
              onChange={(e) => update({ portal_status: e.target.value }, `Status set to ${PORTAL_LABEL[e.target.value]}`)}>
              {Object.entries(PORTAL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label className="label mt-4 block" htmlFor="plan">Plan</label>
            <select id="plan" className="input mt-1.5" value={c.plan_interest} disabled={busy === 'update'}
              onChange={(e) => update({ plan_interest: e.target.value }, `Plan set to ${PLAN_LABEL[e.target.value]}`)}>
              {Object.entries(PLAN_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label className="label mt-4 block" htmlFor="notes">Notes</label>
            <textarea id="notes" rows={5} className="input mt-1.5 resize-y" placeholder="Add notes about this client…"
              value={notes} onChange={(e) => { setNotes(e.target.value); setNotesDirty(true); }} />
            <button className="btn-primary mt-3 w-full" disabled={!notesDirty || busy === 'update'}
              onClick={async () => { await update({ notes }, 'Notes saved'); setNotesDirty(false); }}>
              Save notes
            </button>
          </div>
        </div>
      </div>

      {rescheduling && <RescheduleModal client={c} onClose={() => setRescheduling(false)} onDone={reload} />}
      {websiteOpen && <WebsiteReadyModal client={c} onClose={() => setWebsiteOpen(false)} onDone={reload} />}
    </div>
  );
}
