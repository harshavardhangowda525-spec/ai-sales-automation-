import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from './Badge';
import { useToast } from './Toast';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';

const TYPE_LABEL = { QUOTATION: 'Quotation', WEBSITE: 'Website link', SUMMARY: 'Campaign summary', UPDATE: 'Status update call', NOTICE: 'Jarvis news call' };
const STATUS = {
  QUEUED: ['Waiting to call you', 'blue'],
  CALLING: ['Calling you now', 'blue'],
  NEEDS_MANUAL: ['Needs your decision', 'amber'],
  APPROVED: ['Approved', 'green'],
  SENT: ['Approved · sent to client', 'green'],
  REJECTED: ['Rejected', 'red'],
  FAILED: ['Approved · sending failed', 'red'],
  DONE: ['Delivered', 'green'],
  CANCELLED: ['Cancelled', 'gray'],
};

export function ApprovalStatus({ status }) {
  const [label, tone] = STATUS[status] || [status, 'gray'];
  return <Badge tone={tone}>{label}</Badge>;
}

/** One approval with Approve / Reject / Call me again buttons. */
export function ApprovalRow({ call, onChanged, showClient = false }) {
  const [busy, setBusy] = useState('');
  const toast = useToast();
  const open = ['QUEUED', 'CALLING', 'NEEDS_MANUAL', 'FAILED'].includes(call.status);

  async function act(action, msg) {
    setBusy(action);
    try {
      const r = await api(`/api/approvals/${call.id}/${action}`, { method: 'POST', body: {} });
      toast(r.ok === false ? `Approved, but sending failed: ${r.error}` : msg, r.ok === false ? 'error' : 'success');
      onChanged?.();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">
            {TYPE_LABEL[call.type]}
            {showClient && call.client && <> · <Link to={`/clients/${call.client.id}`} className="text-blue-400 hover:underline">{call.client.business_name}</Link></>}
          </p>
          <p className="text-xs text-gray-500">
            {fmtDateTime(call.created_at)}{call.attempts ? ` · ${call.attempts} call${call.attempts > 1 ? 's' : ''}` : ''}
            {call.data?.website_url && <> · <a href={call.data.website_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">{call.data.website_url}</a></>}
          </p>
          {call.decision_note && <p className="mt-0.5 text-xs text-muted">{call.decision_note}</p>}
        </div>
        <ApprovalStatus status={call.status} />
      </div>
      {open && !['SUMMARY', 'UPDATE', 'NOTICE'].includes(call.type) && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-primary btn-sm" disabled={!!busy} onClick={() => act('approve', 'Approved — sent to the client on WhatsApp')}>
            {busy === 'approve' ? 'Sending…' : call.status === 'FAILED' ? 'Retry sending' : 'Approve & send'}
          </button>
          {call.status !== 'FAILED' && (
            <button className="btn-ghost btn-sm" disabled={!!busy} onClick={() => act('reject', 'Rejected — nothing sent to the client')}>Reject</button>
          )}
          {call.status !== 'CALLING' && call.status !== 'FAILED' && (
            <button className="btn-ghost btn-sm" disabled={!!busy} onClick={() => act('call-again', 'You will get a call shortly')}>Call me again</button>
          )}
        </div>
      )}
    </div>
  );
}
