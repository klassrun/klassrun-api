// src/modules/students/student.routes.js
// ops-1-student-routes
//
// Operations 1 — Students (the roster spine for results, report cards,
// attendance, fees, promotion, portal). Inline-handler style matching
// class.routes.js / subject.routes.js. All routes scoped by req.user.schoolId.
//
// Mounted at /api/students.
//   GET    /api/students?classId=&includeArchived=   list (any auth)
//   GET    /api/students/:id                          one (any auth)
//   POST   /api/students                              create (SCHOOL_ADMIN)
//   PATCH  /api/students/:id                          edit allowlist (SCHOOL_ADMIN)
//   POST   /api/students/:id/archive                  soft-delete (SCHOOL_ADMIN)
//   POST   /api/students/:id/restore                  un-archive (SCHOOL_ADMIN)
//   POST   /api/students/photo-signature              Cloudinary sig (SCHOOL_ADMIN)

const router = require('express').Router();
const { requirePlan, requireActiveForWrites } = require('../../lib/plan-gate'); // gate-1-require
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');
const cloudinaryLib = require('../../lib/cloudinary');

const MAX_NAME = 60;
const MAX_ADMISSION = 40;

function reqString(value, label, max) {
  if (typeof value !== 'string') return { ok: false, error: `${label} is required` };
  const trimmed = value.trim();
  if (trimmed === '') return { ok: false, error: `${label} is required` };
  if (trimmed.length > max) return { ok: false, error: `${label} must be ${max} characters or fewer` };
  return { ok: true, value: trimmed };
}

function optString(value, max) {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: 'Must be text' };
  const trimmed = value.trim();
  if (trimmed.length > max) return { ok: false, error: `Must be ${max} characters or fewer` };
  return { ok: true, value: trimmed };
}

function optDate(value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { ok: false, error: 'Invalid date' };
  return { ok: true, value: d };
}

// ── GET / (list) ──────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const includeArchived = String(req.query.includeArchived || '').toLowerCase() === 'true';
    const where = { schoolId: req.user.schoolId };
    if (!includeArchived) where.archivedAt = null;
    if (req.query.classId) where.classId = String(req.query.classId);

    const students = await prisma.student.findMany({
      where,
      orderBy: [{ archivedAt: 'asc' }, { lastName: 'asc' }, { firstName: 'asc' }],
      include: { class: { select: { id: true, name: true } } },
    });

    res.json({ students });
  } catch (err) {
    next(err);
  }
});

// ── GET /:id ────────────────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const student = await prisma.student.findFirst({
      where: { id, schoolId: req.user.schoolId },
      include: { class: { select: { id: true, name: true } } },
    });
    if (!student) return res.status(404).json({ error: { message: 'Student not found' } });
    res.json({ student });
  } catch (err) {
    next(err);
  }
});

// ── POST / (create) ──────────────────────────────────────────────────────────
router.post('/', authenticate, authorize('SCHOOL_ADMIN'), requireActiveForWrites, requirePlan('STUDENTS'), /* gate-1-students-post */ async (req, res, next) => {
  try {
    const body = req.body || {};

    const adm = reqString(body.admissionNumber, 'Admission number', MAX_ADMISSION);
    if (!adm.ok) return res.status(400).json({ error: { message: adm.error, field: 'admissionNumber' } });

    const fn = reqString(body.firstName, 'First name', MAX_NAME);
    if (!fn.ok) return res.status(400).json({ error: { message: fn.error, field: 'firstName' } });

    const ln = reqString(body.lastName, 'Last name', MAX_NAME);
    if (!ln.ok) return res.status(400).json({ error: { message: ln.error, field: 'lastName' } });

    if (typeof body.classId !== 'string' || body.classId.trim() === '') {
      return res.status(400).json({ error: { message: 'classId is required', field: 'classId' } });
    }
    const cls = await prisma.class.findFirst({
      where: { id: body.classId, schoolId: req.user.schoolId },
      select: { id: true, archivedAt: true },
    });
    if (!cls) return res.status(404).json({ error: { message: 'Class not found', field: 'classId' } });
    if (cls.archivedAt) {
      return res.status(400).json({ error: { message: 'Cannot enrol into an archived class', field: 'classId' } });
    }

    const mn = optString(body.middleName, MAX_NAME);
    if (!mn.ok) return res.status(400).json({ error: { message: mn.error, field: 'middleName' } });
    const gName = optString(body.guardianName, 100);
    if (!gName.ok) return res.status(400).json({ error: { message: gName.error, field: 'guardianName' } });
    const gPhone = optString(body.guardianPhone, 30);
    if (!gPhone.ok) return res.status(400).json({ error: { message: gPhone.error, field: 'guardianPhone' } });
    const gEmail = optString(body.guardianEmail, 120);
    if (!gEmail.ok) return res.status(400).json({ error: { message: gEmail.error, field: 'guardianEmail' } });
    const dob = optDate(body.dateOfBirth);
    if (!dob.ok) return res.status(400).json({ error: { message: dob.error, field: 'dateOfBirth' } });
    const gender = optString(body.gender, 12);
    if (!gender.ok) return res.status(400).json({ error: { message: gender.error, field: 'gender' } });
    const photo = optString(body.photoUrl, 500);
    if (!photo.ok) return res.status(400).json({ error: { message: photo.error, field: 'photoUrl' } });

    const data = {
      admissionNumber: adm.value,
      firstName: fn.value,
      lastName: ln.value,
      schoolId: req.user.schoolId,
      classId: cls.id,
    };
    if (mn.value !== undefined) data.middleName = mn.value;
    if (gName.value !== undefined) data.guardianName = gName.value;
    if (gPhone.value !== undefined) data.guardianPhone = gPhone.value;
    if (gEmail.value !== undefined) data.guardianEmail = gEmail.value;
    if (dob.value !== undefined) data.dateOfBirth = dob.value;
    if (gender.value !== undefined) data.gender = gender.value;
    if (photo.value !== undefined) data.photoUrl = photo.value;

    try {
      const created = await prisma.student.create({
        data,
        include: { class: { select: { id: true, name: true } } },
      });

      recordAcademicEvent('STUDENT_CREATED', {
        schoolId: req.user.schoolId,
        actorId: req.user.id,
        metadata: { studentId: created.id, admissionNumber: created.admissionNumber, classId: created.classId },
      });

      return res.status(201).json({ student: created });
    } catch (e) {
      if (e?.code === 'P2002') {
        return res.status(409).json({
          error: { message: 'A student with that admission number already exists', field: 'admissionNumber' },
        });
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id ────────────────────────────────────────────────────────────────
router.patch('/:id', authenticate, authorize('SCHOOL_ADMIN'), requireActiveForWrites, requirePlan('STUDENTS'), /* gate-1-students-patch */ async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.student.findFirst({
      where: { id, schoolId: req.user.schoolId },
    });
    if (!existing) return res.status(404).json({ error: { message: 'Student not found' } });

    const body = req.body || {};
    const data = {};

    if ('admissionNumber' in body) {
      const c = reqString(body.admissionNumber, 'Admission number', MAX_ADMISSION);
      if (!c.ok) return res.status(400).json({ error: { message: c.error, field: 'admissionNumber' } });
      data.admissionNumber = c.value;
    }
    if ('firstName' in body) {
      const c = reqString(body.firstName, 'First name', MAX_NAME);
      if (!c.ok) return res.status(400).json({ error: { message: c.error, field: 'firstName' } });
      data.firstName = c.value;
    }
    if ('lastName' in body) {
      const c = reqString(body.lastName, 'Last name', MAX_NAME);
      if (!c.ok) return res.status(400).json({ error: { message: c.error, field: 'lastName' } });
      data.lastName = c.value;
    }
    const optMap = [
      ['middleName', MAX_NAME], ['guardianName', 100], ['guardianPhone', 30],
      ['guardianEmail', 120], ['gender', 12], ['photoUrl', 500],
    ];
    for (const [key, max] of optMap) {
      if (!(key in body)) continue;
      const c = optString(body[key], max);
      if (!c.ok) return res.status(400).json({ error: { message: c.error, field: key } });
      data[key] = c.value;
    }
    if ('dateOfBirth' in body) {
      const c = optDate(body.dateOfBirth);
      if (!c.ok) return res.status(400).json({ error: { message: c.error, field: 'dateOfBirth' } });
      data.dateOfBirth = c.value;
    }
    if ('classId' in body) {
      if (typeof body.classId !== 'string' || body.classId.trim() === '') {
        return res.status(400).json({ error: { message: 'classId must be a class id', field: 'classId' } });
      }
      const cls = await prisma.class.findFirst({
        where: { id: body.classId, schoolId: req.user.schoolId },
        select: { id: true, archivedAt: true },
      });
      if (!cls) return res.status(404).json({ error: { message: 'Class not found', field: 'classId' } });
      if (cls.archivedAt) return res.status(400).json({ error: { message: 'Cannot move into an archived class', field: 'classId' } });
      data.classId = cls.id;
    }

    if (Object.keys(data).length === 0) {
      const unchanged = await prisma.student.findFirst({
        where: { id, schoolId: req.user.schoolId },
        include: { class: { select: { id: true, name: true } } },
      });
      return res.json({ student: unchanged });
    }

    try {
      const updated = await prisma.student.update({
        where: { id },
        data,
        include: { class: { select: { id: true, name: true } } },
      });

      recordAcademicEvent('STUDENT_UPDATED', {
        schoolId: req.user.schoolId,
        actorId: req.user.id,
        metadata: { studentId: updated.id, fields: Object.keys(data) },
      });

      return res.json({ student: updated });
    } catch (e) {
      if (e?.code === 'P2002') {
        return res.status(409).json({
          error: { message: 'A student with that admission number already exists', field: 'admissionNumber' },
        });
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/archive ─────────────────────────────────────────────────────────
router.post('/:id/archive', authenticate, authorize('SCHOOL_ADMIN'), requireActiveForWrites, requirePlan('STUDENTS'), /* gate-1-students-archive */ async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.student.findFirst({ where: { id, schoolId: req.user.schoolId } });
    if (!existing) return res.status(404).json({ error: { message: 'Student not found' } });
    if (existing.archivedAt) {
      const same = await prisma.student.findFirst({
        where: { id, schoolId: req.user.schoolId },
        include: { class: { select: { id: true, name: true } } },
      });
      return res.json({ student: same });
    }
    const updated = await prisma.student.update({
      where: { id },
      data: { archivedAt: new Date() },
      include: { class: { select: { id: true, name: true } } },
    });
    recordAcademicEvent('STUDENT_ARCHIVED', {
      schoolId: req.user.schoolId, actorId: req.user.id,
      metadata: { studentId: updated.id, admissionNumber: updated.admissionNumber },
    });
    res.json({ student: updated });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/restore ─────────────────────────────────────────────────────────
router.post('/:id/restore', authenticate, authorize('SCHOOL_ADMIN'), requireActiveForWrites, requirePlan('STUDENTS'), /* gate-1-students-restore */ async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.student.findFirst({
      where: { id, schoolId: req.user.schoolId },
      include: { class: { select: { archivedAt: true } } },
    });
    if (!existing) return res.status(404).json({ error: { message: 'Student not found' } });
    if (!existing.archivedAt) {
      const same = await prisma.student.findFirst({
        where: { id, schoolId: req.user.schoolId },
        include: { class: { select: { id: true, name: true } } },
      });
      return res.json({ student: same });
    }
    if (existing.class?.archivedAt) {
      return res.status(400).json({ error: { message: 'Restore the parent class first' } });
    }
    const updated = await prisma.student.update({
      where: { id },
      data: { archivedAt: null },
      include: { class: { select: { id: true, name: true } } },
    });
    recordAcademicEvent('STUDENT_RESTORED', {
      schoolId: req.user.schoolId, actorId: req.user.id,
      metadata: { studentId: updated.id, admissionNumber: updated.admissionNumber },
    });
    res.json({ student: updated });
  } catch (err) {
    next(err);
  }
});

// ── POST /photo-signature ─────────────────────────────────────────────────────
// Signed browser upload for a student passport photo (same pattern as logos).
router.post('/photo-signature', authenticate, authorize('SCHOOL_ADMIN'), requireActiveForWrites, requirePlan('STUDENTS'), /* gate-1-students-photosig */ async (req, res, next) => {
  try {
    if (!cloudinaryLib.isConfigured || !cloudinaryLib.isConfigured()) {
      return res.status(503).json({ error: { message: 'Image upload is not configured' } });
    }
    const studentId = (req.body && typeof req.body.studentId === 'string') ? req.body.studentId : null;
    const sig = cloudinaryLib.generateStudentPhotoUploadSignature({
      schoolId: req.user.schoolId,
      studentId,
    });
    res.json({ signature: sig });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
