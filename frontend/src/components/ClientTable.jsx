import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { OutcomeBadge, PlanBadge, PortalBadge } from './Badge';
import Icon from './Icon';
import RescheduleModal from './RescheduleModal';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useToast } from './Toast';

export default function ClientTable({ clients, onChanged }) {
  const [resending, setResending] = useState(null);
  const [rescheduling, setRescheduling] = useState(null);
  const toast = useToast();
  const navigate = useNavigate();

  async function resend(c) {
    setResending(c.id);
    try {
      const r = await api(`/api/clients/${c.id}/resend-proposal`, { method: 'POST' });
      toast(r.ok ? `Proposal resent to ${c.business_name}` : `Partially done — check ${c.business_name}'s activity log`, r.ok ? 'success' : 'error');
      onChanged?.();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setResending(null);
    }
  }

  if (!clients.length) {
    return <div className="card p-10 text-center text-sm text-gray-500">No clients match these filters.</div>;
  }

  return (
    <>
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
              <tr>
                {['Business', 'Phone', 'Plan', 'Outcome', 'Meeting (IST)', 'Proposal', 'Portal status', 'Actions'].map((h) => (
                  <th key={h} className="px-3 py-3 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {clients.map((c) => (
                <tr key={c.id} className="cursor-pointer transition hover:bg-line" onClick={() => navigate(`/clients/${c.id}`)}>
                  <td className="min-w-[11rem] px-3 py-3">
                    <p className="font-medium text-ink">{c.business_name}</p>
                    {c.contact_name && <p className="text-xs text-muted">{c.contact_name}</p>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 tabular-nums">{c.phone_number}</td>
                  <td className="px-3 py-3"><PlanBadge value={c.plan_interest} /></td>
                  <td className="px-3 py-3"><OutcomeBadge value={c.call_outcome} /></td>
                  <td className="px-3 py-3 whitespace-nowrap">{fmtDateTime(c.meeting_time)}</td>
                  <td className="px-3 py-3">
                    {c.proposal_sent
                      ? <span className="inline-flex items-center gap-1 whitespace-nowrap text-emerald-400"><Icon name="check" /> Sent</span>
                      : <span className="text-gray-500">Pending</span>}
                  </td>
                  <td className="px-3 py-3"><PortalBadge value={c.portal_status} /></td>
                  <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <div className="flex gap-1.5">
                      <Link to={`/clients/${c.id}`} className="btn-ghost btn-sm" title="View client" aria-label={`View ${c.business_name}`}><Icon name="eye" className="h-3.5 w-3.5" /></Link>
                      <button className="btn-ghost btn-sm" disabled={resending === c.id} onClick={() => resend(c)} title="Resend proposal" aria-label={`Resend proposal to ${c.business_name}`}>
                        <Icon name={resending === c.id ? 'refresh' : 'send'} className={`h-3.5 w-3.5 ${resending === c.id ? 'animate-spin' : ''}`} />
                      </button>
                      <button className="btn-ghost btn-sm" onClick={() => setRescheduling(c)} title="Reschedule meeting" aria-label={`Reschedule meeting with ${c.business_name}`}><Icon name="calendar" className="h-3.5 w-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {rescheduling && <RescheduleModal client={rescheduling} onClose={() => setRescheduling(null)} onDone={onChanged} />}
    </>
  );
}
