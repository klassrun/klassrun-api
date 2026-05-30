// src/modules/assessments/assessment.routes.js
//
// Batch 3 Phase 3a — Exam Questions (CRUD + AI generation + question bank save).
// Inline-handler style matching scheme.routes.js.
// All routes scoped by req.user.schoolId.
//
// Endpoints:
//   POST   /api/assessments/generate   — TEACHER, generates + persists + saves to bank
//   GET    /api/assessments            — TEACHER (own) | SCHOOL_ADMIN (all in school)
//   GET    /api/assessments/:id        — TEACHER (own) | SCHOOL_ADMIN (school)
//   PATCH  /api/assessments/:id        — TEACHER (own); allowlist: questions only
//   DELETE /api/assessments/:id        — TEACHER (own) | SCHOOL_ADMIN; soft-delete
//
// batch-3-phase-3a-assessments-routes

const router   = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { authenticate, authorize } = require('../../middleware/auth');
const prisma   = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');
const { generateExamQuestions, ANTHROPIC_MODEL } = require('../../lib/anthropic');
const { checkGenerationAllowed } = require('../../lib/billing-gate');

const TOPIC_MIN      = 3;
const TOPIC_MAX      = 200;
const NOTES_MAX      = 500;
const COUNT_MIN      = 1;
const COUNT_MAX      = 50;
const VALID_TYPES    = ['objective', 'theory', 'essay'];
const VALID_DIFF     = ['easy', 'medium', 'hard'];

function termLabel(t) {
  if (t === 'FIRST')  return 'Term 1';
  if (t === 'SECOND') return 'Term 2';
  if (t === 'THIRD')  return 'Term 3';
  return String(t);
}

// ── POST /api/assessments/generate ──────────────────────────────────────────
router.post('/generate', authenticate, authorize('TEACHER'), async (req, res, next) => {
  try {
    const { classId, subjectId, topic, questionType, count, difficulty, duration, markPerQuestion, additionalNotes } = req.body || {};

    // Validate required
    if (typeof classId !== 'string' || !classId)
      return res.status(400).json({ error: { message: 'classId is required', field: 'classId' } });
    if (typeof subjectId !== 'string' || !subjectId)
      return res.status(400).json({ error: { message: 'subjectId is required', field: 'subjectId' } });
    if (typeof topic !== 'string' || topic.trim().length < TOPIC_MIN || topic.trim().length > TOPIC_MAX)
      return res.status(400).json({ error: { message: `topic must be ${TOPIC_MIN}-${TOPIC_MAX} characters`, field: 'topic' } });
    if (!VALID_TYPES.includes(questionType))
      return res.status(400).json({ error: { message: `questionType must be one of: ${VALID_TYPES.join(', ')}`, field: 'questionType' } });

    // count
    let countVal = 10;
    if (count !== undefined && count !== null && count !== '') {
      const n = Number(count);
      if (!Number.isInteger(n) || n < COUNT_MIN || n > COUNT_MAX)
        return res.status(400).json({ error: { message: `count must be an integer between ${COUNT_MIN} and ${COUNT_MAX}`, field: 'count' } });
      countVal = n;
    }

    // difficulty
    const diffVal = VALID_DIFF.includes(difficulty) ? difficulty : 'medium';

    // duration
    let durationVal = null;
    if (duration !== undefined && duration !== null && duration !== '') {
      const d = Number(duration);
      if (!Number.isInteger(d) || d < 1 || d > 600)
        return res.status(400).json({ error: { message: 'duration must be 1-600 minutes', field: 'duration' } });
      durationVal = d;
    }

    // markPerQuestion
    let markVal = null;
    if (markPerQuestion !== undefined && markPerQuestion !== null && markPerQuestion !== '') {
      const m = Number(markPerQuestion);
      if (!Number.isInteger(m) || m < 1 || m > 100)
        return res.status(400).json({ error: { message: 'markPerQuestion must be 1-100', field: 'markPerQuestion' } });
      markVal = m;
    }

    // additionalNotes
    if (additionalNotes !== undefined && additionalNotes !== null && additionalNotes !== '') {
      if (typeof additionalNotes !== 'string' || additionalNotes.length > NOTES_MAX)
        return res.status(400).json({ error: { message: `additionalNotes must be at most ${NOTES_MAX} characters`, field: 'additionalNotes' } });
    }

    // Billing gate
    const gate = await checkGenerationAllowed(req.user.schoolId);
    if (!gate.ok) return res.status(402).json({ error: { message: gate.message } });

    // Authorization — teacher owns subject, subject + class active
    const subject = await prisma.subject.findFirst({
      where: { id: subjectId, schoolId: req.user.schoolId, archivedAt: null },
      include: { class: { select: { id: true, name: true, level: true, archivedAt: true } } },
    });
    if (!subject) return res.status(404).json({ error: { message: 'Subject not found or archived' } });
    if (!subject.class || subject.class.archivedAt)
      return res.status(400).json({ error: { message: 'Parent class is archived' } });
    if (subject.classId !== classId)
      return res.status(400).json({ error: { message: 'Subject does not belong to this class', field: 'classId' } });
    if (subject.teacherId !== req.user.id)
      return res.status(403).json({ error: { message: 'You are not assigned to this subject' } });

    // Current session
    const session = await prisma.academicSession.findFirst({
      where: { schoolId: req.user.schoolId, isCurrent: true },
    });
    if (!session)
      return res.status(400).json({ error: { message: 'Your school has no current academic session. Ask your admin to set one.' } });

    // Call AI
    let aiResult;
    try {
      aiResult = await generateExamQuestions({
        classObj:       { name: subject.class.name, level: subject.class.level },
        subject:        { name: subject.name },
        topic:          topic.trim(),
        questionType,
        count:          countVal,
        difficulty:     diffVal,
        duration:       durationVal,
        markPerQuestion: markVal,
        session:        { name: session.name, currentTerm: session.currentTerm },
        additionalNotes,
      });
    } catch (err) {
      if (err.code === 'NO_API_KEY') {
        console.error('[POST /api/assessments/generate] ANTHROPIC_API_KEY missing');
        return res.status(503).json({ error: { message: 'AI service is not configured. Contact support.' } });
      }
      if (err.code === 'AI_REFUSED')    return res.status(422).json({ error: { message: 'The AI declined this request. Please rephrase your topic.' } });
      if (err.code === 'AI_ERROR_OBJECT') return res.status(422).json({ error: { message: err.detail || 'AI could not generate questions for this combination.' } });
      if (err.code === 'AI_TRANSIENT')  return res.status(503).json({ error: { message: 'AI service is busy. Please try again in a minute.' } });
      if (err.code === 'AI_PERMANENT') {
        console.error('[POST /api/assessments/generate] AI_PERMANENT:', err.message);
        return res.status(503).json({ error: { message: 'AI service is misconfigured. Contact support.' } });
      }
      if (err.code === 'AI_TRUNCATED')  return res.status(422).json({ error: { message: 'The AI ran out of space. Try fewer questions or a narrower topic.' } });
      if (err.code === 'AI_MALFORMED' || err.code === 'AI_INVALID')
        return res.status(503).json({ error: { message: 'AI returned an unusable response. Please try again.' } });
      console.error('[POST /api/assessments/generate] unexpected error:', { code: err?.code, message: err?.message });
      return res.status(503).json({ error: { message: 'AI service temporarily unavailable. Please try again.' } });
    }

    const sessionStamp = `${session.name} · ${termLabel(session.currentTerm)}`;
    const totalMarks   = markVal ? countVal * markVal : null;

    const contentWithMeta = {
      ...aiResult.content,
      _metadata: {
        model:        aiResult.model,
        inputTokens:  aiResult.inputTokens,
        outputTokens: aiResult.outputTokens,
        generatedAt:  aiResult.generatedAt,
      },
    };

    // Persist Assessment BEFORE responding
    const assessment = await prisma.assessment.create({
      data: {
        title:        aiResult.content.title,
        questions:    contentWithMeta,
        totalMarks,
        duration:     durationVal,
        sessionStamp,
        schoolId:     req.user.schoolId,
        teacherId:    req.user.id,
        classId:      subject.classId,
        subjectId:    subject.id,
        sessionId:    session.id,
      },
    });

    // Save each question to QuestionBankEntry (UUID fingerprint — no dedup in 3.3a)
    // batch-3-phase-3a-bank-save
    const questions = Array.isArray(aiResult.content.questions) ? aiResult.content.questions : [];
    const bankSavePromises = questions.map((q) =>
      prisma.questionBankEntry.create({
        data: {
          question:     q.question,
          options:      q.options || null,
          answer:       q.answer  || null,
          questionType,
          difficulty:   q.difficulty || diffVal,
          topic:        topic.trim(),
          fingerprint:  uuidv4(), // Phase 3.3b: replace with normalized hash
          waecAligned:  false,
          schoolId:     req.user.schoolId,
          subjectId:    subject.id,
        },
      }).catch((err) => {
        // Non-fatal: log and continue (bank save failure must not break the response)
        console.error('[bank-save] failed for one question:', err.message);
      })
    );
    await Promise.all(bankSavePromises);

    // Audit
    recordAcademicEvent('QUESTION_GENERATED', {
      schoolId: req.user.schoolId,
      actorId:  req.user.id,
      metadata: {
        assessmentId:  assessment.id,
        subjectId:     subject.id,
        classId:       subject.classId,
        questionType,
        count:         countVal,
        difficulty:    diffVal,
        model:         aiResult.model,
        inputTokens:   aiResult.inputTokens,
        outputTokens:  aiResult.outputTokens,
      },
    });

    return res.status(201).json({
      assessment: {
        ...assessment,
        subject: { id: subject.id, name: subject.name },
        class:   { id: subject.class.id, name: subject.class.name, level: subject.class.level },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/assessments ─────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const where = { schoolId: req.user.schoolId, deletedAt: null };
    if (req.user.role === 'TEACHER') {
      where.teacherId = req.user.id;
    } else if (req.user.role !== 'SCHOOL_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: { message: 'Forbidden' } });
    }
    if (req.query.classId)   where.classId   = String(req.query.classId);
    if (req.query.subjectId) where.subjectId = String(req.query.subjectId);

    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const assessments = await prisma.assessment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        subject: { select: { id: true, name: true } },
        class:   { select: { id: true, name: true, level: true } },
        teacher: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    res.json({ assessments });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/assessments/:id ─────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const assessment = await prisma.assessment.findFirst({
      where: { id, schoolId: req.user.schoolId, deletedAt: null },
      include: {
        subject: { select: { id: true, name: true } },
        class:   { select: { id: true, name: true, level: true } },
        teacher: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    if (!assessment) return res.status(404).json({ error: { message: 'Assessment not found' } });
    if (req.user.role === 'TEACHER' && assessment.teacherId !== req.user.id)
      return res.status(404).json({ error: { message: 'Assessment not found' } });
    res.json({ assessment });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/assessments/:id ───────────────────────────────────────────────
router.patch('/:id', authenticate, authorize('TEACHER'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.assessment.findFirst({
      where: { id, schoolId: req.user.schoolId, teacherId: req.user.id, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ error: { message: 'Assessment not found' } });

    const { questions } = req.body || {};
    if (questions === undefined)
      return res.status(400).json({ error: { message: 'questions is required', field: 'questions' } });
    if (typeof questions !== 'object' || questions === null)
      return res.status(400).json({ error: { message: 'questions must be an object', field: 'questions' } });

    const updated = await prisma.assessment.update({
      where: { id },
      data:  { questions },
    });

    recordAcademicEvent('ASSESSMENT_EDITED', {
      schoolId: req.user.schoolId,
      actorId:  req.user.id,
      metadata: { assessmentId: updated.id },
    });

    res.json({ assessment: updated });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/assessments/:id ──────────────────────────────────────────────
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const where = { id, schoolId: req.user.schoolId, deletedAt: null };
    if (req.user.role === 'TEACHER') {
      where.teacherId = req.user.id;
    } else if (req.user.role !== 'SCHOOL_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: { message: 'Forbidden' } });
    }

    const existing = await prisma.assessment.findFirst({ where });
    if (!existing) return res.status(404).json({ error: { message: 'Assessment not found' } });

    await prisma.assessment.update({
      where: { id: existing.id },
      data:  { deletedAt: new Date() },
    });

    recordAcademicEvent('ASSESSMENT_DISCARDED', {
      schoolId: req.user.schoolId,
      actorId:  req.user.id,
      metadata: { assessmentId: existing.id },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
