// src/modules/results/result.routes.js
// ops-1-result-routes
//
// Operations 1 — Results entry & grading. Mounted at /api/results.
//   GET  /api/results/grid?classId=&subjectId=&sessionId=&term=
//        roster + existing score rows for the entry UI (TEACHER own-subject / ADMIN)
//   POST /api/results
//        upsert ONE student's score row for a subject/session/term.
//        Computes total + grade from the single source of truth (grading.js).
//
// Authorization (mirrors decision #21): a TEACHER may only touch subjects they
// are assigned to (Subject.teacherId === req.user.id). SCHOOL_ADMIN may touch any.
// Validates student belongs to the same class as the subject (Subject is
// class-specific — Subject.classId).

const router = require('express').Router();
const { requirePlan, requireActiveForWrites } = require('../../lib/plan-gate'); // gate-1-require
const { authenticate } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');
const grading = require('../../lib/grading');

const TERMS = ['FIRST', 'SECOND', 'THIRD'];

// Resolve and authorize a subject for the acting user. Returns
// { ok, subject } or { ok:false, status, message }.
async function resolveSubject(req, subjectId) {
  if (typeof subjectId !== 'string' || subjectId.trim() === '') {
    return { ok: false, status: 400, message: 'subjectId is required', field: 'subjectId' };
  }
  const subject = await prisma.subject.findFirst({
    where: { id: subjectId, schoolId: req.user.schoolId },
    select: { id: true, name: true, classId: true, teacherId: true, archivedAt: true },
  });
  if (!subject) return { ok: false, status: 404, message: 'Subject not found', field: 'subjectId' };
  if (subject.archivedAt) return { ok: false, status: 400, message: 'Subject is archived', field: 'subjectId' };

  if (req.user.role === 'TEACHER' && subject.teacherId !== req.user.id) {
    return { ok: false, status: 403, message: 'You are not assigned to this subject', field: 'subjectId' };
  }
  return { ok: true, subject };
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

function normTerm(value) {
  const t = String(value || '').toUpperCase();
  return TERMS.includes(t) ? t : null;
}

// ── GET /grid ─────────────────────────────────────────────────────────────
router.get('/grid', authenticate, async (req, res, next) => {
  try {
    const { classId, subjectId, sessionId } = req.query;
    const term = normTerm(req.query.term);
    if (!term) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });

    const subjRes = await resolveSubject(req, subjectId);
    if (!subjRes.ok) return res.status(subjRes.status).json({ error: { message: subjRes.message, field: subjRes.field } });

    const sessRes = await resolveSession(req, sessionId);
    if (!sessRes.ok) return res.status(sessRes.status).json({ error: { message: sessRes.message, field: sessRes.field } });

    const useClassId = classId ? String(classId) : subjRes.subject.classId;
    if (useClassId !== subjRes.subject.classId) {
      return res.status(400).json({ error: { message: 'classId does not match the subject', field: 'classId' } });
    }

    const students = await prisma.student.findMany({
      where: { schoolId: req.user.schoolId, classId: useClassId, archivedAt: null },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, admissionNumber: true, firstName: true, lastName: true, middleName: true },
    });

    const entries = await prisma.resultEntry.findMany({
      where: {
        schoolId: req.user.schoolId,
        subjectId: subjRes.subject.id,
        sessionId: sessRes.session.id,
        term,
      },
    });
    const byStudent = {};
    entries.forEach((e) => { byStudent[e.studentId] = e; });

    const rows = students.map((s) => {
      const e = byStudent[s.id];
      return {
        student: s,
        ca1: e ? e.ca1 : 0,
        ca2: e ? e.ca2 : 0,
        objective: e ? e.objective : 0,
        theory: e ? e.theory : 0,
        total: e ? e.total : null,
        grade: e ? e.grade : null,
        hasEntry: !!e,
      };
    });

    res.json({
      subject: { id: subjRes.subject.id, name: subjRes.subject.name, classId: subjRes.subject.classId },
      session: sessRes.session,
      term,
      scoreMax: grading.SCORE_MAX,
      totalMax: grading.TOTAL_MAX,
      rows,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST / (upsert one entry) ───────────────────────────────────────────────
router.post('/', authenticate, requireActiveForWrites, requirePlan('RESULTS_REPORTCARDS'), /* gate-1-results-post */ async (req, res, next) => {
  try {
    const body = req.body || {};
    const term = normTerm(body.term);
    if (!term) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });

    const subjRes = await resolveSubject(req, body.subjectId);
    if (!subjRes.ok) return res.status(subjRes.status).json({ error: { message: subjRes.message, field: subjRes.field } });

    const sessRes = await resolveSession(req, body.sessionId);
    if (!sessRes.ok) return res.status(sessRes.status).json({ error: { message: sessRes.message, field: sessRes.field } });

    if (typeof body.studentId !== 'string' || body.studentId.trim() === '') {
      return res.status(400).json({ error: { message: 'studentId is required', field: 'studentId' } });
    }
    const student = await prisma.student.findFirst({
      where: { id: body.studentId, schoolId: req.user.schoolId, archivedAt: null },
      select: { id: true, classId: true },
    });
    if (!student) return res.status(404).json({ error: { message: 'Student not found', field: 'studentId' } });

    if (student.classId !== subjRes.subject.classId) {
      return res.status(400).json({ error: { message: 'Student is not in this subject\u2019s class', field: 'studentId' } });
    }

    const comps = {};
    for (const key of grading.COMPONENTS) {
      const c = grading.validateComponent(key, body[key]);
      if (!c.ok) return res.status(400).json({ error: { message: c.error, field: key } });
      comps[key] = c.value;
    }
    const total = grading.computeTotal(comps);
    const { grade } = grading.gradeFor(total);

    const entry = await prisma.resultEntry.upsert({
      where: {
        studentId_subjectId_sessionId_term: {
          studentId: student.id,
          subjectId: subjRes.subject.id,
          sessionId: sessRes.session.id,
          term,
        },
      },
      create: {
        schoolId: req.user.schoolId,
        studentId: student.id,
        subjectId: subjRes.subject.id,
        sessionId: sessRes.session.id,
        term,
        ...comps,
        total,
        grade,
        enteredById: req.user.id,
      },
      update: {
        ...comps,
        total,
        grade,
        enteredById: req.user.id,
      },
    });

    recordAcademicEvent('RESULT_ENTERED', {
      schoolId: req.user.schoolId,
      actorId: req.user.id,
      metadata: {
        studentId: student.id,
        subjectId: subjRes.subject.id,
        sessionId: sessRes.session.id,
        term,
        total,
        grade,
      },
    });

    res.json({ result: entry });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
