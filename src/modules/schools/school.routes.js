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

    res.json({ school });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
