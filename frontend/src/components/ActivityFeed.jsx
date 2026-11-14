import { Link } from 'react-router-dom';
import { timeAgo, fmtDateTime } from '../lib/format';

function describe(action) {
  const a = action.replace(/_MOCK$/, '');
  const map = {
    CALL_RECEIVED: ['Call received', 'bg-blue-400'],
    TRANSCRIPT_PARSED: ['Transcript analysed', 'bg-cyan-400'],
    MEET_SCHEDULED: ['Google Meet scheduled', 'bg-blue-400'],
    MEET_RESCHEDULED: ['Meeting rescheduled', 'bg-blue-400'],
    PROPOSAL_GENERATED: ['Proposal generated', 'bg-violet-400'],
    WHATSAPP_SENT: ['Proposal sent on WhatsApp', 'bg-emerald-400'],
    SUMMARY_CALL_PLACED: ['Summary call placed', 'bg-emerald-400'],
    SUMMARY_CALL: ['Campaign summary ready', 'bg-emerald-400'],
    CAMPAIGN_STARTED: ['Campaign started', 'bg-blue-400'],
    CLIENT_UPDATED: ['Client updated', 'bg-gray-400'],
    NOTES_UPDATED: ['Notes updated', 'bg-gray-400'],
    PROPOSAL_RESEND_REQUESTED: ['Proposal resend requested', 'bg-violet-400'],
    WEBSITE_READY: ['Website marked ready', 'bg-cyan-400'],
    WEBSITE_LINK_SENT: ['Website link sent on WhatsApp', 'bg-emerald-400'],
    OWNER_CALL_QUOTATION_QUEUED: ['Approval call queued · quotation', 'bg-amber-400'],
    OWNER_CALL_WEBSITE_QUEUED: ['Approval call queued · website', 'bg-amber-400'],
    OWNER_CALL_QUOTATION_PLACED: ['Calling you · quotation', 'bg-amber-400'],
    OWNER_CALL_WEBSITE_PLACED: ['Calling you · website', 'bg-amber-400'],
    OWNER_APPROVED_QUOTATION: ['You approved the quotation', 'bg-emerald-400'],
    OWNER_APPROVED_WEBSITE: ['You approved the website link', 'bg-emerald-400'],
    OWNER_REJECTED_QUOTATION: ['You rejected the quotation', 'bg-red-400'],
    OWNER_REJECTED_WEBSITE: ['You rejected the website link', 'bg-red-400'],
    SUMMARY_CALL_DELIVERED: ['Summary call delivered', 'bg-emerald-400'],
    OWNER_CALL_SUMMARY_QUEUED: ['Summary call queued', 'bg-emerald-400'],
    OWNER_CALL_SUMMARY_PLACED: ['Calling you · campaign summary', 'bg-emerald-400'],
  };
  if (a.endsWith('_ERROR')) return [`Error · ${a.replace(/_ERROR$/, '').replace(/_/g, ' ').toLowerCase()}`, 'bg-red-500'];
  return map[a] || [a.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), 'bg-gray-400'];
}

export default function ActivityFeed({ items = [] }) {
  if (!items.length) return <p className="py-8 text-center text-sm text-gray-500">No activity yet — waiting for the first call.</p>;
  return (
    <ul className="space-y-1">
      {items.map((log) => {
        const [title, dot] = describe(log.action);
        const mock = log.action.endsWith('_MOCK');
        return (
          <li key={log.id} className="flex gap-3 rounded-lg px-2 py-2.5 hover:bg-line/50">
            <span className={`mt-1.5 h-2 w-2 flex-none rounded-full ${dot}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">
                {title}
                {mock && <span className="ml-1.5 rounded bg-amber-500/15 px-1.5 py-px text-[10px] font-semibold uppercase text-amber-300">test mode</span>}
              </p>
              <p className="truncate text-xs text-muted">
                {log.client ? <Link to={`/clients/${log.client.id}`} className="text-blue-400 hover:underline">{log.client.business_name}</Link> : 'System'}
                {' · '}<span title={fmtDateTime(log.timestamp)}>{timeAgo(log.timestamp)}</span>
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
