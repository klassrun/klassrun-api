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

// fix3-admission-v1: auto-generate the next admission number for a school.
// PREFIX/YEAR/NNN. Prefix = School.admissionPrefix, else initials from the
// school name, else 'SCH'. Existing numbers are never reformatted.
function derivePrefix(school) {
  const p = school && typeof school.admissionPrefix === 'string' ? school.admissionPrefix.trim() : '';
  if (p) return p.toUpperCase();
  const name = (school && school.name) || '';
  const initials = name.split(/\s+/).map((w) => w[0] || '').join('').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  return initials || 'SCH';
}
async function nextAdmissionNumber(schoolId) {
  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: { name: true, admissionPrefix: true },
  });
  const prefix = derivePrefix(school);
  const year = new Date().getFullYear();
  const stem = prefix + '/' + year + '/';
  const last = await prisma.student.findFirst({
    where: { schoolId, admissionNumber: { startsWith: stem } },
    orderBy: { admissionNumber: 'desc' },
    select: { admissionNumber: true },
  });
  let n = 1;
  if (last) {
    const tail = parseInt(last.admissionNumber.slice(stem.length), 10);
    if (Number.isInteger(tail) && tail >= n) n = tail + 1;
  }
  return { stem, n };
}

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

// bugfix-age-dob-v1 — DOB stays OPTIONAL; when provided it must be credible:
// a real date, in the past, age between 2 and 30 years at entry. Composes
// optDate so null/undefined/format handling stays in one place.
function optDob(value) {
  const base = optDate(value);
  if (!base.ok || base.value === undefined || base.value === null) return base;
  const d = base.value;
  const now = new Date();
  if (d.getTime() > now.getTime()) return { ok: false, error: 'Date of birth cannot be in the future' };
  const ageYears = (now.getTime() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (ageYears < 2) return { ok: false, error: 'Student must be at least 2 years old — check the date of birth' };
  if (ageYears > 30) return { ok: false, error: 'Student age must be 30 or under — check the date of birth' };
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

    // fix3-admission-v1: admission number is OPTIONAL on create.
    // Blank/absent -> auto-generated as PREFIX/YEAR/NNN at insert time.
    let admissionNumberVal = null;
    if (body.admissionNumber !== undefined && body.admissionNumber !== null && String(body.admissionNumber).trim() !== '') {
      const adm = reqString(body.admissionNumber, 'Admission number', MAX_ADMISSION);
      if (!adm.ok) return res.status(400).json({ error: { message: adm.error, field: 'admissionNumber' } });
      admissionNumberVal = adm.value;
    }

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
    const dob = optDob(body.dateOfBirth); // bugfix-age-dob-v1
    if (!dob.ok) return res.status(400).json({ error: { message: dob.error, field: 'dateOfBirth' } });
    const gender = optString(body.gender, 12);
    if (!gender.ok) return res.status(400).json({ error: { message: gender.error, field: 'gender' } });
    const photo = optString(body.photoUrl, 500);
    if (!photo.ok) return res.status(400).json({ error: { message: photo.error, field: 'photoUrl' } });

    const data = {
      admissionNumber: admissionNumberVal, // fix3-admission-v1: null -> auto-generated below
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

    // fix3-admission-v1: resolve auto-generated admission numbers with a
    // collision retry on the existing @@unique([schoolId, admissionNumber]).
    let created = null;
    const autoGen = admissionNumberVal === null;
    const seq = autoGen ? await nextAdmissionNumber(req.user.schoolId) : null;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (autoGen) data.admissionNumber = seq.stem + String(seq.n + attempt).padStart(3, '0');
      try {
        created = await prisma.student.create({
          data,
          include: { class: { select: { id: true, name: true } } },
        });
        break;
      } catch (e) {
        if (e?.code === 'P2002') {
          if (autoGen && attempt < 5) continue;
          return res.status(409).json({
            error: { message: 'A student with that admission number already exists', field: 'admissionNumber' },
          });
        }
        throw e;
      }
    }
    if (!created) {
      return res.status(409).json({ error: { message: 'Could not allocate an admission number. Try again.', field: 'admissionNumber' } });
    }
    try {

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
      const c = optDob(body.dateOfBirth); // bugfix-age-dob-v1
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
