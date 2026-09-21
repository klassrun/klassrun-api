// src/modules/behaviour/behaviour.routes.js
// ops-2-behaviour-routes
//
// Operations 2 — Behavioural assessment data. Mounted at /api/behaviour.
// SCHOOL_ADMIN-only.
//   GET  /api/behaviour/grid?classId=&sessionId=&term=  roster + existing ratings
//   POST /api/behaviour                                  upsert ONE student's ratings
//
// ratings is a Json object keyed by attribute (subset of BEHAVIOUR_ATTRS), 1-5.
// BEHAVIOUR_ATTRS is the SINGLE source — imported from the PDF renderer (no copy).

const router = require('express').Router();
const { requirePlan, requireActiveForWrites } = require('../../lib/plan-gate'); // gate-1-require
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');
const { BEHAVIOUR_ATTRS } = require('../../lib/pdf/report-card-pdf');

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

// Validate ratings: object whose keys are known attributes, values integers 1-5.
// Empty/null values are dropped (allows clearing a rating).
function validateRatings(input) {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'ratings must be an object' };
  const out = {};
  for (const key of Object.keys(input)) {
    if (!BEHAVIOUR_ATTRS.includes(key)) return { ok: false, error: 'Unknown behaviour attribute: ' + key };
    const v = input[key];
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 5) return { ok: false, error: key + ' must be a whole number from 1 to 5' };
    out[key] = n;
  }
  return { ok: true, value: out };
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
    const records = await prisma.behaviourRecord.findMany({
      where: { schoolId: req.user.schoolId, sessionId: sessRes.session.id, term, studentId: { in: students.map((s) => s.id) } },
    });
    const byStudent = {};
    records.forEach((r) => { byStudent[r.studentId] = r; });

    const rows = students.map((s) => {
      const r = byStudent[s.id];
      return {
        student: s,
        ratings: r && r.ratings && typeof r.ratings === 'object' ? r.ratings : {},
        hasEntry: !!r,
      };
    });

    res.json({ class: clsRes.cls, session: sessRes.session, term, attributes: BEHAVIOUR_ATTRS, rows });
  } catch (err) {
    next(err);
  }
});

// ── POST / (upsert one student's ratings) ─────────────────────────────────────
router.post('/', authenticate, authorize('SCHOOL_ADMIN', 'TEACHER'), requireActiveForWrites, requirePlan('BEHAVIOUR'), /* gate-1-beh-post classteacher-v1 */ async (req, res, next) => {
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


    const rv = validateRatings(body.ratings);
    if (!rv.ok) return res.status(400).json({ error: { message: rv.error, field: 'ratings' } });

    const record = await prisma.behaviourRecord.upsert({
      where: { studentId_sessionId_term: { studentId: student.id, sessionId: sessRes.session.id, term } },
      create: {
        schoolId: req.user.schoolId, studentId: student.id, sessionId: sessRes.session.id, term,
        ratings: rv.value, enteredById: req.user.id,
      },
      update: { ratings: rv.value, enteredById: req.user.id },
    });

    recordAcademicEvent('BEHAVIOUR_RECORDED', {
      schoolId: req.user.schoolId, actorId: req.user.id,
      metadata: { studentId: student.id, sessionId: sessRes.session.id, term },
    });

    res.json({ behaviour: record });
  } catch (err) {
    next(err);
  }
});

// ── POST /bulk ───────────────────────────────────────────────────────────────
// behaviour-bulk-v1: a whole class's ratings at once (the teacher's filled-in
// Excel template, parsed in the browser). preview writes nothing; save writes
// ONLY valid, changed rows in one transaction. A row whose ratings are all
// blank is skipped, so an upload can never wipe a student's ratings.
const BEH_BULK_MAX_ROWS = 500;
const behBlank = (v) => v === undefined || v === null || String(v).trim() === '';
function sameRatings(a, b) {
  const x = a && typeof a === 'object' ? a : {};
  const y = b && typeof b === 'object' ? b : {};
  const kx = Object.keys(x).filter((k) => !behBlank(x[k]));
  const ky = Object.keys(y).filter((k) => !behBlank(y[k]));
  if (kx.length !== ky.length) return false;
  return kx.every((k) => Number(x[k]) === Number(y[k]));
}

router.post('/bulk', authenticate, authorize('SCHOOL_ADMIN', 'TEACHER'), requireActiveForWrites, requirePlan('BEHAVIOUR'), /* behaviour-bulk-v1 */ async (req, res, next) => {
  try {
    const body = req.body || {};
    const mode = body.mode === 'save' ? 'save' : body.mode === 'preview' ? 'preview' : null;
    if (!mode) return res.status(400).json({ error: { message: "mode must be 'preview' or 'save'", field: 'mode' } });
    const term = normTerm(body.term);
    if (!term) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });
    const clsRes = await resolveClass(req, body.classId); // enforces class-teacher ownership
    if (!clsRes.ok) return res.status(clsRes.status).json({ error: { message: clsRes.message, field: clsRes.field } });
    const sessRes = await resolveSession(req, body.sessionId);
    if (!sessRes.ok) return res.status(sessRes.status).json({ error: { message: sessRes.message, field: sessRes.field } });
    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      return res.status(400).json({ error: { message: 'The file has no student rows', field: 'rows' } });
    }
    if (body.rows.length > BEH_BULK_MAX_ROWS) {
      return res.status(400).json({ error: { message: `Upload at most ${BEH_BULK_MAX_ROWS} rows at a time`, field: 'rows' } });
    }

    // Same roster as GET /grid: Enrollment for (session, class), leavers included.
    const enrolled = await prisma.enrollment.findMany({
      where: { schoolId: req.user.schoolId, sessionId: sessRes.session.id, classId: clsRes.cls.id },
      select: { studentId: true },
    });
    const ids = enrolled.map((e) => e.studentId);
    const students = ids.length === 0 ? [] : await prisma.student.findMany({
      where: { schoolId: req.user.schoolId, id: { in: ids } },
      select: { id: true, admissionNumber: true, firstName: true, lastName: true },
    });
    const byAdmission = new Map(students.map((s) => [String(s.admissionNumber).trim().toUpperCase(), s]));
    const existing = ids.length === 0 ? [] : await prisma.behaviourRecord.findMany({
      where: { schoolId: req.user.schoolId, sessionId: sessRes.session.id, term, studentId: { in: ids } },
    });
    const existingByStudent = {};
    existing.forEach((r) => { existingByStudent[r.studentId] = r; });

    const results = [];
    const writes = [];
    const seen = new Set();
    body.rows.forEach((raw, i) => {
      const rowNo = raw && Number.isInteger(raw.row) ? raw.row : i + 2;
      const admissionNumber = raw && !behBlank(raw.admissionNumber) ? String(raw.admissionNumber).trim() : '';
      const out = { row: rowNo, admissionNumber };
      if (!admissionNumber) { results.push({ ...out, status: 'error', message: 'Admission number is missing' }); return; }
      const student = byAdmission.get(admissionNumber.toUpperCase());
      if (!student) { results.push({ ...out, status: 'error', message: 'No student with this admission number in this class for this session' }); return; }
      out.name = `${student.lastName} ${student.firstName}`;
      if (seen.has(student.id)) { results.push({ ...out, status: 'error', message: 'This student appears more than once in the file' }); return; }
      seen.add(student.id);
      const given = raw.ratings && typeof raw.ratings === 'object' && !Array.isArray(raw.ratings) ? raw.ratings : {};
      const cleaned = {};
      Object.keys(given).forEach((k) => { if (!behBlank(given[k])) cleaned[k] = typeof given[k] === 'string' ? given[k].trim() : given[k]; });
      if (Object.keys(cleaned).length === 0) { results.push({ ...out, status: 'skipped', message: 'No ratings in this row' }); return; }
      const rv = validateRatings(cleaned);
      if (!rv.ok) { results.push({ ...out, status: 'error', message: rv.error }); return; }
      const prev = existingByStudent[student.id];
      if (prev && sameRatings(prev.ratings, rv.value)) { results.push({ ...out, status: 'unchanged' }); return; }
      results.push({ ...out, status: 'ok', isNew: !prev });
      writes.push({ studentId: student.id, ratings: rv.value });
    });

    let saved = 0;
    if (mode === 'save' && writes.length > 0) {
      await prisma.$transaction(writes.map((w) => prisma.behaviourRecord.upsert({
        where: { studentId_sessionId_term: { studentId: w.studentId, sessionId: sessRes.session.id, term } },
        create: {
          schoolId: req.user.schoolId, studentId: w.studentId, sessionId: sessRes.session.id, term,
          ratings: w.ratings, enteredById: req.user.id,
        },
        update: { ratings: w.ratings, enteredById: req.user.id },
      })));
      saved = writes.length;
      recordAcademicEvent('BEHAVIOUR_RECORDED', {
        schoolId: req.user.schoolId, actorId: req.user.id,
        metadata: { bulk: true, classId: clsRes.cls.id, sessionId: sessRes.session.id, term, saved },
      });
    }

    const count = (s) => results.filter((r) => r.status === s).length;
    res.json({
      mode,
      term,
      attributes: BEHAVIOUR_ATTRS,
      summary: { rows: results.length, ok: count('ok'), unchanged: count('unchanged'), skipped: count('skipped'), errors: count('error'), saved },
      rows: results,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
