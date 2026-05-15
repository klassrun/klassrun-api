// src/modules/sessions/session.routes.js
//
// Batch 2C Phase 1 — Sessions & Terms.
// Inline-handler style matching school.routes.js (no separate controller/service).
// All routes scoped by req.user.schoolId. All authenticated.
//
// Endpoints:
//   GET    /api/sessions                       — list (any authenticated user)
//   POST   /api/sessions                       — create (SCHOOL_ADMIN)
//   PATCH  /api/sessions/:id                   — edit dates only (SCHOOL_ADMIN)
//   POST   /api/sessions/:id/make-current      — atomic current swap (SCHOOL_ADMIN)
//   POST   /api/sessions/:id/advance-term      — FIRST→SECOND→THIRD (SCHOOL_ADMIN)
//
// batch-2c-phase-1-sessions

const router = require('express').Router();
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');

const TERMS = ['FIRST', 'SECOND', 'THIRD'];

// ── GET /api/sessions ─────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const sessions = await prisma.academicSession.findMany({
      where: { schoolId: req.user.schoolId },
      orderBy: [{ isCurrent: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/sessions ────────────────────────────────────────────────────
router.post('/', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { name, startDate, endDate, makeCurrent } = req.body || {};

    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: { message: 'Session name is required' } });
    }
    const trimmedName = name.trim();
    if (trimmedName.length > 50) {
      return res.status(400).json({ error: { message: 'Session name must be 50 characters or fewer' } });
    }

    const data = {
      name: trimmedName,
      schoolId: req.user.schoolId,
      currentTerm: 'FIRST',
      isCurrent: false,
    };

    if (startDate !== undefined && startDate !== null) {
      const d = new Date(startDate);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: { message: 'Invalid start date' } });
      }
      data.startDate = d;
    }
    if (endDate !== undefined && endDate !== null) {
      const d = new Date(endDate);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: { message: 'Invalid end date' } });
      }
      data.endDate = d;
    }

    const shouldMakeCurrent = makeCurrent === true;

    try {
      const session = await prisma.$transaction(async (tx) => {
        const created = await tx.academicSession.create({ data });
        if (shouldMakeCurrent) {
          await tx.academicSession.updateMany({
            where: {
              schoolId: req.user.schoolId,
              isCurrent: true,
              id: { not: created.id },
            },
            data: { isCurrent: false },
          });
          return tx.academicSession.update({
            where: { id: created.id },
            data: { isCurrent: true },
          });
        }
        return created;
      });

      recordAcademicEvent('SESSION_CREATED', {
        schoolId: req.user.schoolId,
        actorId: req.user.id,
        metadata: { sessionId: session.id, name: session.name },
      });

      if (shouldMakeCurrent) {
        recordAcademicEvent('SESSION_MADE_CURRENT', {
          schoolId: req.user.schoolId,
          actorId: req.user.id,
          metadata: { sessionId: session.id, name: session.name },
        });
      }

      return res.status(201).json({ session });
    } catch (e) {
      if (e?.code === 'P2002') {
        return res.status(409).json({
          error: { message: 'A session with that name already exists', field: 'name' },
        });
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/sessions/:id (dates only) ──────────────────────────────────
router.patch('/:id', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const existing = await prisma.academicSession.findFirst({
      where: { id, schoolId: req.user.schoolId },
    });
    if (!existing) {
      return res.status(404).json({ error: { message: 'Session not found' } });
    }

    const allowed = ['startDate', 'endDate'];
    const data = {};

    for (const key of allowed) {
      if (!(key in (req.body || {}))) continue;
      const value = req.body[key];
      if (value === null) { data[key] = null; continue; }
      const d = new Date(value);
      if (isNaN(d.getTime())) {
        return res.status(400).json({
          error: { message: `Invalid ${key === 'startDate' ? 'start' : 'end'} date` },
        });
      }
      data[key] = d;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: { message: 'No editable fields provided' } });
    }

    const session = await prisma.academicSession.update({
      where: { id },
      data,
    });
    res.json({ session });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/sessions/:id/make-current ───────────────────────────────────
router.post('/:id/make-current', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const target = await prisma.academicSession.findFirst({
      where: { id, schoolId: req.user.schoolId },
    });
    if (!target) {
      return res.status(404).json({ error: { message: 'Session not found' } });
    }

    if (target.isCurrent) {
      return res.json({ session: target }); // no-op
    }

    const previousCurrent = await prisma.academicSession.findFirst({
      where: { schoolId: req.user.schoolId, isCurrent: true },
      select: { id: true },
    });

    const session = await prisma.$transaction(async (tx) => {
      await tx.academicSession.updateMany({
        where: { schoolId: req.user.schoolId, isCurrent: true, id: { not: id } },
        data: { isCurrent: false },
      });
      return tx.academicSession.update({
        where: { id },
        data: { isCurrent: true },
      });
    });

    recordAcademicEvent('SESSION_MADE_CURRENT', {
      schoolId: req.user.schoolId,
      actorId: req.user.id,
      metadata: {
        sessionId: session.id,
        name: session.name,
        previousCurrentId: previousCurrent?.id ?? null,
      },
    });

    res.json({ session });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/sessions/:id/advance-term ───────────────────────────────────
router.post('/:id/advance-term', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const target = await prisma.academicSession.findFirst({
      where: { id, schoolId: req.user.schoolId },
    });
    if (!target) {
      return res.status(404).json({ error: { message: 'Session not found' } });
    }
    if (!target.isCurrent) {
      return res.status(400).json({
        error: { message: 'Term can only be advanced on the current session' },
      });
    }

    const fromTerm = target.currentTerm;
    const idx = TERMS.indexOf(fromTerm);
    if (idx < 0 || idx === TERMS.length - 1) {
      return res.status(400).json({
        error: { message: 'Cannot advance — already at Third Term' },
      });
    }
    const toTerm = TERMS[idx + 1];

    const session = await prisma.academicSession.update({
      where: { id },
      data: { currentTerm: toTerm },
    });

    recordAcademicEvent('TERM_ADVANCED', {
      schoolId: req.user.schoolId,
      actorId: req.user.id,
      metadata: { sessionId: session.id, fromTerm, toTerm },
    });

    res.json({ session });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
