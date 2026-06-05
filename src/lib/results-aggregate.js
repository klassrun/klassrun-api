// src/lib/results-aggregate.js
// ops-3-results-aggregate
//
// Pure cross-term aggregation. Single source of truth for "cumulative
// average" so promotion eligibility and report-card /generate compute the
// SAME number from the SAME formula — no drift.
//
// A term's average is (sum of subject totals) / (subject count), matching
// the per-term average report-card /generate already computes. The cumulative
// average is the mean of the term averages for the terms that have results,
// up to and including a target term. Rounded to 2dp. null when no results.

const TERM_ORDER = Object.freeze({ FIRST: 1, SECOND: 2, THIRD: 3 });

// All terms at or before `term`, in chronological order. Unknown term → [].
function termsUpTo(term) {
  const max = TERM_ORDER[String(term || '').toUpperCase()] || 0;
  if (max === 0) return [];
  return Object.keys(TERM_ORDER).filter((t) => TERM_ORDER[t] <= max);
}

// entries: [{ term, total }] for ONE student (any subset of terms/subjects).
// → [{ term, average, subjectsCount }] in chronological term order,
//   only for terms that actually have entries.
function perTermAverages(entries) {
  const byTerm = {};
  for (const e of entries || []) {
    const t = String(e.term || '').toUpperCase();
    if (!TERM_ORDER[t]) continue;
    (byTerm[t] = byTerm[t] || []).push(Number(e.total) || 0);
  }
  const out = [];
  for (const term of Object.keys(TERM_ORDER)) {
    const totals = byTerm[term];
    if (!totals || totals.length === 0) continue;
    const sum = totals.reduce((a, b) => a + b, 0);
    const average = Math.round((sum / totals.length) * 100) / 100;
    out.push({ term, average, subjectsCount: totals.length });
  }
  return out;
}

// perTerm: output of perTermAverages → mean of the term averages, 2dp, or null.
function cumulativeAverage(perTerm) {
  if (!Array.isArray(perTerm) || perTerm.length === 0) return null;
  const sum = perTerm.reduce((a, t) => a + (Number(t.average) || 0), 0);
  return Math.round((sum / perTerm.length) * 100) / 100;
}

module.exports = {
  TERM_ORDER,
  termsUpTo,
  perTermAverages,
  cumulativeAverage,
};
