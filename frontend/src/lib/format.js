const TZ = 'Asia/Kolkata';

export function fmtDateTime(d) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: TZ, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(d));
}

export function fmtDate(d) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d));
}

export function fmtMeeting(d) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(d)) + ' IST';
}

export function timeAgo(d) {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const OUTCOME_LABEL = { BOOKED: 'Booked', REJECTED: 'Rejected', NO_ANSWER: 'No answer', CALLBACK_LATER: 'Callback' };
export const PLAN_LABEL = { BASIC: 'Basic', PREMIUM: 'Premium', ADVANCED: 'Advanced', UNKNOWN: 'Unknown' };
export const PORTAL_LABEL = {
  NEW_LEAD: 'New lead', PROPOSAL_SENT: 'Proposal sent', MEETING_SCHEDULED: 'Meeting scheduled', CONVERTED: 'Converted', LOST: 'Lost',
};
