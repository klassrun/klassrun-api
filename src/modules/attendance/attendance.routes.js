// src/modules/attendance/attendance.routes.js
// ops-2-attendance-routes
//
// Operations 2 — Attendance data. Mounted at /api/attendance. SCHOOL_ADMIN-only.
//   GET  /api/attendance/grid?classId=&sessionId=&term=  roster + existing rows
//   POST /api/attendance                                  upsert ONE student's row
//
// schoolOpened / present / absent per student per term. Validated:
//   present <= schoolOpened, absent <= schoolOpened (not forced to sum — holidays).

const router = require('express').Router();
const { requirePlan, requireActiveForWrites } = require('../../lib/plan-gate'); // gate-1-require
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');

const TERMS = ['FIRST', 'SECOND', 'THIRD'];
function normTerm(value) {
  const t = String(value || '').toUpperCase();
  return TERMS.includes(t) ? t : null;
}

async function resolveClass(req, classId) {
  if (typeof classId !== 'string' || classId.trim() === '') {
    return { ok: false, status: 400, message: 'classId is required', field: 'classId' };
  }
  const cls = await prisma.class.findFirst({
    where: { id: classId, schoolId: req.user.schoolId },
    select: { id: true, name: true, classTeacherId: true }, // classteacher-v1
  });
  if (!cls) return { ok: false, status: 404, message: 'Class not found', field: 'classId' };
  // classteacher-v1: a TEACHER may only reach the class they are class teacher of.
  if (req.user.role === 'TEACHER' && cls.classTeacherId !== req.user.id) {
    return { ok: false, status: 403, message: 'You are not the class teacher for this class', field: 'classId' };
  }
  return { ok: true, cls };
}

async function resolveSession(req, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { ok: false, status: 400, message: 'sessionId is required', field: 'sessionId' };
  }
  const session = await prisma.academicSession.findFirst({
    where: { id: sessionId, schoolId: req.user.schoolId },
    select: { id: true, name: true },
  });
  if (!session) return { ok: false, status: 404, message: 'Session not found', field: 'sessionId' };
  return { ok: true, session };
}

function toInt(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}
// classteacher-v1: the POST body carries no classId, so resolve it the same way
// both grids already do — studentId + sessionId -> Enrollment -> classId.
// Enrollment is @@unique([studentId, sessionId]), so there is exactly one.
// SCHOOL_ADMIN is unrestricted; only TEACHER is narrowed to their own class.
async function assertClassTeacherForStudent(req, studentId, sessionId) {
  if (req.user.role !== 'TEACHER') return { ok: true };
  const enr = await prisma.enrollment.findFirst({
    where: { schoolId: req.user.schoolId, studentId, sessionId },
    select: { classId: true },
  });
  if (!enr) {
    return { ok: false, status: 404, message: 'This student has no enrollment for that session', field: 'studentId' };
  }
  const cls = await prisma.class.findFirst({
    where: { id: enr.classId, schoolId: req.user.schoolId },
    select: { classTeacherId: true },
  });
  if (!cls || cls.classTeacherId !== req.user.id) {
    return { ok: false, status: 403, message: 'You are not the class teacher for this class', field: 'studentId' };
  }
  return { ok: true };
}


// ── GET /grid ───────────────────────────────────────────────────────────────
router.get('/grid', authenticate, authorize('SCHOOL_ADMIN', 'TEACHER'), /* classteacher-v1 */ async (req, res, next) => {
  try {
    const term = normTerm(req.query.term);
    if (!term) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });
    const clsRes = await resolveClass(req, req.query.classId);
    if (!clsRes.ok) return res.status(clsRes.status).json({ error: { message: clsRes.message, field: clsRes.field } });
    const sessRes = await resolveSession(req, req.query.sessionId);
    if (!sessRes.ok) return res.status(sessRes.status).json({ error: { message: sessRes.message, field: sessRes.field } });

    // enrollment-b2-v1: session-scoped roster. Spec section 2 - who was in this class
    // THIS session, from Enrollment. Student.classId answers "now", which is a
    // different question and silently rewrites history after any promotion.
    const enrolledRows = await prisma.enrollment.findMany({
      where: { schoolId: req.user.schoolId, sessionId: sessRes.session.id, classId: clsRes.cls.id },
      select: { studentId: true },
    });
    const enrolledIds = enrolledRows.map((e) => e.studentId);
    // archivedAt is deliberately NOT filtered (spec 2.2): a student who has
    // since left was still in this class this session, and dropping them makes
    // the record shrink. archivedAt is returned so the UI can mark the row.
    const students = enrolledIds.length === 0 ? [] : await prisma.student.findMany({
      where: { schoolId: req.user.schoolId, id: { in: enrolledIds } },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, admissionNumber: true, firstName: true, lastName: true, middleName: true, archivedAt: true },
    });
    const records = await prisma.attendanceRecord.findMany({
      where: { schoolId: req.user.schoolId, sessionId: sessRes.session.id, term, studentId: { in: students.map((s) => s.id) } },
    });
    const byStudent = {};
    records.forEach((r) => { byStudent[r.studentId] = r; });

    const rows = students.map((s) => {
      const r = byStudent[s.id];
      return {
        student: s,
        schoolOpened: r ? r.schoolOpened : 0,
        present: r ? r.present : 0,
        absent: r ? r.absent : 0,
        hasEntry: !!r,
      };
    });

    res.json({ class: clsRes.cls, session: sessRes.session, term, rows });
  } catch (err) {
    next(err);
  }
});

// ── POST / (upsert one row) ───────────────────────────────────────────────────
router.post('/', authenticate, authorize('SCHOOL_ADMIN', 'TEACHER'), requireActiveForWrites, requirePlan('ATTENDANCE'), /* gate-1-att-post classteacher-v1 */ async (req, res, next) => {
  try {
    const body = req.body || {};
    const term = normTerm(body.term);
    if (!term) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });
    const sessRes = await resolveSession(req, body.sessionId);
    if (!sessRes.ok) return res.status(sessRes.status).json({ error: { message: sessRes.message, field: sessRes.field } });

    if (typeof body.studentId !== 'string' || body.studentId.trim() === '') {
      return res.status(400).json({ error: { message: 'studentId is required', field: 'studentId' } });
    }
    // archived-student-entry-v1: the grid deliberately INCLUDES students who have since
    // left (spec 2.2 — they were in this class THIS session, and dropping them
    // makes the record shrink). This lookup used to filter archivedAt: null and
    // 404 exactly those rows, so an admin closing out a term could see a "Left"
    // student on screen and be unable to record them. schoolId scoping and the
    // class-teacher ownership check below are unchanged — this widens nothing,
    // it only makes a previously impossible write possible.
    const student = await prisma.student.findFirst({
      where: { id: body.studentId, schoolId: req.user.schoolId },
      select: { id: true },
    });
    if (!student) return res.status(404).json({ error: { message: 'Student not found', field: 'studentId' } });
    const own = await assertClassTeacherForStudent(req, student.id, sessRes.session.id); // classteacher-v1
    if (!own.ok) return res.status(own.status).json({ error: { message: own.message, field: own.field } });


    const schoolOpened = toInt(body.schoolOpened);
    const present = toInt(body.present);
    const absent = toInt(body.absent);
    if (schoolOpened === null) return res.status(400).json({ error: { message: 'schoolOpened must be a whole number 0 or more', field: 'schoolOpened' } });
    if (present === null) return res.status(400).json({ error: { message: 'present must be a whole number 0 or more', field: 'present' } });
    if (absent === null) return res.status(400).json({ error: { message: 'absent must be a whole number 0 or more', field: 'absent' } });
    if (present > schoolOpened) return res.status(400).json({ error: { message: 'present cannot exceed the days the school opened', field: 'present' } });
    if (absent > schoolOpened) return res.status(400).json({ error: { message: 'absent cannot exceed the days the school opened', field: 'absent' } });

    const record = await prisma.attendanceRecord.upsert({
      where: { studentId_sessionId_term: { studentId: student.id, sessionId: sessRes.session.id, term } },
      create: {
        schoolId: req.user.schoolId, studentId: student.id, sessionId: sessRes.session.id, term,
        schoolOpened, present, absent, enteredById: req.user.id,
      },
      update: { schoolOpened, present, absent, enteredById: req.user.id },
    });

    recordAcademicEvent('ATTENDANCE_RECORDED', {
      schoolId: req.user.schoolId, actorId: req.user.id,
      metadata: { studentId: student.id, sessionId: sessRes.session.id, term },
    });

    res.json({ attendance: record });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
