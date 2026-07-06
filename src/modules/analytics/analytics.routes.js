// src/modules/analytics/analytics.routes.js
// batch-6-analytics-usage
//
// Usage analytics for SCHOOL_ADMIN — the trial→paid conversion lever.
// "Your teachers generated N notes ≈ X hours saved — subscribe to keep it."
//
// UN-GATED by design: this widget drives conversion and costs no AI. It is
// deliberately distinct from Ops-7's Premium CMS_NOTIFICATIONS_ANALYTICS.
// No requirePlan here — only authenticate + authorize('SCHOOL_ADMIN').
//
// Zero migration: pure aggregate counts over existing tables, scoped by
// schoolId, excluding soft-deleted rows.

const router = require('express').Router();
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');

// ── Hours-saved constants ────────────────────────────────────────────────
// batch-6-hours-saved-constants — FOUNDER-TUNABLE marketing estimates.
// These are conservative, defensible-to-a-principal numbers. Change freely.
const HOURS_SAVED = {
  note:   0.75, // ~45 min to hand-write one lesson note
  scheme: 2.0,  // ~2 hrs for a full termly scheme of work
  exam:   1.0,  // ~1 hr to set one exam paper
};

// termLabel mirrors the sessionStamp convention used across artifacts:
//   e.g. "2025/2026 · Term 2"
const TERM_LABEL = { FIRST: 'Term 1', SECOND: 'Term 2', THIRD: 'Term 3' };

function buildSessionStamp(session) {
  if (!session) return null;
  const term = TERM_LABEL[session.currentTerm] || session.currentTerm || '';
  return `${session.name} · ${term}`;
}

// ── GET /api/analytics/usage ─────────────────────────────────────────────
router.get('/usage', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const schoolId = req.user.schoolId;
    if (!schoolId) {
      return res.status(400).json({ error: { message: 'No school context' } });
    }

    // Current session (for this-term scoping + display).
    const session = await prisma.academicSession.findFirst({
      where: { schoolId, isCurrent: true },
      select: { name: true, currentTerm: true },
    });
    const sessionStamp = buildSessionStamp(session);

    const notDeleted = { schoolId, deletedAt: null };
    const termFilter = sessionStamp ? { sessionStamp } : null;

    // All-time counts (soft-deleted excluded). Assessment also has deletedAt.
    // uploadedSchemes: origin === 'uploaded' (Batch 4) — nice for the pitch.
    const [
      notesAll,
      schemesAll,
      uploadedSchemesAll,
      examsAll,
      teacherCount,
    ] = await prisma.$transaction([
      prisma.lessonNote.count({ where: notDeleted }),
      prisma.schemeOfWork.count({ where: notDeleted }),
      prisma.schemeOfWork.count({ where: { ...notDeleted, origin: 'uploaded' } }),
      prisma.assessment.count({ where: notDeleted }),
      prisma.user.count({ where: { schoolId, role: 'TEACHER', revokedAt: null } }),
    ]);

    // This-term counts (only if there is a current session to stamp against).
    let notesTerm = 0, schemesTerm = 0, examsTerm = 0;
    if (termFilter) {
      const [nt, st, et] = await prisma.$transaction([
        prisma.lessonNote.count({ where: { ...notDeleted, ...termFilter } }),
        prisma.schemeOfWork.count({ where: { ...notDeleted, ...termFilter } }),
        prisma.assessment.count({ where: { ...notDeleted, ...termFilter } }),
      ]);
      notesTerm = nt; schemesTerm = st; examsTerm = et;
    }

    const hoursAll =
      notesAll * HOURS_SAVED.note +
      schemesAll * HOURS_SAVED.scheme +
      examsAll * HOURS_SAVED.exam;
    const hoursTerm =
      notesTerm * HOURS_SAVED.note +
      schemesTerm * HOURS_SAVED.scheme +
      examsTerm * HOURS_SAVED.exam;

    return res.json({
      allTime: {
        notes: notesAll,
        schemes: schemesAll,
        uploadedSchemes: uploadedSchemesAll,
        exams: examsAll,
      },
      thisTerm: {
        notes: notesTerm,
        schemes: schemesTerm,
        exams: examsTerm,
      },
      hoursSaved: {
        allTime: Math.round(hoursAll),
        thisTerm: Math.round(hoursTerm),
      },
      teacherCount,
      currentSession: session
        ? { name: session.name, term: TERM_LABEL[session.currentTerm] || session.currentTerm }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
