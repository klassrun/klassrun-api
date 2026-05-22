// src/modules/notes/note.routes.js
//
// Batch 3 Phase 1 — Lesson notes (CRUD + AI generation).
// Inline-handler style matching class.routes.js / subject.routes.js.
// All routes scoped by req.user.schoolId. All authenticated.
//
// Endpoints:
//   POST   /api/notes/generate    — TEACHER, generates + persists in one shot
//   GET    /api/notes             — TEACHER (own) | SCHOOL_ADMIN (all in school)
//   GET    /api/notes/:id         — TEACHER (own) | SCHOOL_ADMIN (school)
//   PATCH  /api/notes/:id         — TEACHER (own); allowlist: content only
//   DELETE /api/notes/:id         — TEACHER (own) | SCHOOL_ADMIN; soft-delete
//
// batch-3-phase-1-notes-routes

const router = require('express').Router();
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');
const { generateLessonNote, ANTHROPIC_MODEL } = require('../../lib/anthropic');
const { checkGenerationAllowed } = require('../../lib/billing-gate');

const TOPIC_MIN = 3;
const TOPIC_MAX = 200;
const NOTES_MAX = 500;
const WEEK_MIN  = 1;
const WEEK_MAX  = 13;
const DURATION_MIN = 10;
const DURATION_MAX = 240;
// batch-3-phase-1-5-subtopics
const SUB_TOPIC_MIN = 1;
const SUB_TOPIC_MAX = 100;
const SUB_TOPICS_MAX_COUNT = 10;

function isStringInRange(v, min, max) {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t.length >= min && t.length <= max;
}

// ── POST /api/notes/generate ─────────────────────────────────────────────
// TEACHER-only. Generates AI lesson note, persists, returns saved record.
router.post('/generate', authenticate, authorize('TEACHER'), async (req, res, next) => {
  try {
    const { classId, subjectId, topic, week, duration, additionalNotes, subTopics } = req.body || {};

    // ── Validate input ──
    if (typeof classId !== 'string' || !classId) {
      return res.status(400).json({ error: { message: 'classId is required', field: 'classId' } });
    }
    if (typeof subjectId !== 'string' || !subjectId) {
      return res.status(400).json({ error: { message: 'subjectId is required', field: 'subjectId' } });
    }
    if (!isStringInRange(topic, TOPIC_MIN, TOPIC_MAX)) {
      return res.status(400).json({
        error: { message: `Topic must be ${TOPIC_MIN}-${TOPIC_MAX} characters`, field: 'topic' },
      });
    }
    let weekVal = null;
    if (week !== undefined && week !== null && week !== '') {
      const n = Number(week);
      if (!Number.isInteger(n) || n < WEEK_MIN || n > WEEK_MAX) {
        return res.status(400).json({
          error: { message: `Week must be an integer between ${WEEK_MIN} and ${WEEK_MAX}`, field: 'week' },
        });
      }
      weekVal = n;
    }
    let durationVal = 40;
    if (duration !== undefined && duration !== null && duration !== '') {
      const n = Number(duration);
      if (!Number.isInteger(n) || n < DURATION_MIN || n > DURATION_MAX) {
        return res.status(400).json({
          error: { message: `Duration must be ${DURATION_MIN}-${DURATION_MAX} minutes`, field: 'duration' },
        });
      }
      durationVal = n;
    }
    if (additionalNotes !== undefined && additionalNotes !== null && additionalNotes !== '') {
      if (typeof additionalNotes !== 'string' || additionalNotes.length > NOTES_MAX) {
        return res.status(400).json({
          error: { message: `Notes for AI must be a string of at most ${NOTES_MAX} characters`, field: 'additionalNotes' },
        });
      }
    }

    // batch-3-phase-1-5-subtopics-validate
    let subTopicsClean = null;
    if (subTopics !== undefined && subTopics !== null) {
      if (!Array.isArray(subTopics)) {
        return res.status(400).json({
          error: { message: 'subTopics must be an array of strings', field: 'subTopics' },
        });
      }
      if (subTopics.length > SUB_TOPICS_MAX_COUNT) {
        return res.status(400).json({
          error: { message: `At most ${SUB_TOPICS_MAX_COUNT} sub-topics allowed`, field: 'subTopics' },
        });
      }
      const cleaned = [];
      for (const s of subTopics) {
        if (typeof s !== 'string') {
          return res.status(400).json({
            error: { message: 'Each sub-topic must be a string', field: 'subTopics' },
          });
        }
        const t = s.trim();
        if (t.length < SUB_TOPIC_MIN || t.length > SUB_TOPIC_MAX) {
          return res.status(400).json({
            error: { message: `Each sub-topic must be ${SUB_TOPIC_MIN}-${SUB_TOPIC_MAX} characters`, field: 'subTopics' },
          });
        }
        cleaned.push(t);
      }
      subTopicsClean = cleaned.length > 0 ? cleaned : null;
    }

    // ── Billing gate (402) ──
    const gate = await checkGenerationAllowed(req.user.schoolId);
    if (!gate.ok) {
      return res.status(402).json({ error: { message: gate.message } });
    }

    // ── Authorization: teacher must own the subject; subject + class active ──
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

    // ── Need a current session for sessionStamp + sessionId ──
    const session = await prisma.academicSession.findFirst({
      where: { schoolId: req.user.schoolId, isCurrent: true },
    });
    if (!session) {
      return res.status(400).json({
        error: { message: 'Your school has no current academic session. Ask your admin to set one.' },
      });
    }

    // ── Call AI ──
    let aiResult;
    try {
      aiResult = await generateLessonNote({
        classObj:        { name: subject.class.name, level: subject.class.level },
        subject:         { name: subject.name },
        topic:           topic.trim(),
        week:            weekVal,
        duration:        durationVal,
        session:         { name: session.name, currentTerm: session.currentTerm },
        additionalNotes: additionalNotes,
        subTopics:       subTopicsClean,
      });
    } catch (err) {
      if (err.code === 'NO_API_KEY') {
        console.error('[POST /api/notes/generate] ANTHROPIC_API_KEY missing');
        return res.status(503).json({
          error: { message: 'AI service is not configured. Contact support.' },
        });
      }
      if (err.code === 'AI_REFUSED') {
        return res.status(422).json({
          error: { message: 'The AI declined this topic. Please rephrase or pick a different topic.' },
        });
      }
      if (err.code === 'AI_ERROR_OBJECT') {
        return res.status(422).json({
          error: { message: err.detail || 'AI could not generate a note for this topic.' },
        });
      }
      // hotfix-batch-3-phase-1-5-cost-control
      if (err.code === 'AI_TRANSIENT') {
        // 429 rate limit or 529 overloaded — Anthropic-side issue, transient.
        return res.status(503).json({
          error: { message: 'AI service is busy. Please try again in a minute.' },
        });
      }
      if (err.code === 'AI_PERMANENT') {
        // 400/401/403 — bad input, auth, or billing issue. Will not self-resolve.
        console.error('[POST /api/notes/generate] AI_PERMANENT error — needs admin attention:', err.message);
        return res.status(503).json({
          error: { message: 'AI service is misconfigured. Please contact support.' },
        });
      }
      // hotfix-batch-3-phase-1-5-max-tokens
      if (err.code === 'AI_TRUNCATED') {
        return res.status(422).json({
          error: { message: 'The AI ran out of space writing this note. Try again, or provide sub-topics to focus the output.' },
        });
      }
      if (err.code === 'AI_MALFORMED' || err.code === 'AI_INVALID') {
        return res.status(503).json({
          error: { message: 'AI returned an unusable response. Please try again.' },
        });
      }
      // AI_API_ERROR or anything else
      // hotfix-batch-3-phase-1-5-diagnostic-logs
      console.error('[POST /api/notes/generate] AI call failed:', {
        code:    err && err.code,
        name:    err && err.name,
        status:  err && err.status,
        message: err && err.message,
        stack:   err && err.stack ? err.stack.split('\n').slice(0, 5).join(' | ') : null,
      });
      return res.status(503).json({
        error: { message: 'AI service temporarily unavailable. Please try again.' },
      });
    }

    // ── Persist BEFORE responding (locked decision) ──
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

    const note = await prisma.lessonNote.create({
      data: {
        topic:        topic.trim(),
        week:         weekVal,
        content:      contentWithMeta,
        sessionStamp,
        schoolId:     req.user.schoolId,
        teacherId:    req.user.id,
        classId:      subject.classId,
        subjectId:    subject.id,
        sessionId:    session.id,
      },
    });

    // ── Audit ──
    recordAcademicEvent('LESSON_NOTE_GENERATED', {
      schoolId: req.user.schoolId,
      actorId:  req.user.id,
      metadata: {
        noteId:       note.id,
        subjectId:    subject.id,
        classId:      subject.classId,
        topic:        topic.trim(),
        model:        aiResult.model,
        inputTokens:  aiResult.inputTokens,
        outputTokens: aiResult.outputTokens,
        subTopics:    subTopicsClean,
      },
    });

    return res.status(201).json({ note });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/notes ───────────────────────────────────────────────────────
// TEACHER: own notes only. SCHOOL_ADMIN: all notes in school.
router.get('/', authenticate, async (req, res, next) => {
  try {
    const where = {
      schoolId: req.user.schoolId,
      deletedAt: null,
    };
    if (req.user.role === 'TEACHER') {
      where.teacherId = req.user.id;
    } else if (req.user.role !== 'SCHOOL_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: { message: 'Forbidden' } });
    }

    if (req.query.classId)   where.classId   = String(req.query.classId);
    if (req.query.subjectId) where.subjectId = String(req.query.subjectId);

    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const notes = await prisma.lessonNote.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        subject: { select: { id: true, name: true } },
        class:   { select: { id: true, name: true, level: true } },
        teacher: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    res.json({ notes });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/notes/:id ───────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const note = await prisma.lessonNote.findFirst({
      where: { id, schoolId: req.user.schoolId, deletedAt: null },
      include: {
        subject: { select: { id: true, name: true } },
        class:   { select: { id: true, name: true, level: true } },
        teacher: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    if (!note) {
      return res.status(404).json({ error: { message: 'Lesson note not found' } });
    }
    // Teachers can only see their own
    if (req.user.role === 'TEACHER' && note.teacherId !== req.user.id) {
      return res.status(404).json({ error: { message: 'Lesson note not found' } });
    }
    res.json({ note });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/notes/:id ─────────────────────────────────────────────────
// Allowlist: content only. Teacher-owned, not deleted.
router.patch('/:id', authenticate, authorize('TEACHER'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.lessonNote.findFirst({
      where: { id, schoolId: req.user.schoolId, teacherId: req.user.id, deletedAt: null },
    });
    if (!existing) {
      return res.status(404).json({ error: { message: 'Lesson note not found' } });
    }

    const { content } = req.body || {};
    if (content === undefined) {
      return res.status(400).json({ error: { message: 'content is required', field: 'content' } });
    }
    if (typeof content !== 'object' || content === null || Array.isArray(content)) {
      return res.status(400).json({ error: { message: 'content must be an object', field: 'content' } });
    }

    // Append to editHistory
    const history = Array.isArray(existing.editHistory) ? existing.editHistory.slice() : [];
    history.push({
      editedAt: new Date().toISOString(),
      previousContent: existing.content,
    });

    const updated = await prisma.lessonNote.update({
      where: { id },
      data: {
        content,
        isEdited: true,
        editHistory: history,
      },
    });

    recordAcademicEvent('LESSON_NOTE_EDITED', {
      schoolId: req.user.schoolId,
      actorId:  req.user.id,
      metadata: { noteId: updated.id },
    });

    res.json({ note: updated });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/notes/:id ────────────────────────────────────────────────
// Soft-delete. TEACHER can delete own; SCHOOL_ADMIN can delete any in school.
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const where = { id, schoolId: req.user.schoolId, deletedAt: null };
    if (req.user.role === 'TEACHER') {
      where.teacherId = req.user.id;
    } else if (req.user.role !== 'SCHOOL_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: { message: 'Forbidden' } });
    }

    const existing = await prisma.lessonNote.findFirst({ where });
    if (!existing) {
      return res.status(404).json({ error: { message: 'Lesson note not found' } });
    }

    await prisma.lessonNote.update({
      where: { id: existing.id },
      data:  { deletedAt: new Date() },
    });

    recordAcademicEvent('LESSON_NOTE_DISCARDED', {
      schoolId: req.user.schoolId,
      actorId:  req.user.id,
      metadata: { noteId: existing.id },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function termLabel(t) {
  if (t === 'FIRST') return 'Term 1';
  if (t === 'SECOND') return 'Term 2';
  if (t === 'THIRD') return 'Term 3';
  return String(t);
}

module.exports = router;
