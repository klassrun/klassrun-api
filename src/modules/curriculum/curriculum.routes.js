const router = require('express').Router();

// Public — no auth needed to browse curriculum topics
router.get('/topics', async (req, res, next) => {
  try {
    const prisma = require('../../config/db');
    const { subject, className, term } = req.query;

    const where = {};
    if (subject) where.subject = subject;
    if (className) where.className = className;
    if (term) where.term = term.toUpperCase();

    const topics = await prisma.curriculumTopic.findMany({
      where,
      orderBy: { week: 'asc' },
    });

    res.json({ topics });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
