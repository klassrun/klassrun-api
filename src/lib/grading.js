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

// ── grading-config-v1 ────────────────────────────────────────────────────────
// A school can set its own score breakdown ("parts"): 1-6 named parts whose
// maxima total exactly 100, e.g. [{ label: 'CA', max: 40 }, { label: 'Exam', max: 60 }].
// Part i is stored in ResultEntry slot SLOT_KEYS[i]. A term freezes the
// breakdown on its first saved score (see grading-config.js). With no breakdown
// set, everything below reproduces SCORE_MAX / COMPONENTS above exactly.
const SLOT_KEYS = Object.freeze(['ca1', 'ca2', 'objective', 'theory', 'score5', 'score6']);
const DEFAULT_PARTS = Object.freeze([
  Object.freeze({ label: 'CA1', max: 20 }),
  Object.freeze({ label: 'CA2', max: 20 }),
  Object.freeze({ label: 'Obj', max: 20 }),
  Object.freeze({ label: 'Theory', max: 40 }),
]);
const MAX_PARTS = SLOT_KEYS.length;
const PART_LABEL_MAX = 12;

// Validate an admin-supplied breakdown. Returns { ok, parts } or { ok: false, error }.
function validateBreakdown(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'parts must be a list' };
  if (list.length < 1 || list.length > MAX_PARTS) return { ok: false, error: `Use between 1 and ${MAX_PARTS} parts` };
  const parts = [];
  const seen = new Set();
  let sum = 0;
  for (const p of list) {
    const label = p && typeof p.label === 'string' ? p.label.trim() : '';
    if (label.length < 1 || label.length > PART_LABEL_MAX) {
      return { ok: false, error: `Each part needs a short name (1-${PART_LABEL_MAX} characters), e.g. CA1, Test, Exam` };
    }
    const k = label.toLowerCase();
    if (seen.has(k)) return { ok: false, error: `Two parts are both called "${label}"` };
    seen.add(k);
    const max = Number(p && p.max);
    if (!Number.isInteger(max) || max < 1 || max > 100) {
      return { ok: false, error: `${label}: the maximum must be a whole number from 1 to 100` };
    }
    sum += max;
    parts.push({ label, max });
  }
  if (sum !== 100) return { ok: false, error: `The parts add up to ${sum}. They must add up to exactly 100.` };
  return { ok: true, parts };
}

// parts ([{label,max}] or null) -> [{ key, label, max }] mapped onto storage slots.
function componentsFor(parts) {
  const src = Array.isArray(parts) && parts.length > 0 ? parts.slice(0, MAX_PARTS) : DEFAULT_PARTS;
  return src.map((p, i) => ({ key: SLOT_KEYS[i], label: String(p.label), max: Number(p.max) }));
}

function isDefaultComponents(components) {
  if (!Array.isArray(components) || components.length !== DEFAULT_PARTS.length) return false;
  return components.every((c, i) => c && c.key === SLOT_KEYS[i]
    && c.label === DEFAULT_PARTS[i].label && Number(c.max) === DEFAULT_PARTS[i].max);
}

// Validate one score against its part. Empty/missing -> 0 (same rule as validateComponent).
function validateScore(component, value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: 0 };
  const n = Number(value);
  if (!Number.isInteger(n)) return { ok: false, error: `${component.label} must be a whole number` };
  if (n < 0 || n > component.max) return { ok: false, error: `${component.label} must be between 0 and ${component.max}` };
  return { ok: true, value: n };
}

function computeTotalFor(components, values) {
  return components.reduce((sum, c) => sum + (Number(values[c.key]) || 0), 0);
}

// { slotKey: max } — for the default breakdown this equals SCORE_MAX, key order included.
function scoreMaxFor(components) {
  const out = {};
  components.forEach((c) => { out[c.key] = c.max; });
  return out;
}

module.exports = {
  SCORE_MAX,
  TOTAL_MAX,
  GRADE_BANDS,
  COMPONENTS,
  validateComponent,
  computeTotal,
  gradeFor,
  // grading-config-v1
  SLOT_KEYS,
  DEFAULT_PARTS,
  MAX_PARTS,
  validateBreakdown,
  componentsFor,
  isDefaultComponents,
  validateScore,
  computeTotalFor,
  scoreMaxFor,
};
