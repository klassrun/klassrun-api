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
const { requirePlan, requireActiveForWrites } = require('../../lib/plan-gate'); // gate-1-require
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');
const { generateSchemeOfWork, ANTHROPIC_MODEL } = require('../../lib/anthropic');
const { normalizeSubject, normalizeClass, normalizeTerm, buildContextBlock } = require('../../lib/curriculum-context'); // batch-3-phase-3d-curriculum-require
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
router.post('/generate', authenticate, authorize('TEACHER'), requireActiveForWrites, /* gate-1-schemes-gen */ async (req, res, next) => {
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

    // bugfix-scheme-dedup-v1: duplicate guard BEFORE the AI call. One scheme
    // per class + subject + term (any origin); a duplicate costs zero tokens.
    const dupStamp = `${session.name} · ${termLabel(session.currentTerm)}`;
    const dupScheme = await prisma.schemeOfWork.findFirst({
      where: {
        schoolId: req.user.schoolId,
        teacherId: req.user.id,
        classId: subject.classId,
        subjectId: subject.id,
        sessionStamp: dupStamp,
        deletedAt: null,
      },
      select: { id: true, title: true, origin: true, createdAt: true },
    });
    if (dupScheme) {
      return res.status(409).json({
        error: {
          message: `A scheme of work for this class and subject already exists this term (origin: ${dupScheme.origin}). Open it, or delete it and regenerate.`,
          code: 'DUPLICATE_SCHEME',
        },
        existingScheme: dupScheme,
      });
    }

    // Call AI
    let aiResult;
    try {
      // batch-3-phase-3d-curriculum-lookup
      let curriculumContext = null;
      try {
        const _curRows = await prisma.curriculumTopic.findMany({
          where: {
            subject:   normalizeSubject(subject.name),
            className: normalizeClass(subject.class.name),
            term:      normalizeTerm(session.currentTerm),
          },
          orderBy: { week: 'asc' },
        });
        curriculumContext = buildContextBlock({ rows: _curRows, mode: 'term' });
      } catch (_curErr) {
        console.error('[curriculum] lookup non-fatal:', _curErr.message);
      }
      aiResult = await generateSchemeOfWork({
        curriculumContext,
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
router.patch('/:id', authenticate, authorize('TEACHER'), requireActiveForWrites, /* gate-1-schemes-patch */ async (req, res, next) => {
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
router.delete('/:id', authenticate, requireActiveForWrites, /* gate-1-schemes-del */ async (req, res, next) => {
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


// ════════════════════════════════════════════════════════════════════════════
// batch-4-scheme-upload-routes — Scheme Upload + Alignment (Standard tier)
//
//   POST /api/schemes/upload-signature  TEACHER — signed Cloudinary RAW upload
//   POST /api/schemes/upload            TEACHER — record uploaded file, fetch,
//                                       extract text, parse to weeks, persist
//
// Gated requireActiveForWrites → requirePlan('SCHEME_UPLOAD'), Axis-2 first,
// DORMANT (GATING_MODE observe). Persist-before-respond. Multi-tenant scoped.
// On failed parse we PERSIST an editable empty scheme (parseStatus 'failed')
// so the teacher can enter weeks by hand — never silently trust a parse.
// ════════════════════════════════════════════════════════════════════════════

const cloudinaryLib_b4 = require('../../lib/cloudinary');
const { parseSchemeFromText } = require('../../lib/anthropic');

const SCHEME_UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const SCHEME_MIN_TEXT = 40; // below this we treat the file as unreadable

// Fetch a (public) Cloudinary raw URL → Buffer, server-side.
async function _fetchToBuffer(url) {
  const resp = await fetch(url);
  if (!resp || !resp.ok) {
    const e = new Error('Could not fetch uploaded file (' + (resp ? resp.status : 'no response') + ')');
    e.code = 'FETCH_FAILED';
    throw e;
  }
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

// Extract plain text from a PDF/DOCX buffer. Parser throws (corrupt/scanned
// PDFs) become '' — caller treats short/empty uniformly as "unreadable".
async function _extractSchemeText(buffer, kind) {
  try {
    if (kind === 'pdf') {
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      const r = await parser.getText();
      if (parser.destroy) { try { await parser.destroy(); } catch (_) {} }
      return (r && r.text ? r.text : '').trim();
    }
    if (kind === 'docx') {
      const mammoth = require('mammoth');
      const r = await mammoth.extractRawText({ buffer });
      return (r && r.value ? r.value : '').trim();
    }
    return '';
  } catch (e) {
    console.error('[scheme upload] extract failed (' + kind + '):', e.message);
    return '';
  }
}

function _kindFromName(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.docx')) return 'docx';
  return null;
}

// ── POST /api/schemes/upload-signature ───────────────────────────────────
router.post('/upload-signature', authenticate, authorize('TEACHER'), requireActiveForWrites, requirePlan('SCHEME_UPLOAD'), /* gate-1-scheme-upload-sig */ async (req, res, next) => {
  try {
    if (!cloudinaryLib_b4.isConfigured || !cloudinaryLib_b4.isConfigured()) {
      return res.status(503).json({ error: { message: 'File upload is not configured. Contact support.' } });
    }
    const classId   = (req.body && typeof req.body.classId   === 'string') ? req.body.classId   : null;
    const subjectId = (req.body && typeof req.body.subjectId === 'string') ? req.body.subjectId : null;
    const sig = cloudinaryLib_b4.generateSchemeUploadSignature({
      schoolId: req.user.schoolId, classId, subjectId,
    });
    return res.json({ signature: sig });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/schemes/upload ─────────────────────────────────────────────
// Body: { classId, subjectId, fileUrl, fileName }
router.post('/upload', authenticate, authorize('TEACHER'), requireActiveForWrites, requirePlan('SCHEME_UPLOAD'), /* gate-1-scheme-upload */ async (req, res, next) => {
  try {
    const { classId, subjectId, fileUrl, fileName } = req.body || {};

    if (typeof classId !== 'string' || !classId) {
      return res.status(400).json({ error: { message: 'classId is required', field: 'classId' } });
    }
    if (typeof subjectId !== 'string' || !subjectId) {
      return res.status(400).json({ error: { message: 'subjectId is required', field: 'subjectId' } });
    }
    if (typeof fileUrl !== 'string' || !/^https:\/\/res\.cloudinary\.com\//.test(fileUrl)) {
      return res.status(400).json({ error: { message: 'A valid uploaded fileUrl is required', field: 'fileUrl' } });
    }
    const kind = _kindFromName(fileName);
    if (!kind) {
      return res.status(400).json({ error: { message: 'Only .pdf and .docx files are supported', field: 'fileName' } });
    }

    // Billing gate (mirror existing generate routes — 402 surface)
    const gate = await checkGenerationAllowed(req.user.schoolId);
    if (!gate.ok) {
      return res.status(402).json({ error: { message: gate.message } });
    }

    // Authorization — teacher owns subject; subject + class active
    const subject = await prisma.subject.findFirst({
      where: { id: subjectId, schoolId: req.user.schoolId, archivedAt: null },
      include: { class: { select: { id: true, name: true, level: true, archivedAt: true } } },
    });
    if (!subject) return res.status(404).json({ error: { message: 'Subject not found or archived' } });
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
      return res.status(400).json({ error: { message: 'Your school has no current academic session. Ask your admin to set one.' } });
    }

    // bugfix-scheme-dedup-v1: duplicate guard BEFORE the file fetch + AI
    // parse. One scheme per class + subject + term (any origin).
    const dupStamp = `${session.name} · ${termLabel(session.currentTerm)}`;
    const dupScheme = await prisma.schemeOfWork.findFirst({
      where: {
        schoolId: req.user.schoolId,
        teacherId: req.user.id,
        classId: subject.classId,
        subjectId: subject.id,
        sessionStamp: dupStamp,
        deletedAt: null,
      },
      select: { id: true, title: true, origin: true, createdAt: true },
    });
    if (dupScheme) {
      return res.status(409).json({
        error: {
          message: `A scheme of work for this class and subject already exists this term (origin: ${dupScheme.origin}). Open it, or delete it before uploading a new one.`,
          code: 'DUPLICATE_SCHEME',
        },
        existingScheme: dupScheme,
      });
    }

    // Fetch + extract text
    let buffer;
    try {
      buffer = await _fetchToBuffer(fileUrl);
    } catch (e) {
      return res.status(502).json({ error: { message: 'Could not retrieve the uploaded file. Please try uploading again.' } });
    }
    if (buffer.length > SCHEME_UPLOAD_MAX_BYTES) {
      return res.status(413).json({ error: { message: 'File is too large (max 10MB).' } });
    }

    const rawText = await _extractSchemeText(buffer, kind);
    const sessionStamp = `${session.name} · ${termLabel(session.currentTerm)}`;
    const fallbackTitle = `${subject.class.name} ${subject.name} — Uploaded scheme`;

    // Unreadable file (scanned image PDF, corrupt, empty) → 422, persist nothing.
    if (!rawText || rawText.length < SCHEME_MIN_TEXT) {
      recordAcademicEvent('SCHEME_UPLOAD_FAILED', {
        schoolId: req.user.schoolId, actorId: req.user.id,
        metadata: { reason: 'unreadable', fileName, classId, subjectId },
      });
      return res.status(422).json({
        error: { message: "We couldn't read text from this file — it may be a scanned image. Try a text-based PDF or a DOCX." },
      });
    }

    // Parse → structured weeks. On parse failure persist an EDITABLE EMPTY
    // scheme (parseStatus 'failed') so the teacher can enter weeks by hand.
    let parsedContent = null;
    let parseStatus = 'parsed';
    try {
      const parsed = await parseSchemeFromText({
        classObj: { name: subject.class.name, level: subject.class.level },
        subject:  { name: subject.name },
        rawText,
        fallbackTitle,
      });
      parsedContent = parsed.content;
    } catch (err) {
      if (err.code === 'NO_API_KEY') {
        return res.status(503).json({ error: { message: 'AI service is not configured. Contact support.' } });
      }
      // not-a-scheme / malformed / invalid / truncated / transient → persist editable empty
      console.error('[scheme upload] parse failed, persisting editable empty:', err.code, err.message);
      parseStatus = 'failed';
      parsedContent = {
        title: fallbackTitle,
        subject: subject.name,
        class: subject.class.name,
        term: '',
        overview: '',
        weeks: [],
        _parseError: err.code || 'PARSE_FAILED',
      };
    }

    // Persist BEFORE responding
    const contentWithMeta = {
      ...parsedContent,
      _metadata: {
        origin: 'uploaded',
        parseStatus,
        sourceFileName: fileName,
        parsedAt: new Date().toISOString(),
      },
    };

    const scheme = await prisma.schemeOfWork.create({
      data: {
        title:          parsedContent.title || fallbackTitle,
        content:        contentWithMeta,
        sessionStamp,
        schoolId:       req.user.schoolId,
        teacherId:      req.user.id,
        classId:        subject.classId,
        subjectId:      subject.id,
        sessionId:      session.id,
        origin:         'uploaded',
        sourceFileUrl:  fileUrl,
        sourceFileName: fileName,
        parseStatus,
      },
    });

    recordAcademicEvent(parseStatus === 'parsed' ? 'SCHEME_UPLOADED' : 'SCHEME_UPLOAD_FAILED', {
      schoolId: req.user.schoolId, actorId: req.user.id,
      metadata: { schemeId: scheme.id, subjectId: subject.id, classId: subject.classId, parseStatus, weekCount: (parsedContent.weeks || []).length, fileName },
    });

    return res.status(201).json({ scheme, parseStatus });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
