import { Link } from 'react-router-dom';
import StatCard from '../components/StatCard';
import ActivityFeed from '../components/ActivityFeed';
import OutcomeDonut from '../components/OutcomeDonut';
import { OutcomeBadge, PlanBadge } from '../components/Badge';
import { ApprovalRow } from '../components/Approvals';
import usePolling from '../lib/usePolling';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';

function CampaignProgress({ campaign }) {
  if (!campaign) {
    return (
      <div className="card flex flex-col items-start justify-between gap-3 p-5 sm:flex-row sm:items-center">
        <div>
          <p className="text-sm font-semibold text-ink">No active campaign</p>
          <p className="text-sm">Start a Sarvam campaign to begin calling leads.</p>
        </div>
        <Link to="/campaigns" className="btn-primary">Start campaign</Link>
      </div>
    );
  }
  const done = campaign.booked + campaign.rejected + campaign.no_answer + campaign.callback_later;
  const total = Math.max(campaign.total_calls, done);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const parts = [
    ['Booked', campaign.booked, 'bg-success'],
    ['Callback', campaign.callback_later, 'bg-warning'],
    ['Rejected', campaign.rejected, 'bg-danger'],
    ['No answer', campaign.no_answer, 'bg-gray-500'],
  ];
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
          </span>
          <p className="font-semibold text-ink">{campaign.name}</p>
          <span className="text-xs text-gray-500">started {timeAgo(campaign.created_at)}</span>
        </div>
        <p className="text-sm tabular-nums"><span className="font-semibold text-ink">{done}</span> / {total || '?'} calls · {pct}%</p>
      </div>
      <div className="mt-4 flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        {total > 0 && parts.map(([label, n, cls]) => n > 0 && (
          <div key={label} className={`${cls} transition-all`} style={{ width: `${(n / total) * 100}%` }} title={`${label}: ${n}`} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {parts.map(([label, n, cls]) => (
          <span key={label} className="flex items-center gap-1.5"><span className={`h-2 w-2 rounded-sm ${cls}`} />{label} <b className="text-ink tabular-nums">{n}</b></span>
        ))}
      </div>
    </div>
  );
}

export default function Overview() {
  const { data, error, loading, reload } = usePolling(() => api('/api/dashboard'), 6000);

  if (loading && !data) return <p className="text-sm">Loading dashboard…</p>;
  if (error && !data) return <div className="card p-6 text-sm text-red-300">Could not load dashboard: {error.message}</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl">Overview</h1>
        <p className="text-sm">Live results from your Sarvam AI outreach.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total Booked" value={data.total_booked} icon="check" color="green" hint={`of ${data.total_calls} calls`} />
        <StatCard label="Meetings Scheduled" value={data.meetings_scheduled} icon="calendar" color="blue" hint="Google Meet" />
        <StatCard label="Proposals Sent" value={data.proposals_sent} icon="file" color="purple" hint="via WhatsApp" />
        <StatCard label="Rejected" value={data.total_rejected} icon="x" color="red" hint={`${data.total_no_answer} no answer · ${data.total_callback} callback`} />
      </div>

      {data.pending_approvals?.length > 0 && (
        <div className="card border-amber-500/40 p-5">
          <h2 className="text-base">Waiting for your approval <span className="ml-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">{data.pending_approvals.length}</span></h2>
          <p className="mb-4 text-xs">Your assistant calls you about each one. You can also decide right here.</p>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {data.pending_approvals.map((c) => <ApprovalRow key={c.id} call={c} onChanged={reload} showClient />)}
          </div>
        </div>
      )}

      <CampaignProgress campaign={data.active_campaign} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <div className="card p-5 xl:col-span-2">
          <h2 className="text-base">Call outcomes</h2>
          <p className="mb-5 text-xs">Conversion = booked ÷ all calls</p>
          <OutcomeDonut data={data} />
        </div>
        <div className="card p-5 xl:col-span-3">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base">Recent activity</h2>
            <span className="text-xs text-gray-500">last 10 actions</span>
          </div>
          <ActivityFeed items={data.recent_activity} />
        </div>
      </div>

      <div className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base">Latest clients</h2>
          <Link to="/clients" className="text-sm text-blue-400 hover:underline">View all →</Link>
        </div>
        {data.recent_clients.length === 0 ? <p className="py-6 text-center text-sm text-gray-500">No clients yet.</p> : (
          <ul className="divide-y divide-line">
            {data.recent_clients.map((c) => (
              <li key={c.id}>
                <Link to={`/clients/${c.id}`} className="-mx-2 flex flex-wrap items-center gap-3 rounded-lg px-2 py-3 hover:bg-line">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-ink">{c.business_name}</p>
                    <p className="text-xs text-muted">{c.contact_name || c.phone_number} · {timeAgo(c.created_at)}</p>
                  </div>
                  <PlanBadge value={c.plan_interest} />
                  <OutcomeBadge value={c.call_outcome} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
