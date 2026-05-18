// src/modules/subjects/subject.routes.js
//
// Batch 2C Phase 3a + 3b — Subjects (CRUD + Archive + Teacher Assignment).
// Inline-handler style matching class.routes.js / session.routes.js.
// All routes scoped by req.user.schoolId. All authenticated.
//
// Dual-mounted in app.js:
//   /api/classes/:classId/subjects   → list/create (classId in req.params)
//   /api/subjects                    → id-addressed: PATCH, archive, restore
//
// batch-2c-phase-3a-subjects-routes
// batch-2c-phase-3b-subjects-include-teacher
// batch-2c-phase-3b-subjects-patch-teacher

const router = require('express').Router({ mergeParams: true });
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');

const MAX_NAME = 50;

// Prisma include for embedding the assigned teacher in subject responses.
const TEACHER_INCLUDE = {
  teacher: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
};

function validateName(value) {
  if (typeof value !== 'string') return { ok: false, error: 'Subject name is required' };
  const trimmed = value.trim();
  if (trimmed === '') return { ok: false, error: 'Subject name is required' };
  if (trimmed.length > MAX_NAME) {
    return { ok: false, error: `Subject name must be ${MAX_NAME} characters or fewer` };
  }
  return { ok: true, value: trimmed };
}

function teacherDisplayName(t) {
  if (!t) return null;
  return `${t.firstName} ${t.lastName}`.trim();
}

// ── GET / (list) ─────────────────────────────────────────────────────────
// Mounted at /api/classes/:classId/subjects → classId from req.params
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { classId } = req.params;
    if (!classId) {
      return res.status(400).json({ error: { message: 'classId required' } });
    }

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
      include: TEACHER_INCLUDE,
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
router.post('/', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { classId } = req.params;
    if (!classId) {
      return res.status(400).json({ error: { message: 'classId required' } });
    }

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
        include: TEACHER_INCLUDE,
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
// Allowlist: name, teacherId (3b activates teacherId).
router.patch('/:id', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const existing = await prisma.subject.findFirst({
      where: { id, schoolId: req.user.schoolId },
      include: TEACHER_INCLUDE,
    });
    if (!existing) {
      return res.status(404).json({ error: { message: 'Subject not found' } });
    }

    const allowed = ['name', 'teacherId'];
    const data = {};
    const changes = {};
    let teacherChange = null; // { from: {id, name}|null, to: {id, name}|null }

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

      if (key === 'teacherId') {
        // Coerce empty string to null
        let nextId = req.body.teacherId;
        if (nextId === '' || nextId === undefined) nextId = null;

        if (nextId !== null && typeof nextId !== 'string') {
          return res.status(400).json({
            error: { message: 'teacherId must be a string or null', field: 'teacherId' },
          });
        }

        const prevId = existing.teacherId || null;

        if (nextId !== prevId) {
          if (nextId !== null) {
            // Validate: must be a TEACHER, same school, not revoked
            const teacher = await prisma.user.findFirst({
              where: {
                id: nextId,
                schoolId: req.user.schoolId,
                role: 'TEACHER',
                revokedAt: null,
              },
              select: { id: true, firstName: true, lastName: true },
            });
            if (!teacher) {
              return res.status(400).json({
                error: {
                  message: 'Teacher not found or not active in this school',
                  field: 'teacherId',
                },
              });
            }
            data.teacherId = teacher.id;
            teacherChange = {
              from: existing.teacher
                ? { id: existing.teacher.id, name: teacherDisplayName(existing.teacher) }
                : null,
              to: { id: teacher.id, name: teacherDisplayName(teacher) },
            };
          } else {
            // Unassign
            data.teacherId = null;
            teacherChange = {
              from: existing.teacher
                ? { id: existing.teacher.id, name: teacherDisplayName(existing.teacher) }
                : null,
              to: null,
            };
          }
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
        include: TEACHER_INCLUDE,
      });

      // Emit SUBJECT_UPDATED for name changes (if any)
      if (changes.name) {
        recordAcademicEvent('SUBJECT_UPDATED', {
          schoolId: req.user.schoolId,
          actorId: req.user.id,
          metadata: { subjectId: updated.id, changes },
        });
      }

      // Emit teacher events for teacher changes
      if (teacherChange) {
        // Reassignment (uuid-A → uuid-B) → emit BOTH unassign(A) and assign(B)
        if (teacherChange.from && teacherChange.to) {
          recordAcademicEvent('SUBJECT_TEACHER_UNASSIGNED', {
            schoolId: req.user.schoolId,
            actorId: req.user.id,
            metadata: {
              subjectId: updated.id,
              previousTeacherId: teacherChange.from.id,
              previousTeacherName: teacherChange.from.name,
            },
          });
          recordAcademicEvent('SUBJECT_TEACHER_ASSIGNED', {
            schoolId: req.user.schoolId,
            actorId: req.user.id,
            metadata: {
              subjectId: updated.id,
              teacherId: teacherChange.to.id,
              teacherName: teacherChange.to.name,
            },
          });
        } else if (teacherChange.to) {
          // null → uuid
          recordAcademicEvent('SUBJECT_TEACHER_ASSIGNED', {
            schoolId: req.user.schoolId,
            actorId: req.user.id,
            metadata: {
              subjectId: updated.id,
              teacherId: teacherChange.to.id,
              teacherName: teacherChange.to.name,
            },
          });
        } else if (teacherChange.from) {
          // uuid → null
          recordAcademicEvent('SUBJECT_TEACHER_UNASSIGNED', {
            schoolId: req.user.schoolId,
            actorId: req.user.id,
            metadata: {
              subjectId: updated.id,
              previousTeacherId: teacherChange.from.id,
              previousTeacherName: teacherChange.from.name,
            },
          });
        }
      }

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
      include: TEACHER_INCLUDE,
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
      include: TEACHER_INCLUDE,
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
