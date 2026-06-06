// src/modules/fees/fee.routes.js
// ops-4-fee-routes
// ops-4c-bursar-authorize — fees open to SCHOOL_ADMIN and BURSAR
//
// Operations 4 — Fees (status-only, term-scoped). MOLEK blueprint, Premium tier.
// SCHOOL_ADMIN-only in this phase (BURSAR role deferred to Ops 4c).
//
// Status model: a FeeRecord row with status 'PAID' marks a student paid for a
// (session, term). ABSENCE OF A ROW = UNPAID. Because records are term-scoped,
// a new term is automatically "all unpaid" — no reset hook needed.
//
// No AI cost → NOT billing-gated. Multi-tenant: every query scoped by schoolId.
// Persist-before-respond; bulk-mark is one $transaction; fire-and-forget audit.
//
// Mounted at /api/fees.
//   GET  /api/fees?classId=&sessionId=&term=   roster + summary (SCHOOL_ADMIN)
//   POST /api/fees/mark                          one student      (SCHOOL_ADMIN)
//   POST /api/fees/bulk-mark                     whole class/subset(SCHOOL_ADMIN)

const router = require('express').Router();
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');

const TERMS = ['FIRST', 'SECOND', 'THIRD'];
const STATUSES = ['PAID', 'UNPAID'];

function validTerm(t) { return typeof t === 'string' && TERMS.includes(t); }
function validStatus(s) { return typeof s === 'string' && STATUSES.includes(s); }

// ── GET / (roster + server-computed summary) ──────────────────────────────
router.get('/', authenticate, authorize('SCHOOL_ADMIN', 'BURSAR'), async (req, res, next) => {
  try {
    const classId = req.query.classId ? String(req.query.classId) : '';
    const sessionId = req.query.sessionId ? String(req.query.sessionId) : '';
    const term = req.query.term ? String(req.query.term) : '';

    if (!classId) return res.status(400).json({ error: { message: 'classId is required', field: 'classId' } });
    if (!sessionId) return res.status(400).json({ error: { message: 'sessionId is required', field: 'sessionId' } });
    if (!validTerm(term)) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });

    const [cls, session] = await Promise.all([
      prisma.class.findFirst({ where: { id: classId, schoolId: req.user.schoolId }, select: { id: true } }),
      prisma.academicSession.findFirst({ where: { id: sessionId, schoolId: req.user.schoolId }, select: { id: true } }),
    ]);
    if (!cls) return res.status(404).json({ error: { message: 'Class not found', field: 'classId' } });
    if (!session) return res.status(404).json({ error: { message: 'Session not found', field: 'sessionId' } });

    const students = await prisma.student.findMany({
      where: { schoolId: req.user.schoolId, classId, archivedAt: null },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, admissionNumber: true, firstName: true, lastName: true },
    });

    const studentIds = students.map((s) => s.id);
    const records = studentIds.length === 0 ? [] : await prisma.feeRecord.findMany({
      where: { schoolId: req.user.schoolId, sessionId, term, studentId: { in: studentIds } },
      select: { studentId: true, status: true },
    });
    const statusById = new Map(records.map((r) => [r.studentId, r.status]));

    const roster = students.map((s) => ({
      id: s.id,
      admissionNumber: s.admissionNumber,
      firstName: s.firstName,
      lastName: s.lastName,
      status: statusById.get(s.id) === 'PAID' ? 'PAID' : 'UNPAID',
    }));

    const total = roster.length;
    const paid = roster.filter((r) => r.status === 'PAID').length;
    const unpaid = total - paid;
    const percentPaid = total === 0 ? 0 : Math.round((paid / total) * 100);

    return res.json({ students: roster, summary: { total, paid, unpaid, percentPaid } });
  } catch (err) {
    next(err);
  }
});

// ── POST /mark (one student) ──────────────────────────────────────────────
router.post('/mark', authenticate, authorize('SCHOOL_ADMIN', 'BURSAR'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const studentId = typeof body.studentId === 'string' ? body.studentId : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const term = body.term;
    const status = body.status;

    if (!studentId) return res.status(400).json({ error: { message: 'studentId is required', field: 'studentId' } });
    if (!sessionId) return res.status(400).json({ error: { message: 'sessionId is required', field: 'sessionId' } });
    if (!validTerm(term)) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });
    if (!validStatus(status)) return res.status(400).json({ error: { message: 'status must be PAID or UNPAID', field: 'status' } });

    const [student, session] = await Promise.all([
      prisma.student.findFirst({ where: { id: studentId, schoolId: req.user.schoolId }, select: { id: true } }),
      prisma.academicSession.findFirst({ where: { id: sessionId, schoolId: req.user.schoolId }, select: { id: true } }),
    ]);
    if (!student) return res.status(404).json({ error: { message: 'Student not found', field: 'studentId' } });
    if (!session) return res.status(404).json({ error: { message: 'Session not found', field: 'sessionId' } });

    const record = await prisma.feeRecord.upsert({
      where: { studentId_sessionId_term: { studentId, sessionId, term } },
      create: { schoolId: req.user.schoolId, studentId, sessionId, term, status, markedById: req.user.id },
      update: { status, markedById: req.user.id },
    });

    recordAcademicEvent('FEE_MARKED', {
      schoolId: req.user.schoolId,
      actorId: req.user.id,
      metadata: { studentId, sessionId, term, status },
    });

    return res.json({ record });
  } catch (err) {
    next(err);
  }
});

// ── POST /bulk-mark (whole class or studentIds subset) ────────────────────
router.post('/bulk-mark', authenticate, authorize('SCHOOL_ADMIN', 'BURSAR'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const classId = typeof body.classId === 'string' ? body.classId : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const term = body.term;
    const status = body.status;
    const studentIds = Array.isArray(body.studentIds)
      ? body.studentIds.filter((x) => typeof x === 'string')
      : null;

    if (!classId) return res.status(400).json({ error: { message: 'classId is required', field: 'classId' } });
    if (!sessionId) return res.status(400).json({ error: { message: 'sessionId is required', field: 'sessionId' } });
    if (!validTerm(term)) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });
    if (!validStatus(status)) return res.status(400).json({ error: { message: 'status must be PAID or UNPAID', field: 'status' } });

    const [cls, session] = await Promise.all([
      prisma.class.findFirst({ where: { id: classId, schoolId: req.user.schoolId }, select: { id: true } }),
      prisma.academicSession.findFirst({ where: { id: sessionId, schoolId: req.user.schoolId }, select: { id: true } }),
    ]);
    if (!cls) return res.status(404).json({ error: { message: 'Class not found', field: 'classId' } });
    if (!session) return res.status(404).json({ error: { message: 'Session not found', field: 'sessionId' } });

    const where = { schoolId: req.user.schoolId, classId, archivedAt: null };
    if (studentIds && studentIds.length > 0) where.id = { in: studentIds };

    const students = await prisma.student.findMany({ where, select: { id: true } });
    if (students.length === 0) return res.json({ marked: 0 });

    await prisma.$transaction(
      students.map((s) =>
        prisma.feeRecord.upsert({
          where: { studentId_sessionId_term: { studentId: s.id, sessionId, term } },
          create: { schoolId: req.user.schoolId, studentId: s.id, sessionId, term, status, markedById: req.user.id },
          update: { status, markedById: req.user.id },
        })
      )
    );

    recordAcademicEvent('FEE_BULK_MARKED', {
      schoolId: req.user.schoolId,
      actorId: req.user.id,
      metadata: { classId, sessionId, term, status, count: students.length },
    });

    return res.json({ marked: students.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
