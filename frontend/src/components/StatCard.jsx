import Icon from './Icon';

const ACCENTS = {
  green: { ring: 'from-emerald-500/20', icon: 'bg-emerald-500/15 text-emerald-400' },
  blue: { ring: 'from-blue-500/20', icon: 'bg-blue-500/15 text-blue-400' },
  purple: { ring: 'from-violet-500/20', icon: 'bg-violet-500/15 text-violet-400' },
  red: { ring: 'from-red-500/20', icon: 'bg-red-500/15 text-red-400' },
};

export default function StatCard({ label, value, icon, color = 'blue', hint }) {
  const a = ACCENTS[color];
  return (
    <div className={`card relative overflow-hidden p-5`}>
      <div className={`pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full bg-gradient-to-br ${a.ring} to-transparent blur-xl`} />
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-muted">{label}</p>
          <p className="mt-2 text-3xl font-bold tabular-nums text-ink">{value ?? '—'}</p>
          {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
        </div>
        <div className={`rounded-lg p-2.5 ${a.icon}`}><Icon name={icon} className="h-5 w-5" /></div>
      </div>
    </div>
  );
}
