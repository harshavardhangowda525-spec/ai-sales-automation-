import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ClientTable from '../components/ClientTable';
import Icon from '../components/Icon';
import usePolling from '../lib/usePolling';
import { api } from '../lib/api';

const OUTCOMES = [['', 'All outcomes'], ['BOOKED', 'Booked'], ['CALLBACK_LATER', 'Callback'], ['REJECTED', 'Rejected'], ['NO_ANSWER', 'No answer']];
const PLANS = [['', 'All plans'], ['BASIC', 'Basic'], ['PREMIUM', 'Premium'], ['ADVANCED', 'Advanced'], ['UNKNOWN', 'Unknown']];

export default function Clients() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const outcome = params.get('outcome') || '';
  const plan = params.get('plan') || '';
  const from = params.get('from') || '';
  const to = params.get('to') || '';

  const query = useMemo(() => {
    const s = new URLSearchParams();
    if (outcome) s.set('outcome', outcome);
    if (plan) s.set('plan', plan);
    if (from) s.set('from', from);
    if (to) s.set('to', to);
    if (params.get('q')) s.set('q', params.get('q'));
    if (params.get('campaign_id')) s.set('campaign_id', params.get('campaign_id'));
    return s.toString();
  }, [outcome, plan, from, to, params]);

  const { data, error, loading, reload } = usePolling(() => api(`/api/clients?${query}`), 10000, [query]);

  const set = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl">Clients</h1>
          <p className="text-sm">{data ? `${data.length} client${data.length === 1 ? '' : 's'}` : 'Every business your AI agent has spoken to.'}</p>
        </div>
      </div>

      <div className="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
        <form className="relative sm:col-span-2" onSubmit={(e) => { e.preventDefault(); set('q', q.trim()); }}>
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input className="input pl-9" placeholder="Search business, name or phone" value={q}
            onChange={(e) => setQ(e.target.value)} onBlur={() => set('q', q.trim())} aria-label="Search clients" />
        </form>
        <select className="input" value={outcome} onChange={(e) => set('outcome', e.target.value)} aria-label="Filter by outcome">
          {OUTCOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="input" value={plan} onChange={(e) => set('plan', e.target.value)} aria-label="Filter by plan">
          {PLANS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input type="date" className="input [color-scheme:dark]" value={from} onChange={(e) => set('from', e.target.value)} aria-label="From date" />
        <input type="date" className="input [color-scheme:dark]" value={to} onChange={(e) => set('to', e.target.value)} aria-label="To date" />
      </div>

      {loading && !data && <p className="text-sm">Loading clients…</p>}
      {error && <div className="card p-4 text-sm text-red-300">{error.message}</div>}
      {data && <ClientTable clients={data} onChanged={reload} />}
    </div>
  );
}
