// src/modules/portal/portal-data.controller.js
// ops-5b-portal-data-controller
//
// Portal READ endpoints. Every handler is scoped to req.portalStudent, which
// authenticatePortal (5a) sets from the verified portal JWT. Report cards are
// served ONLY when locked — the school controls exactly what a parent sees by
// locking. No recompute: the frozen ReportCard.snapshot already carries
// results, subject positions, attendance, behaviour, comments and the
// cumulative average (#37). Fees are status-only (#47): absence of a PAID row
// means UNPAID.

const prisma = require('../../config/db');

const TERMS = ['FIRST', 'SECOND', 'THIRD'];

async function currentSession(schoolId) {
  return prisma.academicSession.findFirst({
    where: { schoolId, isCurrent: true },
    select: { id: true, name: true, currentTerm: true },
  });
}

// ── GET /api/portal/me ──────────────────────────────────────────────────────
const portalMe = async (req, res, next) => {
  try {
    const s = req.portalStudent;
    const session = await currentSession(s.schoolId);
    res.json({
      student: {
        id: s.id,
        admissionNumber: s.admissionNumber,
        firstName: s.firstName,
        lastName: s.lastName,
        className: s.className,
      },
      school: {
        id: s.school ? s.school.id : s.schoolId,
        name: s.school ? s.school.name : null,
        slug: s.school ? s.school.slug : null,
      },
      currentSession: session
        ? { id: session.id, name: session.name, currentTerm: session.currentTerm }
        : null,
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/portal/report-cards ────────────────────────────────────────────
// Locked cards only, newest first. Light list (summary + whether a PDF exists).
const portalReportCards = async (req, res, next) => {
  try {
    const s = req.portalStudent;
    const cards = await prisma.reportCard.findMany({
      where: { schoolId: s.schoolId, studentId: s.id, lockedAt: { not: null } },
      orderBy: { createdAt: 'desc' },
      include: { session: { select: { id: true, name: true } } },
    });
    res.json({
      reportCards: cards.map((c) => ({
        id: c.id,
        term: c.term,
        session: c.session,
        sessionId: c.sessionId,
        lockedAt: c.lockedAt,
        pdfUrl: c.pdfUrl || null,
        hasPdf: !!c.pdfUrl,
        summary: (c.snapshot && c.snapshot.summary) || null,
      })),
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/portal/report-cards/:id ────────────────────────────────────────
// One locked card belonging to THIS student. 404 otherwise — never leak the
// existence of another student's (or an unlocked) card.
const portalReportCard = async (req, res, next) => {
  try {
    const s = req.portalStudent;
    const card = await prisma.reportCard.findFirst({
      where: { id: req.params.id, schoolId: s.schoolId, studentId: s.id, lockedAt: { not: null } },
      include: { session: { select: { id: true, name: true } } },
    });
    if (!card) return res.status(404).json({ error: { message: 'Report card not available' } });
    res.json({
      reportCard: {
        id: card.id,
        term: card.term,
        session: card.session,
        lockedAt: card.lockedAt,
        pdfUrl: card.pdfUrl || null,
        hasPdf: !!card.pdfUrl,
        snapshot: card.snapshot,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET /api/portal/fees ────────────────────────────────────────────────────
// Status-only, for the current session's three terms.
const portalFees = async (req, res, next) => {
  try {
    const s = req.portalStudent;
    const session = await currentSession(s.schoolId);
    if (!session) return res.json({ session: null, currentTerm: null, terms: [] });

    const records = await prisma.feeRecord.findMany({
      where: { schoolId: s.schoolId, studentId: s.id, sessionId: session.id },
      select: { term: true, status: true },
    });
    const byTerm = {};
    records.forEach((r) => { byTerm[r.term] = r.status; });

    res.json({
      session: { id: session.id, name: session.name },
      currentTerm: session.currentTerm,
      terms: TERMS.map((t) => ({ term: t, status: byTerm[t] === 'PAID' ? 'PAID' : 'UNPAID' })),
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { portalMe, portalReportCards, portalReportCard, portalFees };
