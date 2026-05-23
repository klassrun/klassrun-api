// src/modules/schemes/scheme.routes.js
//
// Batch 3 Phase 2 — Schemes of Work (CRUD + AI generation).
// Inline-handler style matching note.routes.js.
// All routes scoped by req.user.schoolId. All authenticated.
//
// Endpoints:
//   POST   /api/schemes/generate   — TEACHER, generates + persists in one shot
//   GET    /api/schemes            — TEACHER (own) | SCHOOL_ADMIN (all in school)
//   GET    /api/schemes/:id        — TEACHER (own) | SCHOOL_ADMIN (school)
//   PATCH  /api/schemes/:id        — TEACHER (own); allowlist: content only
//   DELETE /api/schemes/:id        — TEACHER (own) | SCHOOL_ADMIN; soft-delete
//
// batch-3-phase-2-schemes-routes

const router = require('express').Router();
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');
const { generateSchemeOfWork, ANTHROPIC_MODEL } = require('../../lib/anthropic');
const { checkGenerationAllowed } = require('../../lib/billing-gate');

const NOTES_MAX           = 500;
const WEEK_COUNT_MIN      = 1;
const WEEK_COUNT_MAX      = 13;
const TOPIC_MIN           = 3;
const TOPIC_MAX           = 200;
const TOPICS_MAX_COUNT    = 13;

function isStringInRange(v, min, max) {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t.length >= min && t.length <= max;
}

function termLabel(t) {
  if (t === 'FIRST') return 'Term 1';
  if (t === 'SECOND') return 'Term 2';
  if (t === 'THIRD') return 'Term 3';
  return String(t);
}

// ── POST /api/schemes/generate ───────────────────────────────────────────
router.post('/generate', authenticate, authorize('TEACHER'), async (req, res, next) => {
  try {
    const { classId, subjectId, weekCount, topics, additionalNotes } = req.body || {};

    if (typeof classId !== 'string' || !classId) {
      return res.status(400).json({ error: { message: 'classId is required', field: 'classId' } });
    }
    if (typeof subjectId !== 'string' || !subjectId) {
      return res.status(400).json({ error: { message: 'subjectId is required', field: 'subjectId' } });
    }

    let weekCountVal = 12;
    if (weekCount !== undefined && weekCount !== null && weekCount !== '') {
      const n = Number(weekCount);
      if (!Number.isInteger(n) || n < WEEK_COUNT_MIN || n > WEEK_COUNT_MAX) {
        return res.status(400).json({
          error: { message: `Week count must be an integer between ${WEEK_COUNT_MIN} and ${WEEK_COUNT_MAX}`, field: 'weekCount' },
        });
      }
      weekCountVal = n;
    }

    if (additionalNotes !== undefined && additionalNotes !== null && additionalNotes !== '') {
      if (typeof additionalNotes !== 'string' || additionalNotes.length > NOTES_MAX) {
        return res.status(400).json({
          error: { message: `Notes for AI must be a string of at most ${NOTES_MAX} characters`, field: 'additionalNotes' },
        });
      }
    }

    let topicsClean = null;
    if (topics !== undefined && topics !== null) {
      if (!Array.isArray(topics)) {
        return res.status(400).json({ error: { message: 'topics must be an array of strings', field: 'topics' } });
      }
      if (topics.length > TOPICS_MAX_COUNT) {
        return res.status(400).json({ error: { message: `At most ${TOPICS_MAX_COUNT} topics allowed`, field: 'topics' } });
      }
      const cleaned = [];
      for (const t of topics) {
        if (typeof t !== 'string') {
          return res.status(400).json({ error: { message: 'Each topic must be a string', field: 'topics' } });
        }
        const tt = t.trim();
        if (tt.length < TOPIC_MIN || tt.length > TOPIC_MAX) {
          return res.status(400).json({
            error: { message: `Each topic must be ${TOPIC_MIN}-${TOPIC_MAX} characters`, field: 'topics' },
          });
        }
        cleaned.push(tt);
      }
      topicsClean = cleaned.length > 0 ? cleaned : null;
      // If teacher provided strict topics, weekCount must equal topics.length
      if (topicsClean && topicsClean.length !== weekCountVal) {
        return res.status(400).json({
          error: {
            message: `When topics are provided, weekCount must equal the number of topics (got weekCount=${weekCountVal}, topics.length=${topicsClean.length})`,
            field: 'topics',
          },
        });
      }
    }

    // Billing gate
    const gate = await checkGenerationAllowed(req.user.schoolId);
    if (!gate.ok) {
      return res.status(402).json({ error: { message: gate.message } });
    }

    // Authorization — teacher owns subject, subject + class active
    const subject = await prisma.subject.findFirst({
      where: { id: subjectId, schoolId: req.user.schoolId, archivedAt: null },
      include: {
        class: { select: { id: true, name: true, level: true, archivedAt: true } },
      },
    });
    if (!subject) {
      return res.status(404).json({ error: { message: 'Subject not found or archived' } });
    }
    if (!subject.class || subject.class.archivedAt) {
      return res.status(400).json({ error: { message: 'Parent class is archived' } });
    }
    if (subject.classId !== classId) {
      return res.status(400).json({ error: { message: 'Subject does not belong to this class', field: 'classId' } });
    }
    if (subject.teacherId !== req.user.id) {
      return res.status(403).json({ error: { message: 'You are not assigned to this subject' } });
    }

    // Current session
    const session = await prisma.academicSession.findFirst({
      where: { schoolId: req.user.schoolId, isCurrent: true },
    });
    if (!session) {
      return res.status(400).json({
        error: { message: 'Your school has no current academic session. Ask your admin to set one.' },
      });
    }

    // Call AI
    let aiResult;
    try {
      aiResult = await generateSchemeOfWork({
        classObj:        { name: subject.class.name, level: subject.class.level },
        subject:         { name: subject.name },
        session:         { name: session.name, currentTerm: session.currentTerm },
        weekCount:       weekCountVal,
        topics:          topicsClean,
        additionalNotes,
      });
    } catch (err) {
      if (err.code === 'NO_API_KEY') {
        console.error('[POST /api/schemes/generate] ANTHROPIC_API_KEY missing');
        return res.status(503).json({ error: { message: 'AI service is not configured. Contact support.' } });
      }
      if (err.code === 'AI_REFUSED') {
        return res.status(422).json({ error: { message: 'The AI declined this request. Please rephrase or adjust your inputs.' } });
      }
      if (err.code === 'AI_ERROR_OBJECT') {
        return res.status(422).json({ error: { message: err.detail || 'AI could not generate a scheme for this combination.' } });
      }
      if (err.code === 'AI_TRANSIENT') {
        return res.status(503).json({ error: { message: 'AI service is busy. Please try again in a minute.' } });
      }
      if (err.code === 'AI_PERMANENT') {
        console.error('[POST /api/schemes/generate] AI_PERMANENT error — needs admin attention:', err.message);
        return res.status(503).json({ error: { message: 'AI service is misconfigured. Please contact support.' } });
      }
      if (err.code === 'AI_TRUNCATED') {
        return res.status(422).json({
          error: { message: 'The AI ran out of space writing this scheme. Try fewer weeks or provide explicit topics.' },
        });
      }
      if (err.code === 'AI_MALFORMED' || err.code === 'AI_INVALID') {
        return res.status(503).json({ error: { message: 'AI returned an unusable response. Please try again.' } });
      }
      console.error('[POST /api/schemes/generate] AI call failed:', {
        code: err && err.code, name: err && err.name, status: err && err.status, message: err && err.message,
        stack: err && err.stack ? err.stack.split('\n').slice(0, 5).join(' | ') : null,
      });
      return res.status(503).json({ error: { message: 'AI service temporarily unavailable. Please try again.' } });
    }

    // Persist BEFORE responding
    const sessionStamp = `${session.name} · ${termLabel(session.currentTerm)}`;
    const contentWithMeta = {
      ...aiResult.content,
      _metadata: {
        model:        aiResult.model,
        inputTokens:  aiResult.inputTokens,
        outputTokens: aiResult.outputTokens,
        generatedAt:  aiResult.generatedAt,
      },
    };

    const scheme = await prisma.schemeOfWork.create({
      data: {
        title:        aiResult.content.title,
        content:      contentWithMeta,
        sessionStamp,
        schoolId:     req.user.schoolId,
        teacherId:    req.user.id,
        classId:      subject.classId,
        subjectId:    subject.id,
        sessionId:    session.id,
      },
    });

    // Audit
    recordAcademicEvent('SCHEME_GENERATED', {
      schoolId: req.user.schoolId,
      actorId:  req.user.id,
      metadata: {
        schemeId:     scheme.id,
        subjectId:    subject.id,
        classId:      subject.classId,
        weekCount:    weekCountVal,
        topicsCount:  topicsClean ? topicsClean.length : 0,
        model:        aiResult.model,
        inputTokens:  aiResult.inputTokens,
        outputTokens: aiResult.outputTokens,
      },
    });

    return res.status(201).json({ scheme });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/schemes ─────────────────────────────────────────────────────
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

    const schemes = await prisma.schemeOfWork.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        subject: { select: { id: true, name: true } },
        class:   { select: { id: true, name: true, level: true } },
        teacher: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    res.json({ schemes });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/schemes/:id ─────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const scheme = await prisma.schemeOfWork.findFirst({
      where: { id, schoolId: req.user.schoolId, deletedAt: null },
      include: {
        subject: { select: { id: true, name: true } },
        class:   { select: { id: true, name: true, level: true } },
        teacher: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    if (!scheme) {
      return res.status(404).json({ error: { message: 'Scheme of work not found' } });
    }
    if (req.user.role === 'TEACHER' && scheme.teacherId !== req.user.id) {
      return res.status(404).json({ error: { message: 'Scheme of work not found' } });
    }
    res.json({ scheme });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/schemes/:id ───────────────────────────────────────────────
router.patch('/:id', authenticate, authorize('TEACHER'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.schemeOfWork.findFirst({
      where: { id, schoolId: req.user.schoolId, teacherId: req.user.id, deletedAt: null },
    });
    if (!existing) {
      return res.status(404).json({ error: { message: 'Scheme of work not found' } });
    }

    const { content } = req.body || {};
    if (content === undefined) {
      return res.status(400).json({ error: { message: 'content is required', field: 'content' } });
    }
    if (typeof content !== 'object' || content === null || Array.isArray(content)) {
      return res.status(400).json({ error: { message: 'content must be an object', field: 'content' } });
    }

    const history = Array.isArray(existing.editHistory) ? existing.editHistory.slice() : [];
    history.push({
      editedAt: new Date().toISOString(),
      previousContent: existing.content,
    });

    const updated = await prisma.schemeOfWork.update({
      where: { id },
      data: { content, isEdited: true, editHistory: history },
    });

    recordAcademicEvent('SCHEME_EDITED', {
      schoolId: req.user.schoolId,
      actorId:  req.user.id,
      metadata: { schemeId: updated.id },
    });

    res.json({ scheme: updated });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/schemes/:id ──────────────────────────────────────────────
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const where = { id, schoolId: req.user.schoolId, deletedAt: null };
    if (req.user.role === 'TEACHER') {
      where.teacherId = req.user.id;
    } else if (req.user.role !== 'SCHOOL_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: { message: 'Forbidden' } });
    }

    const existing = await prisma.schemeOfWork.findFirst({ where });
    if (!existing) {
      return res.status(404).json({ error: { message: 'Scheme of work not found' } });
    }

    await prisma.schemeOfWork.update({
      where: { id: existing.id },
      data:  { deletedAt: new Date() },
    });

    recordAcademicEvent('SCHEME_DISCARDED', {
      schoolId: req.user.schoolId,
      actorId:  req.user.id,
      metadata: { schemeId: existing.id },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
