import { OUTCOME_LABEL, PLAN_LABEL, PORTAL_LABEL } from '../lib/format';

const TONES = {
  green: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  blue: 'bg-blue-500/15 text-blue-300 ring-blue-500/30',
  purple: 'bg-violet-500/15 text-violet-300 ring-violet-500/30',
  amber: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  red: 'bg-red-500/15 text-red-300 ring-red-500/30',
  gray: 'bg-gray-500/15 text-gray-300 ring-gray-500/30',
  cyan: 'bg-cyan-500/15 text-cyan-300 ring-cyan-500/30',
};

export function Badge({ tone = 'gray', children }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>
      {children}
    </span>
  );
}

const OUTCOME_TONE = { BOOKED: 'green', REJECTED: 'red', NO_ANSWER: 'gray', CALLBACK_LATER: 'amber' };
const PLAN_TONE = { BASIC: 'cyan', PREMIUM: 'blue', ADVANCED: 'purple', UNKNOWN: 'gray' };
const PORTAL_TONE = { NEW_LEAD: 'gray', PROPOSAL_SENT: 'purple', MEETING_SCHEDULED: 'blue', CONVERTED: 'green', LOST: 'red' };

export const OutcomeBadge = ({ value }) => <Badge tone={OUTCOME_TONE[value]}>{OUTCOME_LABEL[value] || value}</Badge>;
export const PlanBadge = ({ value }) => <Badge tone={PLAN_TONE[value]}>{PLAN_LABEL[value] || value}</Badge>;
export const PortalBadge = ({ value }) => <Badge tone={PORTAL_TONE[value]}>{PORTAL_LABEL[value] || value}</Badge>;
