// src/lib/curriculum-context.js
//
// Batch 3 Phase 3.4 — NERDC curriculum alignment.
//
// PURE module. NO Prisma import by design: the route does the
// `prisma.curriculumTopic.findMany(...)` query (it already has the
// singleton) and passes the resulting rows in here. That keeps anthropic.js
// — which consumes the formatted string — fully fake-repo testable.
//
// What this module does:
//   • Normalize teacher/school inputs to the canonical seed keys
//     (so "Maths"/"JSS 2A"/"first" line up with the seeded rows).
//   • Pick the best-matching row for a free-typed practice topic.
//   • Format a labelled USER-message context block for injection.
//
// What this module must NEVER do:
//   • Touch the system prompts / guardrails (those are untouched in 3.4).
//   • Override the teacher's typed topic. Curriculum is additive REFERENCE;
//     the block explicitly tells the model the teacher's topic wins.
//
// batch-3-phase-3d-curriculum-context

'use strict';

// ── Canonical seed subject keys ───────────────────────────────────────────
// These MUST match the `subject` column values in the curriculum seed.
const SUBJECT_MATHEMATICS   = 'Mathematics';
const SUBJECT_ENGLISH       = 'English Studies';
const SUBJECT_BASIC_SCIENCE = 'Basic Science';
const SUBJECT_SOCIAL        = 'Social Studies';

// Map common variants → canonical key. Lowercased, punctuation-stripped.
const SUBJECT_ALIASES = {
  'maths':                       SUBJECT_MATHEMATICS,
  'math':                        SUBJECT_MATHEMATICS,
  'mathematics':                 SUBJECT_MATHEMATICS,
  'general mathematics':         SUBJECT_MATHEMATICS,

  'english':                     SUBJECT_ENGLISH,
  'english language':            SUBJECT_ENGLISH,
  'english studies':             SUBJECT_ENGLISH,
  'use of english':              SUBJECT_ENGLISH,

  'basic science':               SUBJECT_BASIC_SCIENCE,
  'basic sci':                   SUBJECT_BASIC_SCIENCE,
  'integrated science':          SUBJECT_BASIC_SCIENCE,
  'intermediate science':        SUBJECT_BASIC_SCIENCE,
  'basic science and technology':SUBJECT_BASIC_SCIENCE,
  'basic science & technology':  SUBJECT_BASIC_SCIENCE,

  'social studies':              SUBJECT_SOCIAL,
  'social study':                SUBJECT_SOCIAL,
  'social and citizenship studies': SUBJECT_SOCIAL,
  'social & citizenship studies':   SUBJECT_SOCIAL,
  'national values':             SUBJECT_SOCIAL,
};

function _clean(s) {
  if (typeof s !== 'string') return '';
  return s.trim().toLowerCase().replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a subject name to the canonical seed key.
 * Returns the canonical key if known, otherwise the trimmed original
 * (so an unknown subject simply finds no rows → graceful fallback).
 */
function normalizeSubject(name) {
  const key = _clean(name);
  if (!key) return '';
  if (SUBJECT_ALIASES[key]) return SUBJECT_ALIASES[key];
  // tolerate a trailing "&"/"and technology" etc. already covered above;
  // last resort, return original trimmed string for an exact-name school.
  return typeof name === 'string' ? name.trim() : '';
}

/**
 * Normalize a class name to the canonical seed key.
 * Strips arm suffixes and stream labels:
 *   "JSS 1A" -> "JSS 1", "Jss2 B" -> "JSS 2", "JSS3" -> "JSS 3",
 *   "SS 2 Science" -> "SS 2", "SSS1" -> "SS 1".
 * Returns the trimmed original if it doesn't look like a JSS/SS class
 * (→ no rows → graceful fallback).
 */
function normalizeClass(name) {
  if (typeof name !== 'string') return '';
  const raw = name.trim();
  // Capture JSS|JS|SSS|SS + a digit 1-3, ignoring spaces and following arm/stream text.
  const m = raw.match(/^\s*(jss|js|sss|ss)\s*([1-3])/i);
  if (!m) return raw;
  let band = m[1].toLowerCase();
  const num = m[2];
  if (band === 'js')  band = 'jss';
  if (band === 'sss') band = 'ss';
  return (band === 'jss' ? 'JSS ' : 'SS ') + num;
}

/**
 * Normalize a term to the canonical enum-style key: FIRST | SECOND | THIRD.
 * Accepts "FIRST"/"first"/"1"/"term 1"/"1st", etc. Unknown → '' (no match).
 */
function normalizeTerm(t) {
  if (t == null) return '';
  const k = String(t).trim().toLowerCase();
  if (!k) return '';
  if (k === 'first'  || k === '1' || k === '1st' || k === 'term 1' || k === 'first term')  return 'FIRST';
  if (k === 'second' || k === '2' || k === '2nd' || k === 'term 2' || k === 'second term') return 'SECOND';
  if (k === 'third'  || k === '3' || k === '3rd' || k === 'term 3' || k === 'third term')  return 'THIRD';
  return '';
}

// ── token helpers for fuzzy matching ──────────────────────────────────────
const _STOP = new Set([
  'the','a','an','of','and','or','to','in','on','for','with','at','by',
  'introduction','intro','basic','simple','revision','review','part','i','ii','iii',
]);

function _tokens(s) {
  if (typeof s !== 'string') return [];
  return _clean(s)
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !_STOP.has(w));
}

function _rowTokens(row) {
  if (!row || typeof row !== 'object') return [];
  let toks = _tokens(row.topic);
  const subs = row.subtopics;
  if (Array.isArray(subs)) {
    for (const s of subs) toks = toks.concat(_tokens(typeof s === 'string' ? s : ''));
  }
  return toks;
}

/**
 * Pick the single best-matching curriculum row for a free-typed topic.
 * Score = count of shared distinctive tokens between the typed topic and
 * each row's (topic + subtopics). Ties broken by earliest week.
 * Returns the row, or null if `rows` is empty / no token overlap at all.
 */
function bestTopicMatch(rows, topic) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const want = new Set(_tokens(topic));
  if (want.size === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const rowToks = _rowTokens(row);
    let score = 0;
    const seen = new Set();
    for (const tk of rowToks) {
      if (want.has(tk) && !seen.has(tk)) { score += 1; seen.add(tk); }
    }
    if (score > bestScore) {
      bestScore = score;
      best = row;
    } else if (score === bestScore && score > 0 && best && row && typeof row.week === 'number' && typeof best.week === 'number' && row.week < best.week) {
      best = row;
    }
  }
  return bestScore > 0 ? best : null;
}

// ── block formatting ──────────────────────────────────────────────────────
const HEADER = '── CURRICULUM REFERENCE (for alignment only — the Topic above takes priority) ──';
const FOOTER = "If the teacher's stated topic differs from the prescribed curriculum, follow the teacher's topic but keep alignment where it naturally fits.";

function _objectivesLine(objectives) {
  if (!Array.isArray(objectives) || objectives.length === 0) return null;
  return 'Objectives: ' + objectives.map((o) => String(o).trim()).filter(Boolean).join('; ');
}

function _subtopicsLine(subtopics) {
  if (!Array.isArray(subtopics) || subtopics.length === 0) return null;
  return 'Sub-topics: ' + subtopics.map((s) => String(s).trim()).filter(Boolean).join('; ');
}

function _renderRow(row, opts) {
  const lines = [];
  const wk = (opts && opts.showWeek && typeof row.week === 'number') ? `Week ${row.week}: ` : '';
  if (row.topic) lines.push(`  ${wk}${String(row.topic).trim()}`);
  const sub = _subtopicsLine(row.subtopics);
  if (sub) lines.push(`    ${sub}`);
  const obj = _objectivesLine(row.objectives);
  if (obj) lines.push(`    ${obj}`);
  return lines.join('\n');
}

/**
 * Build the labelled context block to inject into the USER message.
 *
 * @param {Object}   p
 * @param {Array}    p.rows   - CurriculumTopic rows for (subject, class, term).
 * @param {string}   p.mode   - 'lesson' | 'term' | 'practice'
 * @param {number|null} [p.week]  - exact week (lesson mode)
 * @param {string}   [p.topic] - the teacher's typed topic (practice / lesson fallback)
 *
 * @returns {string|null} the block, or null when there is nothing to inject
 *                        (caller then proceeds with no curriculum — graceful).
 *
 * Rules:
 *   • lesson:   exact week row if week given & found; else best topic match
 *               over the term's rows; else null.
 *   • term:     all rows for the term, week-ordered.
 *   • practice: single best topic match; else null.
 */
function buildContextBlock(p) {
  const rows = (p && Array.isArray(p.rows)) ? p.rows : [];
  if (rows.length === 0) return null;
  const mode = p && p.mode;

  if (mode === 'term') {
    const sorted = rows.slice().sort((a, b) => (a.week || 0) - (b.week || 0));
    const body = sorted.map((r) => _renderRow(r, { showWeek: true })).filter(Boolean);
    if (body.length === 0) return null;
    return [HEADER, 'Prescribed topics for this class, subject and term:', ...body, FOOTER].join('\n');
  }

  if (mode === 'practice') {
    const row = bestTopicMatch(rows, p && p.topic);
    if (!row) return null;
    return [HEADER, 'Closest prescribed topic for this subject and term:', _renderRow(row, { showWeek: true }), FOOTER].join('\n');
  }

  // default: lesson
  let row = null;
  const wk = p && p.week;
  if (wk != null && wk !== '') {
    const n = Number(wk);
    row = rows.find((r) => Number(r.week) === n) || null;
  }
  if (!row) {
    // blank-week (or week with no row) → fuzzy fallback over the term's rows
    row = bestTopicMatch(rows, p && p.topic);
  }
  if (!row) return null;
  const intro = (typeof row.week === 'number')
    ? `Prescribed for this class and subject, Week ${row.week}:`
    : 'Closest prescribed topic for this class, subject and term:';
  return [HEADER, intro, _renderRow(row, { showWeek: false }), FOOTER].join('\n');
}

module.exports = {
  normalizeSubject,
  normalizeClass,
  normalizeTerm,
  bestTopicMatch,
  buildContextBlock,
  // exported for tests
  _internals: { _clean, _tokens, SUBJECT_MATHEMATICS, SUBJECT_ENGLISH, SUBJECT_BASIC_SCIENCE, SUBJECT_SOCIAL },
};
