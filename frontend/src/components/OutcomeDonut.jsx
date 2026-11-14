import { useState } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';

// Status colours from the design system. Identity never relies on colour alone:
// every segment is listed in the legend with its label, count and share.
const SEGMENTS = [
  { key: 'total_booked', label: 'Booked', color: '#10B981' },
  { key: 'total_callback', label: 'Callback later', color: '#F59E0B' },
  { key: 'total_rejected', label: 'Rejected', color: '#EF4444' },
  { key: 'total_no_answer', label: 'No answer', color: '#6B7280' },
];

function TooltipBox({ active, payload, total }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-line bg-navy px-3 py-2 text-xs shadow-xl">
      <p className="font-semibold text-ink">{p.label}</p>
      <p className="text-muted">{p.value} calls · {total ? Math.round((p.value / total) * 100) : 0}%</p>
    </div>
  );
}

export default function OutcomeDonut({ data }) {
  const [active, setActive] = useState(null);
  const rows = SEGMENTS.map((s) => ({ ...s, value: data?.[s.key] || 0 }));
  const total = rows.reduce((a, r) => a + r.value, 0);

  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row">
      <div className="relative h-44 w-44 flex-none">
        {total > 0 ? (
          <ResponsiveContainer>
            <PieChart>
              <Pie data={rows.filter((r) => r.value > 0)} dataKey="value" nameKey="label" innerRadius="68%" outerRadius="100%"
                paddingAngle={rows.filter((r) => r.value > 0).length > 1 ? 2 : 0} cornerRadius={4} stroke="#111827" strokeWidth={2}
                startAngle={90} endAngle={-270} isAnimationActive={false}
                onMouseEnter={(_, i) => setActive(i)} onMouseLeave={() => setActive(null)}>
                {rows.filter((r) => r.value > 0).map((r, i) => (
                  <Cell key={r.key} fill={r.color} opacity={active === null || active === i ? 1 : 0.45} />
                ))}
              </Pie>
              <Tooltip content={<TooltipBox total={total} />} />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full w-full rounded-full border-[18px] border-line" />
        )}
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <p className="text-3xl font-bold tabular-nums text-ink">{data?.conversion_rate ?? 0}%</p>
            <p className="text-xs text-muted">conversion</p>
          </div>
        </div>
      </div>
      <ul className="w-full space-y-2.5">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-3 text-sm">
            <span className="h-2.5 w-2.5 flex-none rounded-sm" style={{ background: r.color }} />
            <span className="flex-1 whitespace-nowrap text-muted">{r.label}</span>
            <span className="font-semibold tabular-nums text-ink">{r.value}</span>
            <span className="w-10 text-right text-xs tabular-nums text-gray-500">{total ? Math.round((r.value / total) * 100) : 0}%</span>
          </li>
        ))}
        <li className="flex items-center gap-3 border-t border-line pt-2.5 text-sm">
          <span className="flex-1 text-muted">Total calls</span>
          <span className="font-semibold tabular-nums text-ink">{total}</span>
          <span className="w-10" />
        </li>
      </ul>
    </div>
  );
}
