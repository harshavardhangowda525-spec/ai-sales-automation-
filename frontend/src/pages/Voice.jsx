import { useEffect, useRef, useState } from 'react';
import Icon from '../components/Icon';
import { useToast } from '../components/Toast';
import usePolling from '../lib/usePolling';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';

const TABS = ['Overview', 'Agents', 'Test console', 'Calls', 'Knowledge'];
const CAPS = [
  ['bluetooth', 'Bluetooth connection'], ['hfp', 'HFP profile'], ['incoming_audio', 'Incoming audio'], ['outgoing_audio', 'Outgoing audio'],
  ['call_initiation', 'Call initiation'], ['call_answering', 'Call answering'], ['autonomous', 'Autonomous operation'],
];
const TOOL_LABELS = {
  check_availability: 'Check calendar', book_appointment: 'Book consultation', update_qualification: 'Update lead',
  create_follow_up: 'Create follow-up',
};
const glass = 'rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-xl shadow-xl shadow-black/30';

function Pill({ state }) {
  const cls = state === 'VERIFIED' ? 'bg-emerald-500/15 text-emerald-300' : state === 'FAILED' ? 'bg-red-500/15 text-red-300' : 'bg-white/10 text-gray-400';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide ${cls}`}>{state || 'UNKNOWN'}</span>;
}

/** Audio meter driven by the gateway's measured RMS level (0 when no call). */
function Meter({ label, level = 0 }) {
  const bars = 18;
  const lit = Math.round(Math.min(1, level * 6) * bars);
  return (
    <div>
      <p className="label mb-1.5">{label}</p>
      <div className="flex h-8 items-end gap-[3px]">
        {Array.from({ length: bars }, (_, i) => (
          <span key={i} className={`w-1.5 rounded-full transition-all duration-150 ${i < lit ? 'bg-gradient-to-t from-blue-500 to-cyan-300' : 'bg-white/10'}`}
            style={{ height: `${30 + (i % 5) * 14}%` }} />
        ))}
      </div>
    </div>
  );
}

function Overview({ status, reload }) {
  const toast = useToast();
  const gw = status?.gateway || {};
  const caps = gw.capabilities || {};
  const levels = gw.health?.levels || { in: 0, out: 0 };
  async function stop(on) {
    if (on && !window.confirm('Stop all AI calls now? Live calls hang up and the queue is cancelled.')) return;
    try { await api('/api/voice/emergency-stop', { method: 'POST', body: { on } }); toast(on ? 'Emergency stop ON' : 'AI calling allowed again', on ? 'error' : 'success'); reload(); }
    catch (err) { toast(err.message, 'error'); }
  }
  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <div className={`${glass} p-5 xl:col-span-2`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base">Telephony gateway <span className="text-xs text-gray-500">(your laptop + POCO C55 over Bluetooth HFP)</span></h2>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${gw.online ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>
            {gw.online ? `Online · ${gw.backend || 'no phone'}` : 'Offline'}
          </span>
        </div>
        {!gw.online && <p className="mb-4 text-sm text-gray-400">The local gateway isn't running or can't reach the server. See SETUP_GUIDE.md → "Start the gateway".</p>}
        {!gw.online && gw.last_seen && <p className="mb-2 text-xs text-amber-300">Last reported by the gateway — not live while it is offline:</p>}
        <div className={`grid gap-2 sm:grid-cols-2 ${gw.online ? '' : 'opacity-40 grayscale'}`}>
          {CAPS.map(([k, label]) => (
            <div key={k} className="flex items-center justify-between rounded-lg bg-black/20 px-3 py-2 text-sm"><span>{label}</span><Pill state={gw.online ? caps[k] : (caps[k] ? `${caps[k]}` : 'UNKNOWN')} /></div>
          ))}
        </div>
        <p className="mt-3 text-xs text-gray-500">Capabilities turn VERIFIED only after the hardware self-test passes on your phone (<code>node src/selftest.js</code>). Nothing is assumed.</p>
        <div className="mt-5 grid grid-cols-2 gap-6">
          <Meter label="Caller audio (in)" level={levels.in} />
          <Meter label="AI voice (out)" level={levels.out} />
        </div>
        {gw.last_seen && <p className="mt-3 text-[11px] text-gray-500">Last heartbeat {fmtDateTime(gw.last_seen)}{gw.health?.hostname ? ` · ${gw.health.hostname}` : ''}{gw.health?.last_turn_ms ? ` · last reply ${gw.health.last_turn_ms} ms` : ''}</p>}
      </div>
      <div className="space-y-5">
        <div className={`${glass} p-5`}>
          <h2 className="mb-3 text-base">AI brain</h2>
          <p className="text-sm">Provider: <b className={status?.ai?.provider === 'claude' ? 'text-emerald-300' : 'text-amber-300'}>{status?.ai?.provider === 'claude' ? 'Claude' : 'Mock (simulated)'}</b></p>
          <p className="mt-1 break-all text-xs text-gray-400">{status?.ai?.model}</p>
          {status?.ai?.last_response && <p className="mt-2 text-xs text-gray-400">Last turn {status.ai.last_response.turn_ms} ms · {fmtDateTime(status.ai.last_response.at)}</p>}
        </div>
        <div className={`${glass} p-5`}>
          <h2 className="mb-3 text-base">Safety</h2>
          <ul className="space-y-1.5 text-sm">
            <li>Outbound calling: <b className={status?.flags?.liveCalling ? 'text-emerald-300' : 'text-gray-400'}>{status?.flags?.liveCalling ? 'enabled' : 'disabled'}</b></li>
            <li>Auto-answer incoming: <b className={status?.flags?.autoAnswer ? 'text-emerald-300' : 'text-gray-400'}>{status?.flags?.autoAnswer ? 'enabled' : 'disabled'}</b></li>
            <li>Queue: {status?.queue?.queued ?? 0} waiting · approvals pending: {status?.queue?.pending_approvals ?? 0}</li>
            {status?.queue?.active && <li className="text-blue-300">On a call: {status.queue.active.agent?.name} ({status.queue.active.state})</li>}
          </ul>
          <button className={`mt-4 w-full rounded-lg px-3 py-2.5 text-sm font-bold text-white ${status?.emergency_stop ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'}`}
            onClick={() => stop(!status?.emergency_stop)}>
            {status?.emergency_stop ? 'Emergency stop is ON — resume' : '⛔ Emergency stop'}
          </button>
        </div>
      </div>
    </div>
  );
}

const EMPTY = { name: '', role: 'RECEPTIONIST', greeting: '', personality: '', objectives: '', escalation_rules: '', voice: '', language: 'en-IN', allowed_tools: [], can_call_out: false, active: true };
function Agents({ agents, reload }) {
  const toast = useToast();
  const [edit, setEdit] = useState(null);
  async function save() {
    try {
      if (edit.id) await api(`/api/voice/agents/${edit.id}`, { method: 'PATCH', body: edit });
      else await api('/api/voice/agents', { method: 'POST', body: edit });
      toast('Agent saved', 'success'); setEdit(null); reload();
    } catch (err) { toast(err.message, 'error'); }
  }
  const f = (k) => ({ value: edit?.[k] ?? '', onChange: (e) => setEdit({ ...edit, [k]: e.target.value }) });
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <div className="space-y-3">
        {(agents || []).map((a) => (
          <button key={a.id} onClick={() => setEdit(a)} className={`${glass} block w-full p-4 text-left transition hover:border-blue-400/40`}>
            <div className="flex items-center justify-between">
              <p className="font-semibold text-ink">{a.name}</p>
              <span className="text-[11px] text-gray-400">{a.role} · v{a.version}{a.active ? '' : ' · off'}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-gray-400">“{a.greeting}”</p>
            <p className="mt-2 text-[11px] text-gray-500">Tools: {(a.allowed_tools || []).map((t) => TOOL_LABELS[t] || t).join(', ') || 'basic only'}{a.can_call_out ? ' · may call out' : ' · inbound only'}</p>
          </button>
        ))}
        <button className="btn-ghost w-full" onClick={() => setEdit({ ...EMPTY })}>+ New agent</button>
      </div>
      {edit && (
        <div className={`${glass} space-y-3 p-5`}>
          <h2 className="text-base">{edit.id ? `Edit ${edit.name}` : 'New agent'}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><p className="label mb-1">Name</p><input className="input" {...f('name')} /></div>
            <div><p className="label mb-1">Role</p>
              <select className="input" {...f('role')}>{['RECEPTIONIST', 'SALES', 'FOLLOW_UP', 'SUPPORT'].map((r) => <option key={r}>{r}</option>)}</select></div>
          </div>
          <div><p className="label mb-1">Greeting (spoken first)</p><textarea className="input" rows={2} {...f('greeting')} /></div>
          <div><p className="label mb-1">Personality</p><textarea className="input" rows={2} {...f('personality')} /></div>
          <div><p className="label mb-1">Objectives</p><textarea className="input" rows={3} {...f('objectives')} /></div>
          <div><p className="label mb-1">Escalation rules</p><textarea className="input" rows={2} {...f('escalation_rules')} /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><p className="label mb-1">Voice (Piper model on the gateway)</p><input className="input" placeholder="default" {...f('voice')} /></div>
            <div><p className="label mb-1">Language</p><input className="input" {...f('language')} /></div>
          </div>
          <div>
            <p className="label mb-1">CRM tools this agent may use</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(TOOL_LABELS).map(([t, label]) => {
                const on = (edit.allowed_tools || []).includes(t);
                return <button key={t} type="button" onClick={() => setEdit({ ...edit, allowed_tools: on ? edit.allowed_tools.filter((x) => x !== t) : [...(edit.allowed_tools || []), t] })}
                  className={`rounded-full px-3 py-1 text-xs ${on ? 'bg-blue-500/25 text-blue-200' : 'bg-white/5 text-gray-400'}`}>{label}</button>;
              })}
            </div>
            <p className="mt-1 text-[11px] text-gray-500">Customer lookup, owner approvals, opt-out and ending the call are always available.</p>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.can_call_out} onChange={(e) => setEdit({ ...edit, can_call_out: e.target.checked })} /> May place outbound calls (consented customers only)</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>
          <div className="flex gap-2"><button className="btn-primary" onClick={save}>Save</button><button className="btn-ghost" onClick={() => setEdit(null)}>Cancel</button></div>
        </div>
      )}
    </div>
  );
}

function TestConsole({ agents }) {
  const toast = useToast();
  const [agentId, setAgentId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clients, setClients] = useState([]);
  const [call, setCall] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  useEffect(() => { api('/api/clients?limit=50').then((d) => setClients(Array.isArray(d) ? d : d.clients || [])).catch(() => {}); }, []);
  useEffect(() => { if (!agentId && agents?.length) setAgentId(agents[0].id); }, [agents, agentId]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [call]);
  async function start() {
    try { const r = await api('/api/voice/calls/simulate', { method: 'POST', body: { agent_id: agentId, client_id: clientId || null } }); setCall(r.call); }
    catch (err) { toast(err.message, 'error'); }
  }
  async function send(e) {
    e.preventDefault();
    if (!text.trim() || !call) return;
    setBusy(true);
    try { const r = await api(`/api/voice/calls/${call.id}/turn`, { method: 'POST', body: { text } }); setCall(r.call); setText(''); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  }
  const ended = call && !['AI_ACTIVE', 'CONNECTED', 'ESCALATED'].includes(call.state);
  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <div className={`${glass} p-5 xl:col-span-2`}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base">Test console <span className="ml-2 rounded bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">SIMULATED — no phone call, no CRM changes</span></h2>
        </div>
        {!call ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>{(agents || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            <select className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">Unknown caller</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.business_name}</option>)}</select>
            <button className="btn-primary" onClick={start}>Start test call</button>
          </div>
        ) : (
          <>
            <div className="max-h-[28rem] space-y-2 overflow-y-auto rounded-xl bg-black/25 p-4">
              {(call.transcript || []).map((t, i) => (
                <div key={i} className={`flex ${t.role === 'agent' ? 'justify-start' : 'justify-end'}`}>
                  <p className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${t.role === 'agent' ? 'bg-blue-500/15 text-blue-100' : 'bg-white/10 text-ink'}`}>{t.text}</p>
                </div>
              ))}
              <div ref={end} />
            </div>
            <form onSubmit={send} className="mt-3 flex gap-2">
              <input className="input" placeholder={ended ? `Call ${call.state}` : 'Type what the caller says…'} value={text} onChange={(e) => setText(e.target.value)} disabled={ended || busy} />
              <button className="btn-primary" disabled={ended || busy}>{busy ? '…' : 'Send'}</button>
              <button type="button" className="btn-ghost" onClick={() => setCall(null)}>New</button>
            </form>
          </>
        )}
      </div>
      <div className={`${glass} p-5`}>
        <h2 className="mb-3 text-base">Tools & latency</h2>
        {!call?.events?.length ? <p className="text-sm text-gray-500">Tool calls and response times appear here.</p> : (
          <ul className="space-y-2 text-xs">
            {call.events.map((e) => (
              <li key={e.id} className="rounded-lg bg-black/25 p-2">
                {e.type === 'TOOL' && <><b className={e.data.error ? 'text-red-300' : 'text-cyan-300'}>{e.data.name}</b> <span className="text-gray-500">{JSON.stringify(e.data.input)}</span><p className="mt-1 text-gray-400">→ {e.data.result}</p></>}
                {e.type === 'LATENCY' && <span className="text-gray-400">Reply in <b className="text-ink">{e.data.turn_ms} ms</b> ({e.data.provider})</span>}
                {e.type === 'ERROR' && <span className="text-red-300">{e.data.message}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Calls() {
  const [filter, setFilter] = useState('LIVE');
  const { data: calls } = usePolling(() => api(`/api/voice/calls?mode=${filter}`), 10000, [filter]);
  const { data: stats } = usePolling(() => api(`/api/voice/analytics${filter === 'SIMULATED' ? '?include_simulated=1' : ''}`), 30000, [filter]);
  const [open, setOpen] = useState(null);
  return (
    <div className="space-y-5">
      <div className="flex gap-2">{['LIVE', 'SIMULATED'].map((m) => <button key={m} onClick={() => setFilter(m)} className={`rounded-full px-3 py-1 text-xs ${filter === m ? 'bg-blue-500/25 text-blue-200' : 'bg-white/5 text-gray-400'}`}>{m === 'LIVE' ? 'Real calls' : 'Simulated'}</button>)}</div>
      {stats && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          {[['Total', stats.total], ['Inbound', stats.inbound], ['Outbound', stats.outbound], ['Answer rate', stats.answer_rate == null ? '—' : `${stats.answer_rate}%`],
            ['Avg reply', stats.avg_turn_latency_ms ? `${stats.avg_turn_latency_ms} ms` : '—'], ['AI cost (est.)', `$${stats.est_ai_cost_usd}`]].map(([k, v]) => (
            <div key={k} className={`${glass} p-3`}><p className="label">{k}</p><p className="mt-1 text-xl font-bold text-ink">{v}</p></div>
          ))}
        </div>
      )}
      <div className={`${glass} overflow-hidden`}>
        {!calls?.length ? <p className="p-5 text-sm text-gray-500">No {filter === 'LIVE' ? 'real' : 'simulated'} calls yet.</p> : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500"><tr>{['When', 'Agent', 'Direction', 'State', 'Outcome', 'Duration'].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody>{calls.map((c) => (
              <tr key={c.id} onClick={() => setOpen(c.id === open ? null : c.id)} className="cursor-pointer border-t border-white/5 hover:bg-white/[0.03]">
                <td className="px-4 py-2">{fmtDateTime(c.created_at)}</td><td className="px-4 py-2">{c.agent?.name}</td><td className="px-4 py-2">{c.direction}</td>
                <td className="px-4 py-2">{c.state}</td><td className="px-4 py-2">{c.outcome || '—'}</td><td className="px-4 py-2">{c.duration_seconds != null ? `${c.duration_seconds}s` : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {open && <CallDetail id={open} />}
    </div>
  );
}

function CallDetail({ id }) {
  const { data: c } = usePolling(() => api(`/api/voice/calls/${id}`), 4000, [id]);
  const toast = useToast();
  if (!c) return null;
  const live = ['DIALING', 'RINGING', 'CONNECTED', 'AI_ACTIVE', 'ESCALATED', 'QUEUED'].includes(c.state);
  return (
    <div className={`${glass} grid gap-5 p-5 lg:grid-cols-3`}>
      <div className="lg:col-span-2">
        <div className="mb-2 flex items-center justify-between"><h3 className="text-base">Transcript</h3>
          {live && c.mode === 'LIVE' && <button className="rounded-lg bg-red-600 px-3 py-1 text-xs font-bold text-white" onClick={() => api(`/api/voice/calls/${c.id}/hangup`, { method: 'POST' }).then(() => toast('Hanging up…', 'success')).catch((e) => toast(e.message, 'error'))}>Hang up</button>}
        </div>
        <div className="max-h-80 space-y-1.5 overflow-y-auto text-sm">{(c.transcript || []).map((t, i) => <p key={i}><b className={t.role === 'agent' ? 'text-blue-300' : 'text-ink'}>{t.role === 'agent' ? 'Agent' : 'Customer'}:</b> {t.text}{t.final === false && <span className="text-gray-500"> (partial)</span>}</p>)}</div>
      </div>
      <div className="space-y-2 text-sm">
        {c.summary && <p><span className="label">Summary</span><br />{c.summary}</p>}
        {c.next_action && <p><span className="label">Next</span><br />{c.next_action}</p>}
        {c.error && <p className="text-red-300">{c.error}</p>}
        <p className="label mt-3">Timeline</p>
        <ul className="max-h-48 space-y-0.5 overflow-y-auto text-[11px] text-gray-400">{c.events.map((e) => <li key={e.id}>{new Date(e.at).toLocaleTimeString('en-IN')} · {e.type} {e.data?.to || e.data?.name || e.data?.type || ''}</li>)}</ul>
      </div>
    </div>
  );
}

function Knowledge() {
  const toast = useToast();
  const { data: items, reload } = usePolling(() => api('/api/voice/knowledge'), 60000);
  const [f, setF] = useState({ title: '', content: '' });
  async function add(e) {
    e.preventDefault();
    try { await api('/api/voice/knowledge', { method: 'POST', body: f }); setF({ title: '', content: '' }); toast('Added to the knowledge base', 'success'); reload(); }
    catch (err) { toast(err.message, 'error'); }
  }
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <div className="space-y-3">
        <p className="text-sm text-gray-400">Plans and prices come from the proposal system automatically. Add FAQs, objection handling, policies and service details here — every agent uses them.</p>
        {(items || []).map((k) => (
          <div key={k.id} className={`${glass} p-4`}>
            <div className="flex items-center justify-between"><p className="font-semibold text-ink">{k.title}</p>
              <button className="text-xs text-gray-500 hover:text-red-300" onClick={() => api(`/api/voice/knowledge/${k.id}`, { method: 'DELETE' }).then(reload)}>Remove</button></div>
            <p className="mt-1 line-clamp-4 whitespace-pre-line text-xs text-gray-400">{k.content}</p>
          </div>
        ))}
      </div>
      <form onSubmit={add} className={`${glass} space-y-3 p-5`}>
        <h2 className="text-base">Add knowledge</h2>
        <input className="input" placeholder="Title, e.g. FAQ: hosting & domain" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <textarea className="input" rows={10} placeholder="Facts the agents may use. Never put another customer's private details here." value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} />
        <button className="btn-primary" disabled={!f.title || !f.content}>Add</button>
      </form>
    </div>
  );
}

export default function Voice() {
  const [tab, setTab] = useState('Overview');
  const { data: status, reload } = usePolling(() => api('/api/voice/status'), 5000);
  const { data: agents, reload: reloadAgents } = usePolling(() => api('/api/voice/agents'), 60000);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="bg-gradient-to-r from-blue-300 via-cyan-200 to-violet-300 bg-clip-text text-2xl font-bold text-transparent">Infinity Voice</h1>
          <p className="text-sm">AI phone agents on your own POCO C55 + Airtel SIM, connected to your CRM.</p>
        </div>
        <div className="flex flex-wrap gap-1 rounded-xl bg-white/5 p-1">
          {TABS.map((t) => <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${tab === t ? 'bg-gradient-to-r from-blue-500/40 to-violet-500/30 text-white' : 'text-gray-400 hover:text-ink'}`}>{t}</button>)}
        </div>
      </div>
      {tab === 'Overview' && <Overview status={status} reload={reload} />}
      {tab === 'Agents' && <Agents agents={agents} reload={reloadAgents} />}
      {tab === 'Test console' && <TestConsole agents={agents} />}
      {tab === 'Calls' && <Calls />}
      {tab === 'Knowledge' && <Knowledge />}
    </div>
  );
}
