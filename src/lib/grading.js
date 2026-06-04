// src/lib/grading.js
// ops-1-grading
//
// Single source of truth for score component maxima and grade bands.
// Per-school configuration is DEFERRED — to support it later, swap these
// frozen constants for a per-school row lookup. No route logic changes.

const SCORE_MAX = Object.freeze({
  ca1: 20,
  ca2: 20,
  objective: 20,
  theory: 40,
});

const TOTAL_MAX = Object.values(SCORE_MAX).reduce((a, b) => a + b, 0); // 100

// Highest band first. `min` is the inclusive lower bound on the total score.
const GRADE_BANDS = Object.freeze([
  { min: 75, grade: 'A', remark: 'Excellent' },
  { min: 60, grade: 'B', remark: 'Very Good' },
  { min: 50, grade: 'C', remark: 'Good' },
  { min: 45, grade: 'D', remark: 'Pass' },
  { min: 40, grade: 'E', remark: 'Weak Pass' },
  { min: 0,  grade: 'F', remark: 'Fail' },
]);

const COMPONENTS = Object.keys(SCORE_MAX);

// Validate & clamp one component. Empty/missing → 0. Returns {ok, value} or {ok:false,error}.
function validateComponent(field, value) {
  if (!(field in SCORE_MAX)) {
    return { ok: false, error: `Unknown score component: ${field}` };
  }
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: 0 };
  }
  const n = Number(value);
  if (!Number.isInteger(n)) {
    return { ok: false, error: `${field} must be a whole number` };
  }
  if (n < 0 || n > SCORE_MAX[field]) {
    return { ok: false, error: `${field} must be between 0 and ${SCORE_MAX[field]}` };
  }
  return { ok: true, value: n };
}

function computeTotal(components) {
  return COMPONENTS.reduce((sum, key) => sum + (Number(components[key]) || 0), 0);
}

function gradeFor(total) {
  const band =
    GRADE_BANDS.find((b) => total >= b.min) || GRADE_BANDS[GRADE_BANDS.length - 1];
  return { grade: band.grade, remark: band.remark };
}

module.exports = {
  SCORE_MAX,
  TOTAL_MAX,
  GRADE_BANDS,
  COMPONENTS,
  validateComponent,
  computeTotal,
  gradeFor,
};
