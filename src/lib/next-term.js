// src/lib/next-term.js
// rc-next-term-v1
//
// "Next term begins" — one date per (session, term), stored on
// AcademicSession.nextTermBeginsByTerm as { FIRST: 'YYYY-MM-DD', ... }.
// The key is the term whose report cards print it (the date on a First Term
// card is when Second Term begins; on a Third Term card, the next session).
//
// Dates are plain calendar dates — no time, no timezone — so a date can never
// slip by a day between Lagos (UTC+1) and the server (UTC). Formatting is done
// by hand so it does not depend on the server's locale data.

const TERMS = ['FIRST', 'SECOND', 'THIRD'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// 'YYYY-MM-DD' for a real calendar date → { y, m, d, weekday }, else null.
// Rejects 2027-02-30, 2027-13-01, '12/01/2027', and years outside 2000–2100.
function parseDate(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d, weekday: dt.getUTCDay() };
}

// 'YYYY-MM-DD' → 'Monday, 12 January 2027', or null if it is not a real date.
function formatLong(value) {
  const p = parseDate(value);
  if (!p) return null;
  return `${DAYS[p.weekday]}, ${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

// The stored JSON as a plain object we can safely copy and edit.
function readMap(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const out = {};
  for (const t of TERMS) if (typeof json[t] === 'string' && parseDate(json[t])) out[t] = json[t];
  return out;
}

// What a card for `term` prints after "Next term begins:", or null to leave the line off.
function labelFor(json, term) {
  return formatLong(readMap(json)[term]);
}

module.exports = { TERMS, parseDate, formatLong, readMap, labelFor };
