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
    select: { id: true, name: true },
  });
  if (!cls) return { ok: false, status: 404, message: 'Class not found', field: 'classId' };
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

// ── GET /grid ───────────────────────────────────────────────────────────────
router.get('/grid', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const term = normTerm(req.query.term);
    if (!term) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });
    const clsRes = await resolveClass(req, req.query.classId);
    if (!clsRes.ok) return res.status(clsRes.status).json({ error: { message: clsRes.message, field: clsRes.field } });
    const sessRes = await resolveSession(req, req.query.sessionId);
    if (!sessRes.ok) return res.status(sessRes.status).json({ error: { message: sessRes.message, field: sessRes.field } });

    const students = await prisma.student.findMany({
      where: { schoolId: req.user.schoolId, classId: clsRes.cls.id, archivedAt: null },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, admissionNumber: true, firstName: true, lastName: true, middleName: true },
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
router.post('/', authenticate, authorize('SCHOOL_ADMIN'), requireActiveForWrites, requirePlan('BEHAVIOUR'), /* gate-1-beh-post */ async (req, res, next) => {
  try {
    const body = req.body || {};
    const term = normTerm(body.term);
    if (!term) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });
    const sessRes = await resolveSession(req, body.sessionId);
    if (!sessRes.ok) return res.status(sessRes.status).json({ error: { message: sessRes.message, field: sessRes.field } });

    if (typeof body.studentId !== 'string' || body.studentId.trim() === '') {
      return res.status(400).json({ error: { message: 'studentId is required', field: 'studentId' } });
    }
    const student = await prisma.student.findFirst({
      where: { id: body.studentId, schoolId: req.user.schoolId, archivedAt: null },
      select: { id: true },
    });
    if (!student) return res.status(404).json({ error: { message: 'Student not found', field: 'studentId' } });

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

module.exports = router;
