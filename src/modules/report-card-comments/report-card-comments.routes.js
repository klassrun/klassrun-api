// src/modules/report-card-comments/report-card-comments.routes.js
// ops-2-comment-routes
//
// Operations 2 — AI report-card comments. Mounted at /api/report-cards/comments
// (MUST be mounted BEFORE /api/report-cards so the literal "comments" path is not
// captured by that router's GET /:id). SCHOOL_ADMIN-only.
//   GET  /api/report-cards/comments?classId=&sessionId=&term=   list
//   POST /api/report-cards/comments/generate                    AI (billing-gated)
//   PUT  /api/report-cards/comments                             manual save/edit (ungated)
//
// AI generation is the ONE billing-gated operations endpoint (it incurs AI cost).
// Persist-before-respond. Comments are read into the report-card snapshot at
// /generate time (see report-card.routes.js ops-2-generate-fold).

const router = require('express').Router();
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');
const { checkGenerationAllowed } = require('../../lib/billing-gate');
const { generateReportCardComments } = require('../../lib/anthropic');
const grading = require('../../lib/grading');
const { BEHAVIOUR_ATTRS } = require('../../lib/pdf/report-card-pdf');

const TERMS = ['FIRST', 'SECOND', 'THIRD'];
function normTerm(value) {
  const t = String(value || '').toUpperCase();
  return TERMS.includes(t) ? t : null;
}
function fullName(s) {
  return [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
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

// Map our internal AI error codes to HTTP statuses (self-contained).
const AI_STATUS = {
  NO_API_KEY: 503, AI_REFUSED: 422, AI_ERROR_OBJECT: 422, AI_TRUNCATED: 502,
  AI_TRANSIENT: 503, AI_PERMANENT: 502, AI_API_ERROR: 502, AI_MALFORMED: 502, AI_INVALID: 502,
};

// ── GET / (list) ──────────────────────────────────────────────────────────────
router.get('/', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const where = { schoolId: req.user.schoolId };
    if (req.query.sessionId) where.sessionId = String(req.query.sessionId);
    const term = req.query.term ? normTerm(req.query.term) : null;
    if (req.query.term && !term) {
      return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });
    }
    if (term) where.term = term;
    if (req.query.classId) {
      const ids = await prisma.student.findMany({
        where: { schoolId: req.user.schoolId, classId: String(req.query.classId) },
        select: { id: true },
      });
      where.studentId = { in: ids.map((s) => s.id) };
    }
    const comments = await prisma.reportCardComment.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: { student: { select: { id: true, admissionNumber: true, firstName: true, middleName: true, lastName: true } } },
    });
    res.json({ comments });
  } catch (err) {
    next(err);
  }
});

// ── POST /generate (AI; billing-gated) ───────────────────────────────────────
router.post('/generate', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    // Billing gate FIRST — this is the one operations endpoint that incurs AI cost.
    const gate = await checkGenerationAllowed(req.user.schoolId);
    if (!gate.ok) return res.status(402).json({ error: { message: gate.message, code: 'TRIAL_ENDED' } });

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
      include: { class: { select: { name: true } } },
    });
    if (!student) return res.status(404).json({ error: { message: 'Student not found', field: 'studentId' } });

    // Build this student's own performance context (no class-wide ranking needed).
    const entries = await prisma.resultEntry.findMany({
      where: { schoolId: req.user.schoolId, studentId: student.id, sessionId: sessRes.session.id, term },
    });
    const subjIds = [...new Set(entries.map((e) => e.subjectId))];
    const subjs = subjIds.length
      ? await prisma.subject.findMany({ where: { id: { in: subjIds }, schoolId: req.user.schoolId }, select: { id: true, name: true } })
      : [];
    const nameById = {}; subjs.forEach((s) => { nameById[s.id] = s.name; });
    const subjects = entries.map((e) => {
      const g = grading.gradeFor(e.total);
      return { name: nameById[e.subjectId] || 'Subject', total: e.total, grade: g.grade, remark: g.remark };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const count = entries.length;
    const aggregate = entries.reduce((sum, e) => sum + e.total, 0);
    const average = count > 0 ? Math.round((aggregate / count) * 100) / 100 : 0;

    const att = await prisma.attendanceRecord.findUnique({
      where: { studentId_sessionId_term: { studentId: student.id, sessionId: sessRes.session.id, term } },
    });
    const beh = await prisma.behaviourRecord.findUnique({
      where: { studentId_sessionId_term: { studentId: student.id, sessionId: sessRes.session.id, term } },
    });
    const behaviour = beh && beh.ratings && typeof beh.ratings === 'object'
      ? BEHAVIOUR_ATTRS.map((attribute) => {
          const v = beh.ratings[attribute];
          return { attribute, score: Number.isInteger(v) && v >= 1 && v <= 5 ? v : null };
        })
      : [];

    let gen;
    try {
      gen = await generateReportCardComments({
        student: { fullName: fullName(student), class: student.class ? student.class.name : null },
        session: sessRes.session.name,
        term,
        summary: { subjectsCount: count, average },
        subjects,
        attendance: att ? { schoolOpened: att.schoolOpened, present: att.present, absent: att.absent } : null,
        behaviour,
      });
    } catch (e) {
      if (e && e.code && AI_STATUS[e.code]) {
        return res.status(AI_STATUS[e.code]).json({ error: { message: 'AI comment generation failed', code: e.code } });
      }
      throw e;
    }

    // Persist before responding.
    const comment = await prisma.reportCardComment.upsert({
      where: { studentId_sessionId_term: { studentId: student.id, sessionId: sessRes.session.id, term } },
      create: {
        schoolId: req.user.schoolId, studentId: student.id, sessionId: sessRes.session.id, term,
        classTeacher: gen.content.classTeacher, principal: gen.content.principal,
        source: 'ai', aiModel: gen.model, aiGeneratedAt: new Date(), generatedById: req.user.id,
      },
      update: {
        classTeacher: gen.content.classTeacher, principal: gen.content.principal,
        source: 'ai', aiModel: gen.model, aiGeneratedAt: new Date(), generatedById: req.user.id,
      },
    });

    recordAcademicEvent('REPORT_CARD_COMMENT_GENERATED', {
      schoolId: req.user.schoolId, actorId: req.user.id,
      metadata: { studentId: student.id, sessionId: sessRes.session.id, term, model: gen.model },
    });

    res.json({ comment });
  } catch (err) {
    next(err);
  }
});

// ── PUT / (manual save/edit; ungated) ─────────────────────────────────────────
router.put('/', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
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

    const classTeacher = typeof body.classTeacher === 'string' ? body.classTeacher.trim() || null : null;
    const principal = typeof body.principal === 'string' ? body.principal.trim() || null : null;

    const comment = await prisma.reportCardComment.upsert({
      where: { studentId_sessionId_term: { studentId: student.id, sessionId: sessRes.session.id, term } },
      create: {
        schoolId: req.user.schoolId, studentId: student.id, sessionId: sessRes.session.id, term,
        classTeacher, principal, source: 'manual', generatedById: req.user.id,
      },
      update: { classTeacher, principal, source: 'edited', generatedById: req.user.id },
    });

    recordAcademicEvent('REPORT_CARD_COMMENT_EDITED', {
      schoolId: req.user.schoolId, actorId: req.user.id,
      metadata: { studentId: student.id, sessionId: sessRes.session.id, term },
    });

    res.json({ comment });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
