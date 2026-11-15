import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../components/Icon';
import { PlanBadge, PortalBadge } from '../components/Badge';
import usePolling from '../lib/usePolling';
import { api } from '../lib/api';

const TZ = 'Asia/Kolkata';
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// IST calendar date (YYYY-MM-DD) of an instant
const istKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d));
const timeIST = (d) => new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(d));
const pad = (n) => String(n).padStart(2, '0');

/** Weeks (Mon–Sun) covering the given month, as arrays of {key, day, inMonth}. */
function monthGrid(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (first.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(Date.UTC(year, month, 1 - offset));
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const row = [];
    for (let d = 0; d < 7; d++) {
      const dt = new Date(start.getTime() + (w * 7 + d) * 86400000);
      row.push({ key: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`, day: dt.getUTCDate(), inMonth: dt.getUTCMonth() === month });
    }
    weeks.push(row);
    if (w >= 4 && row[6].day < 7 && !row[6].inMonth) break;
  }
  return weeks;
}

export default function Calendar() {
  const todayKey = istKey(new Date());
  const [ym, setYm] = useState(() => ({ y: Number(todayKey.slice(0, 4)), m: Number(todayKey.slice(5, 7)) - 1 }));
  const [selected, setSelected] = useState(todayKey);
  const weeks = useMemo(() => monthGrid(ym.y, ym.m), [ym]);
  const from = weeks[0][0].key;
  const to = weeks[weeks.length - 1][6].key;
  const { data, error, loading } = usePolling(() => api(`/api/calendar?from=${from}&to=${to}`), 15000, [from, to]);

  // Booked consultations + Google Calendar events, as one list of items sorted by time.
  const items = useMemo(() => {
    const meetings = (data?.meetings || []).map((m) => ({ ...m, kind: 'meeting', at: m.meeting_time }));
    const google = (data?.google_events || []).map((e) => ({ ...e, kind: 'google', at: e.start }));
    return [...meetings, ...google].sort((a, b) => new Date(a.at) - new Date(b.at));
  }, [data]);
  const byDay = useMemo(() => {
    const map = {};
    for (const it of items) (map[istKey(it.at)] ||= []).push(it);
    return map;
  }, [items]);
  const upcoming = items.filter((it) => new Date(it.at).getTime() > Date.now() - 30 * 60000);
  const dayList = byDay[selected] || [];
  const monthLabel = new Date(Date.UTC(ym.y, ym.m, 1)).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shift = (n) => setYm(({ y, m }) => { const d = new Date(Date.UTC(y, m + n, 1)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() }; });

  const GoogleRow = ({ e }) => (
    <li className="rounded-lg border border-violet-500/30 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{e.all_day ? 'All day' : timeIST(e.start)} · {e.title}</p>
          {e.location && <p className="truncate text-xs text-muted">{e.location}</p>}
        </div>
        <span className="flex-none rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold text-violet-300">Google</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {e.meet_link && <a href={e.meet_link} target="_blank" rel="noreferrer" className="btn-primary btn-sm"><Icon name="video" className="h-3.5 w-3.5" /> Join</a>}
        {e.html_link && <a href={e.html_link} target="_blank" rel="noreferrer" className="btn-ghost btn-sm">Open in Google Calendar</a>}
      </div>
    </li>
  );

  const MeetingRow = ({ m }) => (
    <li className="rounded-lg border border-line p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{timeIST(m.meeting_time)} · <Link to={`/clients/${m.id}`} className="hover:underline">{m.business_name}</Link></p>
          <p className="text-xs text-muted">{[m.contact_name, m.phone_number].filter(Boolean).join(' · ')}</p>
        </div>
        <PlanBadge value={m.plan_interest} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {m.meeting_link && <a href={m.meeting_link} target="_blank" rel="noreferrer" className="btn-primary btn-sm"><Icon name="video" className="h-3.5 w-3.5" /> Join</a>}
        <PortalBadge value={m.portal_status} />
      </div>
    </li>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl">Calendar</h1>
          <p className="text-sm">Consultations booked here plus your Google Calendar, in one view (IST).</p>
          <p className="mt-1 flex flex-wrap gap-3 text-xs">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-blue-400" />Consultations</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-violet-400" />Google Calendar{data && !data.google_connected ? ' (not connected)' : ''}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
          <span className="w-36 text-center text-sm font-semibold text-ink">{monthLabel}</span>
          <button className="btn-ghost btn-sm" onClick={() => shift(1)} aria-label="Next month">›</button>
          <button className="btn-ghost btn-sm" onClick={() => { setYm({ y: Number(todayKey.slice(0, 4)), m: Number(todayKey.slice(5, 7)) - 1 }); setSelected(todayKey); }}>Today</button>
        </div>
      </div>

      {error && <div className="card p-4 text-sm text-red-300">{error.message}</div>}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="card overflow-hidden xl:col-span-2">
          <div className="grid grid-cols-7 border-b border-line text-center text-[11px] font-medium uppercase tracking-wide text-muted">
            {DAYS.map((d) => <div key={d} className="py-2">{d}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {weeks.flat().map((c) => {
              const dayItems = byDay[c.key] || [];
              const isToday = c.key === todayKey;
              const isSel = c.key === selected;
              return (
                <button key={c.key} onClick={() => setSelected(c.key)}
                  className={`flex min-h-[64px] flex-col items-start justify-start border-b border-r border-line p-1.5 text-left transition sm:min-h-[92px] ${c.inMonth ? '' : 'opacity-40'} ${isSel ? 'bg-primary/10' : 'hover:bg-line/50'}`}>
                  <span className={`inline-grid h-6 w-6 place-items-center rounded-full text-xs ${isToday ? 'bg-primary font-bold text-white' : 'text-muted'}`}>{c.day}</span>
                  <div className="mt-1 hidden w-full space-y-1 sm:block">
                    {dayItems.slice(0, 3).map((it) => (
                      <div key={`${it.kind}-${it.id}`} className={`truncate rounded px-1.5 py-0.5 text-[11px] ${it.kind === 'google' ? 'bg-violet-500/15 text-violet-200' : 'bg-blue-500/15 text-blue-200'}`}>
                        {it.kind === 'google' ? `${it.all_day ? '' : `${timeIST(it.at)} `}${it.title}` : `${timeIST(it.at)} ${it.business_name}`}
                      </div>
                    ))}
                    {dayItems.length > 3 && <div className="text-[11px] text-muted">+{dayItems.length - 3} more</div>}
                  </div>
                  {dayItems.length > 0 && <span className="mt-1 block h-1.5 w-1.5 rounded-full bg-blue-400 sm:hidden" />}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-5">
          <div className="card p-5">
            <h2 className="mb-3 text-base">
              {new Date(`${selected}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', timeZone: TZ })}
            </h2>
            {dayList.length ? <ul className="space-y-2">{dayList.map((it) => (it.kind === 'google' ? <GoogleRow key={`g-${it.id}`} e={it} /> : <MeetingRow key={it.id} m={it} />))}</ul>
              : <p className="text-sm text-gray-500">Nothing scheduled this day.</p>}
          </div>
          <div className="card p-5">
            <h2 className="mb-3 text-base">Upcoming</h2>
            {loading && !data ? <p className="text-sm">Loading…</p>
              : upcoming.length ? <ul className="space-y-2">{upcoming.slice(0, 10).map((it) => (
                <li key={`${it.kind}-${it.id}`} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`h-2 w-2 flex-none rounded-sm ${it.kind === 'google' ? 'bg-violet-400' : 'bg-blue-400'}`} />
                    {it.kind === 'google'
                      ? <a href={it.html_link} target="_blank" rel="noreferrer" className="truncate text-ink hover:underline">{it.title}</a>
                      : <Link to={`/clients/${it.id}`} className="truncate text-ink hover:underline">{it.business_name}</Link>}
                  </span>
                  <span className="flex-none text-xs text-muted">{new Date(it.at).toLocaleString('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', ...(it.all_day ? {} : { hour: 'numeric', minute: '2-digit', hour12: true }) })}</span>
                </li>
              ))}</ul>
                : <p className="text-sm text-gray-500">Nothing upcoming.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
