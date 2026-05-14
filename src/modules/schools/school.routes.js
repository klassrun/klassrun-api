const router = require('express').Router();
const { authenticate, authorize } = require('../../middleware/auth');

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
    const allowed = ['name', 'address', 'state', 'phone', 'contactEmail', 'motto', 'rcNumber', 'logoUrl'];
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

module.exports = router;
