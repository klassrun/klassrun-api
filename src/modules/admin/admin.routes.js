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

const crypto = require('crypto'); // phaseb1-admin-require
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
// phaseb1-admin-billing
// Money fields that may reach the console. Never a Paystack secret.
const PAYMENT_SELECT = {
  id: true, reference: true, schoolId: true, plan: true, amountKobo: true,
  currency: true, channel: true, source: true, paidAt: true, note: true, createdAt: true,
};

const ADMIN_PLANS = ['starter', 'standard', 'premium'];
const MAX_EXTEND_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

// GET /api/admin/payments
// The whole ledger, newest first. ?schoolId= filters, ?limit= caps (max 500).
router.get('/payments', authenticate, authorize('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const rawLimit = Number(req.query.limit);
    const take = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 500 ? rawLimit : 100;

    const where = {};
    if (req.query.schoolId) where.schoolId = String(req.query.schoolId);

    const payments = await prisma.payment.findMany({
      where,
      orderBy: { paidAt: 'desc' },
      take,
      select: PAYMENT_SELECT,
    });

    // Payment carries a scalar schoolId with no Prisma relation, so names are
    // resolved in one extra query rather than an include.
    const ids = Array.from(new Set(payments.map((p) => p.schoolId).filter(Boolean)));
    const schools = ids.length
      ? await prisma.school.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true } })
      : [];
    const byId = new Map(schools.map((s) => [s.id, s]));

    const rows = payments.map((p) => Object.assign({}, p, { school: byId.get(p.schoolId) || null }));
    return res.json({ payments: rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/schools/:id/subscription
// Manual extension for bank-transfer schools and the goodwill extensions the
// Terms promise. Uses the SAME never-shrink maths as a Paystack activation:
// paid time left is extended, a lapsed or trialing school anchors at now, and
// an extension can never move the end date backwards. Every extension writes
// a source:'manual' ledger row so the money view stays complete.
router.patch('/schools/:id/subscription', authenticate, authorize('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    const extendDays = Number(body.extendDays);
    if (!Number.isInteger(extendDays) || extendDays < 1 || extendDays > MAX_EXTEND_DAYS) {
      return res.status(400).json({
        error: { message: 'extendDays must be a whole number between 1 and ' + MAX_EXTEND_DAYS, field: 'extendDays' },
      });
    }

    const plan = (body.plan === undefined || body.plan === null || body.plan === '')
      ? null : String(body.plan).toLowerCase();
    if (plan !== null && !ADMIN_PLANS.includes(plan)) {
      return res.status(400).json({
        error: { message: 'plan must be starter, standard or premium', field: 'plan' },
      });
    }

    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;

    const sub = await prisma.subscription.findUnique({ where: { schoolId: id } });
    if (!sub) return res.status(404).json({ error: { message: 'School has no subscription' } });

    const now = Date.now();
    const paidTimeLeft = (sub.status === 'ACTIVE' || sub.status === 'PAST_DUE')
      && sub.endDate && new Date(sub.endDate).getTime() > now;
    const base = paidTimeLeft ? new Date(sub.endDate).getTime() : now;
    const endDate = new Date(base + extendDays * DAY_MS);
    const nextPlan = plan || sub.plan;
    const reference = 'manual-' + crypto.randomUUID();

    await prisma.$transaction([
      prisma.subscription.update({
        where: { schoolId: id },
        data: { plan: nextPlan, status: 'ACTIVE', endDate },
      }),
      prisma.payment.create({
        data: {
          reference,
          schoolId: id,
          plan: nextPlan,
          amountKobo: 0,
          currency: 'NGN',
          channel: 'manual',
          source: 'manual',
          paidAt: new Date(),
          rawEvent: null,
          note: note || ('Manual extension of ' + extendDays + ' days by super admin ' + req.user.id),
        },
      }),
    ]);

    // Same 60s auth cache as the status flip above - bust it so the school
    // sees its new expiry on the very next request.
    const affected = await prisma.user.findMany({ where: { schoolId: id }, select: { id: true } });
    for (const u of affected) invalidateUserCache(u.id);

    const school = await prisma.school.findUnique({ where: { id }, select: SCHOOL_SELECT });
    const teacherCount = await prisma.user.count({
      where: { schoolId: id, role: 'TEACHER', revokedAt: null },
    });

    console.log(
      '[admin] school ' + id + ' subscription extended ' + extendDays + 'd to ' +
      endDate.toISOString() + ' plan=' + nextPlan + ' ref=' + reference + ' by ' + req.user.id
    );

    return res.json({
      school: Object.assign({}, school, { teacherCount }),
      extension: { reference, extendDays, endDate, plan: nextPlan, note },
    });
  } catch (err) {
    next(err);
  }
});

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

    // phaseb1-metrics-billing: money in this calendar month, and how many
    // paying schools fall off the edge within a week. Manual extensions are
    // excluded from the naira figure - they are goodwill, not revenue.
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const inSevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [collected, expiringSoon] = await prisma.$transaction([
      prisma.payment.aggregate({
        _sum: { amountKobo: true },
        where: { paidAt: { gte: monthStart }, source: { not: 'manual' } },
      }),
      prisma.subscription.count({
        where: {
            status: { in: ['ACTIVE', 'PAST_DUE'] },
            endDate: { gte: new Date(), lte: inSevenDays },
        },
      }),
    ]);
    const collectedThisMonthKobo = (collected && collected._sum && collected._sum.amountKobo) || 0;

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
      billing: { // phaseb1-metrics-payload
        collectedThisMonthKobo: collectedThisMonthKobo,
        collectedThisMonthNaira: collectedThisMonthKobo / 100,
        expiringWithin7Days: expiringSoon,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
