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

const express = require('express'); // students-bulk-v1
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
    // enrollment-b1-v1: an Enrollment row has to anchor to a session. Without a
    // current one there is nothing to anchor to, and a missing row degrades
    // silently into an empty roster rather than a loud failure (spec 2.2).
    const currentSession = await prisma.academicSession.findFirst({
      where: { schoolId: req.user.schoolId, isCurrent: true },
      select: { id: true },
    });
    if (!currentSession) {
      return res.status(400).json({
        error: { message: 'Set a current academic session before adding students.', field: 'sessionId' },
      });
    }

    let created = null;
    const autoGen = admissionNumberVal === null;
    const seq = autoGen ? await nextAdmissionNumber(req.user.schoolId) : null;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (autoGen) data.admissionNumber = seq.stem + String(seq.n + attempt).padStart(3, '0');
      try {
        // enrollment-b1-v1: the transaction lives INSIDE the retry loop on purpose.
        // A P2002 collision on the auto-generated admission number rolls the
        // whole attempt back, so a retry can never leave an orphan enrollment.
        created = await prisma.$transaction(async (tx) => {
          const st = await tx.student.create({
            data,
            include: { class: { select: { id: true, name: true } } },
          });
          await tx.enrollment.create({
            data: {
              schoolId: req.user.schoolId,
              studentId: st.id,
              sessionId: currentSession.id,
              classId: st.classId,
              isCurrent: true,
            },
          });
          return st;
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
      const updated = await prisma.$transaction(async (tx) => {
        const st = await tx.student.update({
          where: { id },
          data,
          include: { class: { select: { id: true, name: true } } },
        });
        // enrollment-b1-v1: a classId change HERE is a correction - the student was
        // filed in the wrong class - so it rewrites the CURRENT session row.
        // Promotion is the only operation that enrolls into a new session.
        if (data.classId) {
          const ses = await tx.academicSession.findFirst({
            where: { schoolId: req.user.schoolId, isCurrent: true },
            select: { id: true },
          });
          if (ses) {
            await tx.enrollment.upsert({
              where: { studentId_sessionId: { studentId: st.id, sessionId: ses.id } },
              update: { classId: st.classId, isCurrent: true },
              create: {
                schoolId: req.user.schoolId,
                studentId: st.id,
                sessionId: ses.id,
                classId: st.classId,
                isCurrent: true,
              },
            });
          }
        }
        return st;
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


// ============================================================================
// students-bulk-v1: bulk student upload
//
// Parsing rules are MOLEK-REBUILD-SPEC 10.2. Each one is a real bug that has
// bitten a real school: Excel's BOM, Excel's trailing header spaces, a single
// typo aborting a 70-row import, and "3 rows skipped" with no way to find them.
// ============================================================================

const BULK_MAX_ROWS = 300; // spec 9.2: keep the transaction inside its timeout

// utf-8-sig + RFC4180. Handles quoted fields containing commas, newlines and
// doubled quotes - guardian names really do contain commas.
function bulkParseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = []; let field = ''; let inQ = false; let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function bulkNormHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function bulkToRecords(text) {
  const rows = bulkParseCsv(text);
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map(bulkNormHeader);
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const first = String(cells[0] || '').trim();
    if (cells.every((c) => String(c || '').trim() === '')) continue;
    if (first.startsWith('#')) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = cells[idx] === undefined ? '' : String(cells[idx]).trim(); });
    obj.__line = r + 1; // the line number the admin sees in Excel
    records.push(obj);
  }
  return { headers, records };
}

// Accepts YYYY-MM-DD and DD/MM/YYYY. Nigerian schools write both.
function bulkParseDob(raw) {
  if (!raw) return { ok: true, value: undefined };
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  let y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = /^(\d{1,2})[\/](\d{1,2})[\/](\d{4})$/.exec(raw);
    if (!m) return { ok: false, error: 'date_of_birth must be YYYY-MM-DD or DD/MM/YYYY' };
    d = +m[1]; mo = +m[2]; y = +m[3];
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, error: 'date_of_birth is not a real date' };
  }
  if (dt.getTime() > Date.now()) return { ok: false, error: 'date_of_birth is in the future' };
  return { ok: true, value: dt };
}

const BULK_TEMPLATE_HEADERS = [
  'admission_number', 'first_name', 'last_name', 'middle_name', 'class',
  'gender', 'date_of_birth', 'guardian_name', 'guardian_phone', 'guardian_email',
];

// GET /api/students/bulk/template
// Two segments, so it can never be captured by GET /:id.
router.get('/bulk/template', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const classes = await prisma.class.findMany({
      where: { schoolId: req.user.schoolId, archivedAt: null },
      orderBy: { name: 'asc' }, select: { name: true },
    });
    const names = classes.map((c) => c.name).join(', ') || '(no classes yet - create one first)';
    const lines = [
      BULK_TEMPLATE_HEADERS.join(','),
      ',,,,,,,,,',
      '',
      '# HOW TO USE THIS FILE',
      '# 1. One student per row. Delete these # lines or leave them - they are ignored.',
      '# 2. Required: first_name, last_name, class.',
      '# 3. class must match a class name exactly (case does not matter).',
      '#    Your classes: ' + names.replace(/,/g, ';'),
      '# 4. Leave admission_number BLANK and one will be generated for you.',
      '#    Fill it in and the student is UPDATED instead - that makes this file',
      '#    safe to correct and re-upload without creating duplicates.',
      '# 5. date_of_birth: YYYY-MM-DD or DD/MM/YYYY.',
      '# 6. Maximum ' + BULK_MAX_ROWS + ' students per upload. Split larger lists.',
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="klassrun-students-template.csv"');
    return res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
  } catch (err) { next(err); }
});

// POST /api/students/bulk    Content-Type: text/csv
router.post(
  '/bulk',
  authenticate,
  authorize('SCHOOL_ADMIN'),
  requireActiveForWrites,
  requirePlan('STUDENTS'),
  express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }),
  async (req, res, next) => {
    try {
      const text = typeof req.body === 'string' ? req.body : '';
      if (!text.trim()) {
        return res.status(400).json({ error: { message: 'Send the CSV as the request body with Content-Type: text/csv' } });
      }

      const { headers, records } = bulkToRecords(text);
      if (headers.indexOf('first_name') === -1 || headers.indexOf('last_name') === -1 || headers.indexOf('class') === -1) {
        return res.status(400).json({ error: { message: 'CSV must have first_name, last_name and class columns. Download the template.' } });
      }
      if (records.length === 0) {
        return res.status(400).json({ error: { message: 'No data rows found in the CSV' } });
      }
      if (records.length > BULK_MAX_ROWS) {
        return res.status(400).json({ error: { message: 'Too many rows (' + records.length + '). Maximum is ' + BULK_MAX_ROWS + ' per upload.' } });
      }

      // Same rule as single create: an Enrollment row needs a session to anchor to.
      const currentSession = await prisma.academicSession.findFirst({
        where: { schoolId: req.user.schoolId, isCurrent: true }, select: { id: true },
      });
      if (!currentSession) {
        return res.status(400).json({ error: { message: 'Set a current academic session before adding students.', field: 'sessionId' } });
      }

      // ONE query for classes, ONE for existing students (spec 10.3).
      const classes = await prisma.class.findMany({
        where: { schoolId: req.user.schoolId, archivedAt: null }, select: { id: true, name: true },
      });
      const classByName = new Map(classes.map((c) => [c.name.trim().toLowerCase(), c.id]));

      const askedAdmissions = records
        .map((r) => String(r.admission_number || '').trim().toUpperCase())
        .filter((a) => a !== '');
      const existing = askedAdmissions.length === 0 ? [] : await prisma.student.findMany({
        where: { schoolId: req.user.schoolId, admissionNumber: { in: askedAdmissions } },
        select: { id: true, admissionNumber: true, classId: true },
      });
      const existingByAdmission = new Map(existing.map((s) => [String(s.admissionNumber).toUpperCase(), s]));

      const errors = [];
      const toCreate = [];
      const toUpdate = [];
      const seenInFile = new Set();

      for (const row of records) {
        const line = row.__line;
        const rowErr = [];

        const firstName = String(row.first_name || '').trim();
        const lastName = String(row.last_name || '').trim();
        if (!firstName) rowErr.push('first_name is required');
        if (!lastName) rowErr.push('last_name is required');
        if (firstName.length > 60 || lastName.length > 60) rowErr.push('names must be 60 characters or fewer');

        const className = String(row['class'] || '').trim();
        const classId = classByName.get(className.toLowerCase());
        if (!className) rowErr.push('class is required');
        else if (!classId) rowErr.push('class "' + className + '" does not exist in this school');

        const dob = bulkParseDob(String(row.date_of_birth || '').trim());
        if (!dob.ok) rowErr.push(dob.error);

        const admission = String(row.admission_number || '').trim().toUpperCase();
        if (admission && seenInFile.has(admission)) rowErr.push('admission_number ' + admission + ' appears more than once in this file');
        if (admission) seenInFile.add(admission);

        if (rowErr.length) { errors.push('Line ' + line + ': ' + rowErr.join('; ')); continue; }

        const fields = {
          firstName, lastName, classId,
          middleName: String(row.middle_name || '').trim() || null,
          gender: String(row.gender || '').trim() || null,
          guardianName: String(row.guardian_name || '').trim() || null,
          guardianPhone: String(row.guardian_phone || '').trim() || null,
          guardianEmail: String(row.guardian_email || '').trim() || null,
        };
        if (dob.value !== undefined) fields.dateOfBirth = dob.value;

        const hit = admission ? existingByAdmission.get(admission) : null;
        if (hit) toUpdate.push({ id: hit.id, previousClassId: hit.classId, data: fields });
        else toCreate.push({ admissionNumber: admission || null, data: fields });
      }

      if (toCreate.length === 0 && toUpdate.length === 0) {
        return res.status(400).json({
          error: { message: 'No valid rows. Fix the errors and re-upload.' },
          created: 0, updated: 0, errors, totalRows: records.length,
        });
      }

      // Allocate auto admission numbers ONCE, sequentially. The single-create
      // path retries on P2002 six times, which is fine for one student and
      // quadratic for three hundred.
      let seq = null;
      let offset = 0;
      for (const c of toCreate) {
        if (c.admissionNumber) continue;
        if (!seq) seq = await nextAdmissionNumber(req.user.schoolId);
        c.admissionNumber = seq.stem + String(seq.n + offset).padStart(3, '0');
        offset++;
      }

      const { randomUUID } = require('crypto');
      const studentRows = toCreate.map((c) => ({
        id: randomUUID(),
        schoolId: req.user.schoolId,
        admissionNumber: c.admissionNumber,
        ...c.data,
      }));
      const enrollmentRows = studentRows.map((s) => ({
        id: randomUUID(),
        schoolId: req.user.schoolId,
        studentId: s.id,
        sessionId: currentSession.id,
        classId: s.classId,
        isCurrent: true,
      }));

      let created = 0;
      let updated = 0;
      try {
        await prisma.$transaction(async (tx) => {
          if (studentRows.length) {
            // Ids generated here, so both tables go in ONE statement each.
            await tx.student.createMany({ data: studentRows });
            await tx.enrollment.createMany({ data: enrollmentRows });
            created = studentRows.length;
          }
          for (const u of toUpdate) {
            await tx.student.update({ where: { id: u.id }, data: u.data });
            if (u.data.classId !== u.previousClassId) {
              await tx.enrollment.upsert({
                where: { studentId_sessionId: { studentId: u.id, sessionId: currentSession.id } },
                update: { classId: u.data.classId, isCurrent: true },
                create: {
                  schoolId: req.user.schoolId, studentId: u.id,
                  sessionId: currentSession.id, classId: u.data.classId, isCurrent: true,
                },
              });
            }
            updated++;
          }
        }, { timeout: 45000, maxWait: 15000 });
      } catch (e) {
        if (e && e.code === 'P2002') {
          return res.status(409).json({
            error: { message: 'An admission number in this file already exists. Nothing was imported.' },
            created: 0, updated: 0, errors, totalRows: records.length,
          });
        }
        throw e;
      }

      recordAcademicEvent('STUDENTS_BULK_IMPORTED', {
        schoolId: req.user.schoolId,
        actorId: req.user.id,
        metadata: { created, updated, errorCount: errors.length, totalRows: records.length },
      });

      return res.status(201).json({
        message: created + ' created, ' + updated + ' updated',
        created, updated, errors, totalRows: records.length,
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;
