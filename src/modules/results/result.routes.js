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
const { authenticate, authorize } = require('../../middleware/auth'); // audit-results-role-v1
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');
const grading = require('../../lib/grading');
const gradingConfig = require('../../lib/grading-config'); // grading-config-v1

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
router.get('/grid', authenticate, authorize('TEACHER', 'SCHOOL_ADMIN'), /* audit-results-role-v1 */ async (req, res, next) => {
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

    // results-enrollment-roster-v1: roster is the (session,class) Enrollment set,
    // not the Student.classId cache. After a promotion the cache points at the
    // student's NEW class, so a PAST-session grid built from the cache shows the
    // wrong cohort (MOLEK class-position bug; class = (student,session) pair).
    // Fallback to the cache only when NO enrollment is tracked for this
    // (session,class), so a grid that has data today can never go empty.
    const enrolledGrid = await prisma.enrollment.findMany({
      where: { schoolId: req.user.schoolId, sessionId: sessRes.session.id, classId: useClassId },
      select: { studentId: true },
    });
    const rosterWhere = enrolledGrid.length > 0
      ? { schoolId: req.user.schoolId, id: { in: enrolledGrid.map((e) => e.studentId) }, archivedAt: null }
      : { schoolId: req.user.schoolId, classId: useClassId, archivedAt: null };
    const students = await prisma.student.findMany({
      where: rosterWhere,
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
        score5: e ? e.score5 : 0, // grading-config-v1
        score6: e ? e.score6 : 0,
        total: e ? e.total : null,
        grade: e ? e.grade : null,
        hasEntry: !!e,
      };
    });

    // grading-config-v1: the breakdown this term uses (frozen, legacy default, or the school's)
    const termGrading = await gradingConfig.componentsForTerm(req.user.schoolId, sessRes.session.id, term);
    // grading-config-apply-v1: flag saved scores that do not fit the term's breakdown
    let needsReviewCount = 0;
    rows.forEach((r) => {
      const why = gradingConfig.misfit(byStudent[r.student.id], termGrading.components);
      r.needsReview = !!why;
      if (why) { r.reviewReason = why; needsReviewCount += 1; }
    });
    res.json({
      subject: { id: subjRes.subject.id, name: subjRes.subject.name, classId: subjRes.subject.classId },
      session: sessRes.session,
      term,
      scoreMax: grading.scoreMaxFor(termGrading.components), // grading-config-v1
      totalMax: 100,
      components: termGrading.components, // grading-config-v1: [{ key, label, max }]
      breakdownLocked: termGrading.source !== 'school',
      needsReviewCount, // grading-config-apply-v1
      rows,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST / (upsert one entry) ───────────────────────────────────────────────
router.post('/', authenticate, authorize('TEACHER', 'SCHOOL_ADMIN'), requireActiveForWrites, requirePlan('RESULTS_REPORTCARDS'), /* gate-1-results-post audit-results-role-v1 */ async (req, res, next) => {
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

    // results-enrollment-roster-v1: membership is the (student, session) Enrollment
    // row (unique per student per session), not the Student.classId cache. After a
    // promotion the cache is the NEW class, so the old guard rejects legitimate
    // PAST-session entries. Fall back to the cache only when the student has NO
    // enrollment row for this session, so no working entry regresses.
    const enrForSession = await prisma.enrollment.findFirst({
      where: { studentId: student.id, sessionId: sessRes.session.id },
      select: { classId: true },
    });
    const memberClassId = enrForSession ? enrForSession.classId : student.classId;
    if (memberClassId !== subjRes.subject.classId) {
      return res.status(400).json({ error: { message: 'Student was not in this subject\u2019s class for this session', field: 'studentId' } });
    }

    const comps = {};
    // grading-config-v1: validate against the TERM's breakdown; the first save freezes it
    const termComponents = await gradingConfig.freezeForWrite(req.user.schoolId, sessRes.session.id, term);
    for (const comp of termComponents) {
      const key = comp.key;
      const c = grading.validateScore(comp, body[key]);
      if (!c.ok) return res.status(400).json({ error: { message: c.error, field: key } });
      comps[key] = c.value;
    }
    for (const key of grading.SLOT_KEYS) { if (!(key in comps)) comps[key] = 0; } // grading-config-v1: unused slots stay 0
    const total = grading.computeTotalFor(termComponents, comps);
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

// ── POST /bulk ───────────────────────────────────────────────────────────────
// results-bulk-v1: many students' scores for ONE subject/session/term at once
// (the teacher's filled-in Excel template, parsed in the browser).
//   body: { subjectId, sessionId, term, mode: 'preview' | 'save',
//           rows: [{ row?, admissionNumber, scores: { <slotKey>: number | '' } }] }
// Rows are matched on admission number against the class roster for that
// session (same Enrollment rule as GET /grid) and validated against the term's
// breakdown. preview writes nothing; save writes ONLY the valid, changed rows,
// in one transaction. A row whose parts are all blank is skipped, so an upload
// can never zero out a score that is already saved.
const BULK_MAX_ROWS = 500;
const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

router.post('/bulk', authenticate, authorize('TEACHER', 'SCHOOL_ADMIN'), requireActiveForWrites, requirePlan('RESULTS_REPORTCARDS'), /* results-bulk-v1 */ async (req, res, next) => {
  try {
    const body = req.body || {};
    const mode = body.mode === 'save' ? 'save' : body.mode === 'preview' ? 'preview' : null;
    if (!mode) return res.status(400).json({ error: { message: "mode must be 'preview' or 'save'", field: 'mode' } });
    const term = normTerm(body.term);
    if (!term) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });

    const subjRes = await resolveSubject(req, body.subjectId);
    if (!subjRes.ok) return res.status(subjRes.status).json({ error: { message: subjRes.message, field: subjRes.field } });
    const sessRes = await resolveSession(req, body.sessionId);
    if (!sessRes.ok) return res.status(sessRes.status).json({ error: { message: sessRes.message, field: sessRes.field } });

    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      return res.status(400).json({ error: { message: 'The file has no student rows', field: 'rows' } });
    }
    if (body.rows.length > BULK_MAX_ROWS) {
      return res.status(400).json({ error: { message: `Upload at most ${BULK_MAX_ROWS} rows at a time`, field: 'rows' } });
    }

    // Roster = who was in this subject's class for this session (same rule as GET /grid).
    const classId = subjRes.subject.classId;
    const enrolled = await prisma.enrollment.findMany({
      where: { schoolId: req.user.schoolId, sessionId: sessRes.session.id, classId },
      select: { studentId: true },
    });
    const rosterWhere = enrolled.length > 0
      ? { schoolId: req.user.schoolId, id: { in: enrolled.map((e) => e.studentId) }, archivedAt: null }
      : { schoolId: req.user.schoolId, classId, archivedAt: null };
    const students = await prisma.student.findMany({
      where: rosterWhere,
      select: { id: true, admissionNumber: true, firstName: true, lastName: true },
    });
    const byAdmission = new Map(students.map((s) => [String(s.admissionNumber).trim().toUpperCase(), s]));

    // preview never freezes the term; save does, exactly like a manual save.
    const components = mode === 'save'
      ? await gradingConfig.freezeForWrite(req.user.schoolId, sessRes.session.id, term)
      : (await gradingConfig.componentsForTerm(req.user.schoolId, sessRes.session.id, term)).components;

    const existing = await prisma.resultEntry.findMany({
      where: { schoolId: req.user.schoolId, subjectId: subjRes.subject.id, sessionId: sessRes.session.id, term },
    });
    const existingByStudent = {};
    existing.forEach((e) => { existingByStudent[e.studentId] = e; });

    const results = [];
    const writes = [];
    const seen = new Set();
    body.rows.forEach((raw, i) => {
      const rowNo = raw && Number.isInteger(raw.row) ? raw.row : i + 2; // spreadsheet row; row 1 is the header
      const admissionNumber = raw && !isBlank(raw.admissionNumber) ? String(raw.admissionNumber).trim() : '';
      const out = { row: rowNo, admissionNumber };
      if (!admissionNumber) { results.push({ ...out, status: 'error', message: 'Admission number is missing' }); return; }
      const student = byAdmission.get(admissionNumber.toUpperCase());
      if (!student) { results.push({ ...out, status: 'error', message: 'No student with this admission number in this class for this session' }); return; }
      out.studentId = student.id;
      out.name = `${student.lastName} ${student.firstName}`;
      if (seen.has(student.id)) { results.push({ ...out, status: 'error', message: 'This student appears more than once in the file' }); return; }
      seen.add(student.id);

      const scores = raw.scores && typeof raw.scores === 'object' ? raw.scores : {};
      if (components.every((c) => isBlank(scores[c.key]))) { results.push({ ...out, status: 'skipped', message: 'No scores in this row' }); return; }

      const comps = {};
      for (const c of components) {
        const v = typeof scores[c.key] === 'string' ? scores[c.key].trim() : scores[c.key];
        const r = grading.validateScore(c, v);
        if (!r.ok) { results.push({ ...out, status: 'error', message: r.error }); return; }
        comps[c.key] = r.value;
      }
      for (const key of grading.SLOT_KEYS) { if (!(key in comps)) comps[key] = 0; }
      const total = grading.computeTotalFor(components, comps);
      const { grade } = grading.gradeFor(total);
      const prev = existingByStudent[student.id];
      if (prev && grading.SLOT_KEYS.every((k) => (Number(prev[k]) || 0) === comps[k])) {
        results.push({ ...out, status: 'unchanged', total, grade });
        return;
      }
      results.push({ ...out, status: 'ok', total, grade, isNew: !prev });
      writes.push({ studentId: student.id, comps, total, grade });
    });

    let saved = 0;
    if (mode === 'save' && writes.length > 0) {
      await prisma.$transaction(writes.map((w) => prisma.resultEntry.upsert({
        where: {
          studentId_subjectId_sessionId_term: {
            studentId: w.studentId, subjectId: subjRes.subject.id, sessionId: sessRes.session.id, term,
          },
        },
        create: {
          schoolId: req.user.schoolId, studentId: w.studentId, subjectId: subjRes.subject.id,
          sessionId: sessRes.session.id, term, ...w.comps, total: w.total, grade: w.grade, enteredById: req.user.id,
        },
        update: { ...w.comps, total: w.total, grade: w.grade, enteredById: req.user.id },
      })));
      saved = writes.length;
      recordAcademicEvent('RESULT_ENTERED', {
        schoolId: req.user.schoolId,
        actorId: req.user.id,
        metadata: { bulk: true, subjectId: subjRes.subject.id, sessionId: sessRes.session.id, term, saved },
      });
    }

    const count = (s) => results.filter((r) => r.status === s).length;
    res.json({
      mode,
      subject: { id: subjRes.subject.id, name: subjRes.subject.name, classId },
      term,
      components,
      summary: { rows: results.length, ok: count('ok'), unchanged: count('unchanged'), skipped: count('skipped'), errors: count('error'), saved },
      rows: results,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
