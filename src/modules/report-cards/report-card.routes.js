// src/modules/report-cards/report-card.routes.js
// ops-1-report-card-routes
//
// Operations 1 — Report cards. Mounted at /api/report-cards.
//   POST /api/report-cards/generate     compute positions across a class + persist
//                                        one ReportCard per student (SCHOOL_ADMIN)
//   GET  /api/report-cards?classId=&sessionId=&term=   list (any auth)
//   GET  /api/report-cards/:id          one (snapshot) (any auth)
//   POST /api/report-cards/:id/pdf      pdfkit render → Cloudinary → set pdfUrl (SCHOOL_ADMIN)
//   POST /api/report-cards/:id/lock     freeze the card (SCHOOL_ADMIN)
//
// Persist-before-respond. Attendance + behavioural + comments render as
// structured "—" placeholders (data populated in Ops 2).

const router = require('express').Router();
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');
const grading = require('../../lib/grading');
const cloudinaryLib = require('../../lib/cloudinary');
const { renderReportCardPdf, BEHAVIOUR_ATTRS } = require('../../lib/pdf/report-card-pdf');

const TERMS = ['FIRST', 'SECOND', 'THIRD'];
function normTerm(value) {
  const t = String(value || '').toUpperCase();
  return TERMS.includes(t) ? t : null;
}

function fullName(s) {
  return [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
}

// Standard competition ranking ("1,2,2,4") over a list of { id, value },
// higher value = better position. Returns map id → position (1-based).
// Items with value <= 0 still get ranked (last) so every student has a position.
function rankByDesc(items) {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const pos = {};
  let rank = 0;
  let seen = 0;
  let prev = null;
  for (const it of sorted) {
    seen += 1;
    if (prev === null || it.value !== prev) {
      rank = seen;
      prev = it.value;
    }
    pos[it.id] = rank;
  }
  return pos;
}

const EMPTY_BEHAVIOUR = BEHAVIOUR_ATTRS.map((attribute) => ({ attribute, score: null }));

// ── POST /generate ──────────────────────────────────────────────────────────
router.post('/generate', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const term = normTerm(body.term);
    if (!term) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });

    if (typeof body.classId !== 'string' || body.classId.trim() === '') {
      return res.status(400).json({ error: { message: 'classId is required', field: 'classId' } });
    }
    const cls = await prisma.class.findFirst({
      where: { id: body.classId, schoolId: req.user.schoolId },
      select: { id: true, name: true },
    });
    if (!cls) return res.status(404).json({ error: { message: 'Class not found', field: 'classId' } });

    if (typeof body.sessionId !== 'string' || body.sessionId.trim() === '') {
      return res.status(400).json({ error: { message: 'sessionId is required', field: 'sessionId' } });
    }
    const session = await prisma.academicSession.findFirst({
      where: { id: body.sessionId, schoolId: req.user.schoolId },
      select: { id: true, name: true },
    });
    if (!session) return res.status(404).json({ error: { message: 'Session not found', field: 'sessionId' } });

    const students = await prisma.student.findMany({
      where: { schoolId: req.user.schoolId, classId: cls.id, archivedAt: null },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    if (students.length === 0) {
      return res.status(400).json({ error: { message: 'No active students in this class' } });
    }
    const studentIds = students.map((s) => s.id);

    const subjects = await prisma.subject.findMany({
      where: { schoolId: req.user.schoolId, classId: cls.id, archivedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const subjectName = {};
    subjects.forEach((s) => { subjectName[s.id] = s.name; });

    const entries = await prisma.resultEntry.findMany({
      where: { schoolId: req.user.schoolId, sessionId: session.id, term, studentId: { in: studentIds } },
    });

    // Group entries by student and by subject (for subject-position ranking).
    const byStudent = {};
    const perSubject = {}; // subjectId → [{ id: studentId, value: total }]
    for (const e of entries) {
      (byStudent[e.studentId] = byStudent[e.studentId] || []).push(e);
      (perSubject[e.subjectId] = perSubject[e.subjectId] || []).push({ id: e.studentId, value: e.total });
    }
    const subjectPos = {}; // subjectId → (studentId → position)
    Object.keys(perSubject).forEach((sid) => { subjectPos[sid] = rankByDesc(perSubject[sid]); });

    // Per-student aggregate + average for overall ranking.
    const aggregates = students.map((s) => {
      const es = byStudent[s.id] || [];
      const aggregate = es.reduce((sum, e) => sum + e.total, 0);
      const count = es.length;
      const average = count > 0 ? Math.round((aggregate / count) * 100) / 100 : 0;
      return { id: s.id, aggregate, count, average };
    });
    const overallPos = rankByDesc(aggregates.map((a) => ({ id: a.id, value: a.average })));
    const aggById = {};
    aggregates.forEach((a) => { aggById[a.id] = a; });

    const classSize = students.length;
    const generatedAt = new Date();

    // Build + persist one ReportCard per student (persist-before-respond).
    const saved = [];
    for (const s of students) {
      const es = (byStudent[s.id] || []).slice().sort((a, b) =>
        (subjectName[a.subjectId] || '').localeCompare(subjectName[b.subjectId] || ''));

      const subjectRows = es.map((e) => {
        const { grade, remark } = grading.gradeFor(e.total);
        return {
          subjectId: e.subjectId,
          name: subjectName[e.subjectId] || 'Subject',
          ca1: e.ca1, ca2: e.ca2, objective: e.objective, theory: e.theory,
          total: e.total,
          grade,
          remark,
          subjectPosition: (subjectPos[e.subjectId] && subjectPos[e.subjectId][s.id]) || null,
        };
      });

      const agg = aggById[s.id];
      const snapshot = {
        generatedAt: generatedAt.toISOString(),
        student: {
          id: s.id,
          admissionNumber: s.admissionNumber,
          fullName: fullName(s),
          firstName: s.firstName,
          middleName: s.middleName || null,
          lastName: s.lastName,
          photoUrl: s.photoUrl || null,
          class: cls.name,
        },
        session: session.name,
        term,
        subjects: subjectRows,
        summary: {
          subjectsCount: agg.count,
          aggregate: agg.aggregate,
          average: agg.average,
          overallPosition: overallPos[s.id] || null,
          classSize,
          cumulativeAverage: null, // Ops 2/3 (cross-term)
        },
        attendance: { schoolOpened: null, present: null, absent: null }, // Ops 2
        behaviour: EMPTY_BEHAVIOUR,                                       // Ops 2
        comments: { classTeacher: null, principal: null },               // Ops 2 (AI)
        resumptionDate: null,
      };

      const card = await prisma.reportCard.upsert({
        where: {
          studentId_sessionId_term: { studentId: s.id, sessionId: session.id, term },
        },
        create: {
          schoolId: req.user.schoolId,
          studentId: s.id,
          sessionId: session.id,
          term,
          snapshot,
          generatedById: req.user.id,
        },
        update: {
          snapshot,
          generatedById: req.user.id,
          // regenerating clears any stale PDF; locked cards are protected below
        },
        select: {
          id: true, studentId: true, term: true, pdfUrl: true, lockedAt: true, snapshot: true,
        },
      });
      saved.push(card);
    }

    recordAcademicEvent('REPORT_CARD_GENERATED', {
      schoolId: req.user.schoolId,
      actorId: req.user.id,
      metadata: { classId: cls.id, sessionId: session.id, term, count: saved.length },
    });

    res.json({
      reportCards: saved.map((c) => ({
        id: c.id,
        studentId: c.studentId,
        term: c.term,
        pdfUrl: c.pdfUrl,
        lockedAt: c.lockedAt,
        summary: c.snapshot && c.snapshot.summary,
      })),
      classId: cls.id,
      sessionId: session.id,
      term,
      count: saved.length,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET / (list) ────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const where = { schoolId: req.user.schoolId };
    if (req.query.sessionId) where.sessionId = String(req.query.sessionId);
    const term = req.query.term ? normTerm(req.query.term) : null;
    if (req.query.term && !term) {
      return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });
    }
    if (term) where.term = term;

    let studentFilter = null;
    if (req.query.classId) {
      const ids = await prisma.student.findMany({
        where: { schoolId: req.user.schoolId, classId: String(req.query.classId) },
        select: { id: true },
      });
      studentFilter = ids.map((s) => s.id);
      where.studentId = { in: studentFilter };
    }

    const cards = await prisma.reportCard.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        student: { select: { id: true, admissionNumber: true, firstName: true, middleName: true, lastName: true } },
        session: { select: { id: true, name: true } },
      },
    });

    res.json({
      reportCards: cards.map((c) => ({
        id: c.id,
        student: c.student,
        session: c.session,
        term: c.term,
        pdfUrl: c.pdfUrl,
        lockedAt: c.lockedAt,
        summary: c.snapshot && c.snapshot.summary,
        createdAt: c.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const card = await prisma.reportCard.findFirst({
      where: { id, schoolId: req.user.schoolId },
    });
    if (!card) return res.status(404).json({ error: { message: 'Report card not found' } });
    res.json({ reportCard: card });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/pdf ─────────────────────────────────────────────────────────────
router.post('/:id/pdf', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const card = await prisma.reportCard.findFirst({
      where: { id, schoolId: req.user.schoolId },
      include: { school: { select: { name: true, logoUrl: true } } },
    });
    if (!card) return res.status(404).json({ error: { message: 'Report card not found' } });

    if (!cloudinaryLib.isConfigured || !cloudinaryLib.isConfigured()) {
      return res.status(503).json({ error: { message: 'PDF storage is not configured' } });
    }

    let buffer;
    try {
      buffer = await renderReportCardPdf(card.snapshot, card.school);
    } catch (e) {
      return res.status(500).json({ error: { message: 'Failed to render report card PDF' } });
    }

    const publicId = `reportcard-${card.schoolId}-${card.id}`;
    let secureUrl;
    try {
      secureUrl = await cloudinaryLib.uploadPdfBuffer(buffer, publicId);
    } catch (e) {
      return res.status(502).json({ error: { message: 'Failed to upload report card PDF' } });
    }

    const updated = await prisma.reportCard.update({
      where: { id: card.id },
      data: { pdfUrl: secureUrl },
      select: { id: true, pdfUrl: true, lockedAt: true, term: true, studentId: true },
    });

    res.json({ reportCard: updated });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/lock ────────────────────────────────────────────────────────────
router.post('/:id/lock', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const card = await prisma.reportCard.findFirst({ where: { id, schoolId: req.user.schoolId } });
    if (!card) return res.status(404).json({ error: { message: 'Report card not found' } });
    if (card.lockedAt) {
      return res.json({ reportCard: { id: card.id, lockedAt: card.lockedAt, term: card.term, studentId: card.studentId, pdfUrl: card.pdfUrl } });
    }
    const updated = await prisma.reportCard.update({
      where: { id: card.id },
      data: { lockedAt: new Date() },
      select: { id: true, lockedAt: true, term: true, studentId: true, pdfUrl: true },
    });
    recordAcademicEvent('REPORT_CARD_LOCKED', {
      schoolId: req.user.schoolId, actorId: req.user.id,
      metadata: { reportCardId: updated.id },
    });
    res.json({ reportCard: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
