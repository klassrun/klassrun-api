const router = require('express').Router();
const { authenticate, authorize } = require('../../middleware/auth');
const { requirePlan, requireActiveForWrites } = require('../../lib/plan-gate'); // grading-config-v1

// GET /api/schools/me — get current school details
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const prisma = require('../../config/db');
    const school = await prisma.school.findUnique({
      where: { id: req.user.schoolId },
      include: {
        classes: true,
        sessions: { where: { isCurrent: true }, take: 1 },
        subscription: true,
        _count: { select: { users: true, lessonNotes: true, assessments: true } },
      },
    });

    // batch-2-phase-2-get-teachercount
    const teacherCount = await prisma.user.count({
      where: {
        schoolId: req.user.schoolId,
        role: 'TEACHER',
        revokedAt: null,
      },
    });

    res.json({ school, teacherCount });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/schools/me — update editable school profile fields (SCHOOL_ADMIN only)
// batch-2-phase-2-patch-me
router.patch('/me', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const prisma = require('../../config/db');

    // Allowlist — anything not in this set is silently dropped.
    // batch-2b-logo-allowlist
    const allowed = ['name', 'address', 'state', 'phone', 'contactEmail', 'motto', 'rcNumber', 'logoUrl', 'admissionPrefix']; // fix3-admission-v1
    const data = {};

    for (const key of allowed) {
      if (!(key in req.body)) continue;
      const value = req.body[key];

      if (value === null) {
        if (key === 'name') {
          return res.status(400).json({ error: { message: 'School name cannot be empty' } });
        }
        data[key] = null;
        continue;
      }
      if (typeof value !== 'string') continue;

      const trimmed = value.trim();
      if (key === 'name' && trimmed === '') {
        return res.status(400).json({ error: { message: 'School name cannot be empty' } });
      }
      data[key] = trimmed === '' ? null : trimmed;
    }

    if (data.contactEmail && !/^\S+@\S+\.\S+$/.test(data.contactEmail)) {
      return res.status(400).json({ error: { message: 'Invalid contact email' } });
    }

    if (data.motto && data.motto.length > 200) {
      return res.status(400).json({ error: { message: 'Motto must be 200 characters or fewer' } });
    }

    // fix3-admission-v1: short code used when auto-generating admission numbers
    if ('admissionPrefix' in data && data.admissionPrefix !== null) {
      const p = String(data.admissionPrefix).toUpperCase();
      if (!/^[A-Z0-9]{2,6}$/.test(p)) {
        return res.status(400).json({ error: { message: 'Admission prefix must be 2-6 letters or digits (e.g. GIC)', field: 'admissionPrefix' } });
      }
      data.admissionPrefix = p;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: { message: 'No editable fields provided' } });
    }

    const school = await prisma.school.update({
      where: { id: req.user.schoolId },
      data,
    });

    res.json({ school });
  } catch (err) {
    next(err);
  }
});


// POST /api/schools/me/logo-upload-signature — get signed Cloudinary upload params
// batch-2b-logo-upload-signature
router.post(
  '/me/logo-upload-signature',
  authenticate,
  authorize('SCHOOL_ADMIN'),
  async (req, res, next) => {
    try {
      const cloud = require('../../lib/cloudinary');
      if (!cloud.isConfigured()) {
        return res.status(500).json({
          error: { message: 'Logo uploads not configured. Contact support.' },
        });
      }
      const params = cloud.generateLogoUploadSignature({
        schoolId: req.user.schoolId,
      });
      return res.json(params);
    } catch (err) {
      return next(err);
    }
  }
);

// ── grading-config-v1: the school's score breakdown ──────────────────────────
//   GET /api/schools/grading-config   any staff: the breakdown + what the current
//                                     term is actually using (and whether it is locked)
//   PUT /api/schools/grading-config   SCHOOL_ADMIN: { parts: [{ label, max }] }
//                                     totalling 100, or { reset: true } for the default
// A term that already has scores keeps the breakdown frozen onto it; a change
// applies from the next term that has no scores yet.
async function gradingConfigView(schoolId) {
  const prisma = require('../../config/db');
  const grading = require('../../lib/grading');
  const gradingConfig = require('../../lib/grading-config');
  const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { gradingConfig: true } });
  const saved = gradingConfig.schoolParts(school && school.gradingConfig);
  const current = await prisma.academicSession.findFirst({
    where: { schoolId, isCurrent: true },
    select: { id: true, name: true, currentTerm: true },
  });
  let currentTerm = null;
  if (current) {
    const t = await gradingConfig.componentsForTerm(schoolId, current.id, current.currentTerm);
    currentTerm = {
      sessionId: current.id,
      sessionName: current.name,
      term: current.currentTerm,
      locked: t.source !== 'school',
      parts: t.components.map((c) => ({ label: c.label, max: c.max })),
      needsReview: t.source === 'school' ? 0 : await gradingConfig.countMisfits(schoolId, current.id, current.currentTerm, t.components), // grading-config-apply-v1
    };
  }
  return {
    parts: grading.componentsFor(saved).map((c) => ({ label: c.label, max: c.max })),
    isDefault: !saved,
    maxParts: grading.MAX_PARTS,
    currentTerm,
  };
}

router.get('/grading-config', authenticate, async (req, res, next) => {
  try {
    res.json(await gradingConfigView(req.user.schoolId));
  } catch (err) {
    next(err);
  }
});

router.put('/grading-config', authenticate, authorize('SCHOOL_ADMIN'), requireActiveForWrites, requirePlan('RESULTS_REPORTCARDS'), async (req, res, next) => {
  try {
    const prisma = require('../../config/db');
    const grading = require('../../lib/grading');
    const body = req.body || {};
    let parts = null; // { reset: true } stores parts: null = the default breakdown
    if (body.reset !== true) {
      const v = grading.validateBreakdown(body.parts);
      if (!v.ok) return res.status(400).json({ error: { message: v.error, field: 'parts' } });
      parts = v.parts;
    }
    // grading-config-apply-v1: optionally apply to the CURRENT term even if it already has scores.
    // Refused while any of that term's report cards are locked - locked cards are final.
    const applyNow = body.applyToCurrentTerm === true;
    const current = applyNow
      ? await prisma.academicSession.findFirst({ where: { schoolId: req.user.schoolId, isCurrent: true }, select: { id: true, currentTerm: true } })
      : null;
    if (current) {
      const lockedCards = await prisma.reportCard.count({
        where: { schoolId: req.user.schoolId, sessionId: current.id, term: current.currentTerm, lockedAt: { not: null } },
      });
      if (lockedCards > 0) {
        return res.status(409).json({ error: {
          message: `${lockedCards} report card${lockedCards === 1 ? ' is' : 's are'} already locked for the current term, so its breakdown cannot change. Save without "apply to the current term" and it will be used from next term.`,
          code: 'TERM_CARDS_LOCKED',
        } });
      }
    }
    await prisma.school.update({
      where: { id: req.user.schoolId },
      data: { gradingConfig: { parts, updatedAt: new Date().toISOString(), updatedById: req.user.id } },
    });
    let applied = null; // grading-config-apply-v1
    if (current) {
      const gradingConfig = require('../../lib/grading-config');
      const effective = grading.componentsFor(parts).map((c) => ({ label: c.label, max: c.max }));
      await gradingConfig.applyToTerm(req.user.schoolId, current.id, current.currentTerm, effective);
      applied = { needsReview: await gradingConfig.countMisfits(req.user.schoolId, current.id, current.currentTerm, grading.componentsFor(effective)) };
    }
    const view = await gradingConfigView(req.user.schoolId);
    const note = applied // grading-config-apply-v1
      ? `Applied to the current term.${applied.needsReview > 0 ? ` ${applied.needsReview} saved score${applied.needsReview === 1 ? ' is' : 's are'} outside the new breakdown - teachers will see ${applied.needsReview === 1 ? 'it' : 'them'} flagged in Results to fix.` : ' Every saved score already fits.'}`
      : view.currentTerm && view.currentTerm.locked
      ? 'Saved. The current term already has scores, so it keeps the breakdown it started with. This applies from the next term.'
      : 'Saved. This applies to the current term.';
    res.json({ ...view, note, applied }); // grading-config-apply-v1
  } catch (err) {
    next(err);
  }
});

module.exports = router;
