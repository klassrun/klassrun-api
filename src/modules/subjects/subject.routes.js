// src/modules/subjects/subject.routes.js
//
// Batch 2C Phase 3a — Subjects (CRUD + Archive).
// Inline-handler style matching class.routes.js / session.routes.js.
// All routes scoped by req.user.schoolId. All authenticated.
//
// Dual-mounted in app.js:
//   /api/classes/:classId/subjects   → list/create (classId in req.params)
//   /api/subjects                    → id-addressed: PATCH, archive, restore
//
// batch-2c-phase-3a-subjects-routes

const router = require('express').Router({ mergeParams: true });
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');

const MAX_NAME = 50;

function validateName(value) {
  if (typeof value !== 'string') return { ok: false, error: 'Subject name is required' };
  const trimmed = value.trim();
  if (trimmed === '') return { ok: false, error: 'Subject name is required' };
  if (trimmed.length > MAX_NAME) {
    return { ok: false, error: `Subject name must be ${MAX_NAME} characters or fewer` };
  }
  return { ok: true, value: trimmed };
}

// ── GET / (list) ─────────────────────────────────────────────────────────
// Mounted at /api/classes/:classId/subjects → classId from req.params
// Also mounted at /api/subjects, but list without classId is not supported.
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { classId } = req.params;
    if (!classId) {
      return res.status(400).json({ error: { message: 'classId required' } });
    }

    // Verify class exists in this school
    const cls = await prisma.class.findFirst({
      where: { id: classId, schoolId: req.user.schoolId },
      select: { id: true },
    });
    if (!cls) {
      return res.status(404).json({ error: { message: 'Class not found' } });
    }

    const includeArchived = String(req.query.includeArchived || '').toLowerCase() === 'true';
    const where = { schoolId: req.user.schoolId, classId };
    if (!includeArchived) where.archivedAt = null;

    const subjects = await prisma.subject.findMany({
      where,
      orderBy: [
        { archivedAt: 'asc' },
        { name: 'asc' },
      ],
    });

    res.json({ subjects });
  } catch (err) {
    next(err);
  }
});

// ── POST / (create) ──────────────────────────────────────────────────────
// Mounted at /api/classes/:classId/subjects
router.post('/', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { classId } = req.params;
    if (!classId) {
      return res.status(400).json({ error: { message: 'classId required' } });
    }

    // Verify class exists and isn't archived
    const cls = await prisma.class.findFirst({
      where: { id: classId, schoolId: req.user.schoolId },
    });
    if (!cls) {
      return res.status(404).json({ error: { message: 'Class not found' } });
    }
    if (cls.archivedAt) {
      return res.status(400).json({
        error: { message: 'Cannot add subjects to an archived class' },
      });
    }

    const { name } = req.body || {};
    const nameCheck = validateName(name);
    if (!nameCheck.ok) {
      return res.status(400).json({ error: { message: nameCheck.error, field: 'name' } });
    }

    try {
      const created = await prisma.subject.create({
        data: {
          name: nameCheck.value,
          schoolId: req.user.schoolId,
          classId,
        },
      });

      recordAcademicEvent('SUBJECT_CREATED', {
        schoolId: req.user.schoolId,
        actorId: req.user.id,
        metadata: { subjectId: created.id, classId, name: created.name },
      });

      return res.status(201).json({ subject: created });
    } catch (e) {
      if (e?.code === 'P2002') {
        return res.status(409).json({
          error: { message: 'A subject with that name already exists in this class', field: 'name' },
        });
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id ───────────────────────────────────────────────────────────
// Mounted at /api/subjects/:id (allowlist: name only in 3a)
router.patch('/:id', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const existing = await prisma.subject.findFirst({
      where: { id, schoolId: req.user.schoolId },
    });
    if (!existing) {
      return res.status(404).json({ error: { message: 'Subject not found' } });
    }

    // Allowlist: name only. teacherId silently dropped (Phase 3b activates).
    const allowed = ['name'];
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
      }
    }

    if (Object.keys(data).length === 0) {
      return res.json({ subject: existing });
    }

    try {
      const updated = await prisma.subject.update({
        where: { id },
        data,
      });

      recordAcademicEvent('SUBJECT_UPDATED', {
        schoolId: req.user.schoolId,
        actorId: req.user.id,
        metadata: { subjectId: updated.id, changes },
      });

      res.json({ subject: updated });
    } catch (e) {
      if (e?.code === 'P2002') {
        return res.status(409).json({
          error: { message: 'A subject with that name already exists in this class', field: 'name' },
        });
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/archive ────────────────────────────────────────────────────
router.post('/:id/archive', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const existing = await prisma.subject.findFirst({
      where: { id, schoolId: req.user.schoolId },
    });
    if (!existing) {
      return res.status(404).json({ error: { message: 'Subject not found' } });
    }

    if (existing.archivedAt) {
      return res.json({ subject: existing }); // no-op
    }

    const updated = await prisma.subject.update({
      where: { id },
      data: { archivedAt: new Date() },
    });

    recordAcademicEvent('SUBJECT_ARCHIVED', {
      schoolId: req.user.schoolId,
      actorId: req.user.id,
      metadata: { subjectId: updated.id, name: updated.name },
    });

    res.json({ subject: updated });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/restore ────────────────────────────────────────────────────
router.post('/:id/restore', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const existing = await prisma.subject.findFirst({
      where: { id, schoolId: req.user.schoolId },
      include: { class: { select: { archivedAt: true } } },
    });
    if (!existing) {
      return res.status(404).json({ error: { message: 'Subject not found' } });
    }

    if (!existing.archivedAt) {
      return res.json({ subject: existing }); // no-op
    }

    if (existing.class?.archivedAt) {
      return res.status(400).json({
        error: { message: 'Restore the parent class first' },
      });
    }

    const updated = await prisma.subject.update({
      where: { id },
      data: { archivedAt: null },
    });

    recordAcademicEvent('SUBJECT_RESTORED', {
      schoolId: req.user.schoolId,
      actorId: req.user.id,
      metadata: { subjectId: updated.id, name: updated.name },
    });

    res.json({ subject: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
