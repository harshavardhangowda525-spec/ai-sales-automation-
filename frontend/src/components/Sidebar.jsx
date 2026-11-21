import { NavLink } from 'react-router-dom';
import Icon from './Icon';

const NAV = [
  { to: '/', label: 'Overview', icon: 'grid', end: true },
  { to: '/clients', label: 'Clients', icon: 'users' },
  { to: '/calendar', label: 'Calendar', icon: 'calendar' },
  { to: '/campaigns', label: 'Campaigns', icon: 'phone' },
  { to: '/whatsapp', label: 'WhatsApp', icon: 'send' },
  { to: '/contacts', label: 'Contacts', icon: 'users' },
  { to: '/reels', label: 'Reels', icon: 'send' },
  { to: '/voice', label: 'Infinity Voice', icon: 'phone' },
];

const linkClass = ({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
  isActive ? 'bg-primary/15 text-blue-300' : 'text-muted hover:bg-line hover:text-ink'}`;

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 text-lg font-bold text-white">∞</div>
      <div className="leading-tight">
        <p className="text-sm font-bold text-ink">Infinity Web & Apps</p>
        <p className="text-[11px] text-muted">Sales automation</p>
      </div>
    </div>
  );
}

export default function Sidebar({ onLogout }) {
  return (
    <>
      {/* Desktop */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-line bg-card/60 p-4 lg:flex">
        <Brand />
        <nav className="mt-8 space-y-1">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={linkClass}>
              <Icon name={n.icon} /> {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-3">
          <div className="rounded-lg border border-line p-3 text-xs text-muted">
            <p className="font-semibold text-ink">Live pipeline</p>
            <p className="mt-1">Sarvam → Meet → Proposal → WhatsApp. Refreshes automatically.</p>
          </div>
          {onLogout && (
            <button onClick={onLogout} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted hover:bg-line hover:text-ink">
              <Icon name="logout" /> Sign out
            </button>
          )}
        </div>
      </aside>

      {/* Mobile */}
      <header className="sticky top-0 z-20 border-b border-line bg-navy/90 px-4 py-3 backdrop-blur lg:hidden">
        <div className="flex items-center justify-between">
          <Brand />
          {onLogout && <button onClick={onLogout} className="text-muted" aria-label="Sign out"><Icon name="logout" className="h-5 w-5" /></button>}
        </div>
        <nav className="mt-3 flex gap-1 overflow-x-auto">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={linkClass}>
              <Icon name={n.icon} /> {n.label}
            </NavLink>
          ))}
        </nav>
      </header>
    </>
  );
}
