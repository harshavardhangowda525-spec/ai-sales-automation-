// India Standard Time helpers. IST is a fixed UTC+05:30 offset (no DST), which keeps
// the arithmetic simple and exact.
const IST_OFFSET_MIN = 330;
const TZ = 'Asia/Kolkata';

/** Calendar parts (year, month 0-11, day, weekday 0-6, hour, minute) of an instant, in IST. */
function istParts(date = new Date()) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MIN * 60000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** Build a Date for a wall-clock time in IST. Month is 0-based; overflowing days roll over. */
function istDate(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month, day, hour, minute) - IST_OFFSET_MIN * 60000);
}

/** DD/MM/YYYY (Indian format). */
function formatDateIN(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(date);
}

/** e.g. "Monday, 16 Nov 2026 at 10:00 AM IST" */
function formatMeetingTime(date) {
  if (!date) return 'To be confirmed';
  const day = new Intl.DateTimeFormat('en-IN', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short', year: 'numeric',
  }).format(date);
  const time = new Intl.DateTimeFormat('en-IN', {
    timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date).toUpperCase();
  return `${day} at ${time} IST`;
}

/** ISO-8601 string with +05:30 offset, e.g. 2026-11-16T10:00:00+05:30 */
function toISTISOString(date) {
  const p = istParts(date);
  const pad = (n) => String(n).padStart(2, '0');
  const s = new Date(date.getTime() + IST_OFFSET_MIN * 60000).getUTCSeconds();
  return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(s)}+05:30`;
}

module.exports = { TZ, istParts, istDate, formatDateIN, formatMeetingTime, toISTISOString };
