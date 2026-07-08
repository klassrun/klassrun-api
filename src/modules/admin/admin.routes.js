// src/modules/admin/admin.routes.js
// superadmin-mvp
//
// Platform-wide super-admin API. Every route: authenticate + authorize('SUPER_ADMIN').
//
// ⚠️  TENANT-ISOLATION BYPASS — the one sanctioned place.
//     These queries are deliberately NOT scoped by schoolId; a super admin sees
//     every school. This is the only module allowed to do that. SUPER_ADMIN
//     users carry schoolId === null, so even an accidental
//     `where: { schoolId: req.user.schoolId }` here would filter by null and
//     return nothing (fail-closed) — never cross-tenant data. Nothing in this
//     file is imported by any school-scoped module.
//
// Zero migration: reads + a status flip over the existing SchoolStatus enum
// (PROVISIONING | ACTIVE | SUSPENDED | EXPIRED — all already in the DB).

const router = require('express').Router();
const { authenticate, authorize, invalidateUserCache } = require('../../middleware/auth');
const prisma = require('../../config/db');

// Only these subscription fields reach the console (never Paystack secrets).
const SUB_SELECT = { plan: true, status: true, trialEndsAt: true, endDate: true };

// One school row for the table — same shape for list + patch responses.
const SCHOOL_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
  state: true,
  contactEmail: true,
  createdAt: true,
  subscription: { select: SUB_SELECT },
};

// ── GET /api/admin/schools ──────────────────────────────────────────────────
// Every school, newest first, with subscription + live teacher count.
router.get('/schools', authenticate, authorize('SUPER_ADMIN'), async (req, res, next) => {
  try {
    // Teacher count mirrors /api/schools/me exactly: role TEACHER, not revoked.
    // We fetch only { schoolId } for every such teacher and tally in JS — no
    // reliance on groupBy/filtered-count shapes; trivial payload at this scale.
    const [schools, teacherRows] = await prisma.$transaction([
      prisma.school.findMany({ orderBy: { createdAt: 'desc' }, select: SCHOOL_SELECT }),
      prisma.user.findMany({
        where: { role: 'TEACHER', revokedAt: null },
        select: { schoolId: true },
      }),
    ]);

    const teacherBySchool = new Map();
    for (const t of teacherRows) {
      if (!t.schoolId) continue;
      teacherBySchool.set(t.schoolId, (teacherBySchool.get(t.schoolId) || 0) + 1);
    }

    const rows = schools.map((s) => ({ ...s, teacherCount: teacherBySchool.get(s.id) || 0 }));
    return res.json({ schools: rows });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/admin/schools/:id ────────────────────────────────────────────
// Approve/reinstate (→ ACTIVE) or suspend (→ SUSPENDED). Nothing else is settable.
const SETTABLE_STATUS = ['ACTIVE', 'SUSPENDED'];

router.patch('/schools/:id', authenticate, authorize('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const status = req.body && req.body.status;

    if (!SETTABLE_STATUS.includes(status)) {
      return res.status(400).json({
        error: { message: 'status must be ACTIVE or SUSPENDED', field: 'status' },
      });
    }

    const existing = await prisma.school.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      return res.status(404).json({ error: { message: 'School not found' } });
    }

    const school = await prisma.school.update({
      where: { id },
      data: { status },
      select: SCHOOL_SELECT,
    });

    // The auth layer caches each user (incl. a copy of school.status) for 60s.
    // Bust every affected user's cache so suspend/reinstate bites on their very
    // next request instead of up to a minute later. Single-instance in-memory
    // cache — matches the current Render deploy and auth.js's own note.
    const affected = await prisma.user.findMany({ where: { schoolId: id }, select: { id: true } });
    for (const u of affected) invalidateUserCache(u.id);

    const teacherCount = await prisma.user.count({
      where: { schoolId: id, role: 'TEACHER', revokedAt: null },
    });

    console.log(
      '[admin] school ' + id + ' status -> ' + status +
      ' by ' + req.user.id + ' (' + affected.length + ' sessions busted)'
    );

    return res.json({ school: Object.assign({}, school, { teacherCount }) });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/metrics ──────────────────────────────────────────────────
// Platform-wide counts. Content counts reuse Batch-6a's clauses (deletedAt:null)
// but UN-scoped (no schoolId).
router.get('/metrics', authenticate, authorize('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const [
      schoolsTotal, schoolsProvisioning, schoolsActive, schoolsSuspended, schoolsExpired,
      subsTrial, subsActive, subsPastDue, subsCancelled, subsExpired,
      notes, schemes, exams, teachers,
    ] = await prisma.$transaction([
      prisma.school.count(),
      prisma.school.count({ where: { status: 'PROVISIONING' } }),
      prisma.school.count({ where: { status: 'ACTIVE' } }),
      prisma.school.count({ where: { status: 'SUSPENDED' } }),
      prisma.school.count({ where: { status: 'EXPIRED' } }),
      prisma.subscription.count({ where: { status: 'TRIAL' } }),
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
      prisma.subscription.count({ where: { status: 'PAST_DUE' } }),
      prisma.subscription.count({ where: { status: 'CANCELLED' } }),
      prisma.subscription.count({ where: { status: 'EXPIRED' } }),
      prisma.lessonNote.count({ where: { deletedAt: null } }),
      prisma.schemeOfWork.count({ where: { deletedAt: null } }),
      prisma.assessment.count({ where: { deletedAt: null } }),
      prisma.user.count({ where: { role: 'TEACHER', revokedAt: null } }),
    ]);

    return res.json({
      schools: {
        total: schoolsTotal,
        provisioning: schoolsProvisioning,
        active: schoolsActive,
        suspended: schoolsSuspended,
        expired: schoolsExpired,
      },
      subscriptions: {
        trial: subsTrial,
        active: subsActive,
        pastDue: subsPastDue,
        cancelled: subsCancelled,
        expired: subsExpired,
      },
      content: { notes, schemes, exams },
      teachers,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
