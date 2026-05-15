// src/modules/classes/class.routes.js
//
// Batch 2C Phase 2 — Classes (CRUD + Archive).
// Inline-handler style matching session.routes.js (no separate controller/service).
// All routes scoped by req.user.schoolId. All authenticated.
//
// Endpoints:
//   GET    /api/classes?includeArchived=true|false  — list (any authenticated user)
//   POST   /api/classes                              — create (SCHOOL_ADMIN)
//   PATCH  /api/classes/:id                          — edit name/level (SCHOOL_ADMIN)
//   POST   /api/classes/:id/archive                  — soft-delete (SCHOOL_ADMIN)
//   POST   /api/classes/:id/restore                  — un-archive (SCHOOL_ADMIN)
//
// batch-2c-phase-2-classes-routes

const router = require('express').Router();
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');

const LEVELS = ['junior', 'senior'];
const MAX_NAME = 30;

function validateLevel(value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  if (!LEVELS.includes(value)) return { ok: false };
  return { ok: true, value };
}

function validateName(value) {
  if (typeof value !== 'string') return { ok: false, error: 'Class name is required' };
  const trimmed = value.trim();
  if (trimmed === '') return { ok: false, error: 'Class name is required' };
  if (trimmed.length > MAX_NAME) {
    return { ok: false, error: `Class name must be ${MAX_NAME} characters or fewer` };
  }
  return { ok: true, value: trimmed };
}

// ── GET /api/classes ─────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const includeArchived = String(req.query.includeArchived || '').toLowerCase() === 'true';
    const where = { schoolId: req.user.schoolId };
    if (!includeArchived) where.archivedAt = null;

    const classes = await prisma.class.findMany({
      where,
      orderBy: [
        { archivedAt: 'asc' }, // NULLS FIRST in Postgres for ASC by default
        { level: 'asc' },
        { name: 'asc' },
      ],
      include: {
        _count: { select: { subjects: true } },
      },
    });

    res.json({ classes });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/classes ────────────────────────────────────────────────────
router.post('/', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { name, level } = req.body || {};

    const nameCheck = validateName(name);
    if (!nameCheck.ok) {
      return res.status(400).json({ error: { message: nameCheck.error, field: 'name' } });
    }

    const levelCheck = validateLevel(level);
    if (!levelCheck.ok) {
      return res.status(400).json({
        error: { message: 'Level must be "junior", "senior", or omitted', field: 'level' },
      });
    }

    const data = {
      name: nameCheck.value,
      schoolId: req.user.schoolId,
    };
    if (levelCheck.value !== undefined) data.level = levelCheck.value;

    try {
      const created = await prisma.class.create({ data });

      recordAcademicEvent('CLASS_CREATED', {
        schoolId: req.user.schoolId,
        actorId: req.user.id,
        metadata: { classId: created.id, name: created.name, level: created.level },
      });

      return res.status(201).json({ class: created });
    } catch (e) {
      if (e?.code === 'P2002') {
        return res.status(409).json({
          error: { message: 'A class with that name already exists', field: 'name' },
        });
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/classes/:id ───────────────────────────────────────────────
router.patch('/:id', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const existing = await prisma.class.findFirst({
      where: { id, schoolId: req.user.schoolId },
    });
    if (!existing) {
      return res.status(404).json({ error: { message: 'Class not found' } });
    }

    const allowed = ['name', 'level'];
    const data = {};
    const changes = {};

    for (const key of allowed) {
      if (!(key in (req.body || {}))) continue;
      if (key === 'name') {
        const check = validateName(req.body.name);
        if (!check.ok) {
          return res.status(400).json({ error: { message: check.error, field: 'name' } });
        }
        if (check.value !== existing.name) {
          data.name = check.value;
          changes.name = { from: existing.name, to: check.value };
        }
      } else if (key === 'level') {
        const check = validateLevel(req.body.level);
        if (!check.ok) {
          return res.status(400).json({
            error: { message: 'Level must be "junior", "senior", or null', field: 'level' },
          });
        }
        const newLevel = check.value === undefined ? existing.level : check.value;
        if (newLevel !== existing.level) {
          data.level = newLevel;
          changes.level = { from: existing.level, to: newLevel };
        }
      }
    }

    if (Object.keys(data).length === 0) {
      return res.json({ class: existing });
    }

    try {
      const updated = await prisma.class.update({
        where: { id },
        data,
      });

      recordAcademicEvent('CLASS_UPDATED', {
        schoolId: req.user.schoolId,
        actorId: req.user.id,
        metadata: { classId: updated.id, changes },
      });

      res.json({ class: updated });
    } catch (e) {
      if (e?.code === 'P2002') {
        return res.status(409).json({
          error: { message: 'A class with that name already exists', field: 'name' },
        });
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// ── POST /api/classes/:id/archive ────────────────────────────────────────
router.post('/:id/archive', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const existing = await prisma.class.findFirst({
      where: { id, schoolId: req.user.schoolId },
    });
    if (!existing) {
      return res.status(404).json({ error: { message: 'Class not found' } });
    }

    if (existing.archivedAt) {
      return res.json({ class: existing }); // no-op
    }

    const updated = await prisma.class.update({
      where: { id },
      data: { archivedAt: new Date() },
    });

    recordAcademicEvent('CLASS_ARCHIVED', {
      schoolId: req.user.schoolId,
      actorId: req.user.id,
      metadata: { classId: updated.id, name: updated.name },
    });

    res.json({ class: updated });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/classes/:id/restore ────────────────────────────────────────
router.post('/:id/restore', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const existing = await prisma.class.findFirst({
      where: { id, schoolId: req.user.schoolId },
    });
    if (!existing) {
      return res.status(404).json({ error: { message: 'Class not found' } });
    }

    if (!existing.archivedAt) {
      return res.json({ class: existing }); // no-op
    }

    const updated = await prisma.class.update({
      where: { id },
      data: { archivedAt: null },
    });

    recordAcademicEvent('CLASS_RESTORED', {
      schoolId: req.user.schoolId,
      actorId: req.user.id,
      metadata: { classId: updated.id, name: updated.name },
    });

    res.json({ class: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
