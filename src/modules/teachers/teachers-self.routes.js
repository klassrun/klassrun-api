// src/modules/teachers/teachers-self.routes.js
//
// Self-service endpoints for the currently-authenticated TEACHER.
// Mounted at /api/teachers/me so the existing /api/teachers (SCHOOL_ADMIN-gated)
// routes are untouched.
//
// Inline-handler style matching subject.routes.js / class.routes.js.
//
// batch-2c-phase-4a-teachers-self-mount

const router = require('express').Router();
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');

// All teacher-self endpoints require an authenticated TEACHER.
router.use(authenticate, authorize('TEACHER'));

// GET /api/teachers/me/assignments
//
// Returns the calling teacher's active subjects grouped by class.
// Excludes subjects whose parent class is archived. Excludes archived subjects.
router.get('/assignments', async (req, res) => {
  try {
    const teacherId = req.user.id;
    const schoolId  = req.user.schoolId;

    const subjects = await prisma.subject.findMany({
      where: {
        teacherId,
        schoolId,
        archivedAt: null,
        class: { archivedAt: null },
      },
      include: {
        class: { select: { id: true, name: true, level: true } },
      },
      orderBy: [
        { class: { name: 'asc' } },
        { name: 'asc' },
      ],
    });

    // Group by class.id, preserving order (subjects already sorted)
    const grouped = new Map();
    for (const s of subjects) {
      const cls = s.class;
      if (!cls) continue; // shouldn't happen given filter, defensive
      if (!grouped.has(cls.id)) {
        grouped.set(cls.id, { class: cls, subjects: [] });
      }
      grouped.get(cls.id).subjects.push({
        id: s.id,
        name: s.name,
        archivedAt: s.archivedAt,
        createdAt: s.createdAt,
      });
    }

    const assignments = Array.from(grouped.values());

    return res.json({
      assignments,
      totalSubjects: subjects.length,
      totalClasses: assignments.length,
    });
  } catch (e) {
    console.error('[GET /api/teachers/me/assignments] error:', e);
    return res.status(500).json({
      error: { message: 'Could not load assignments' },
    });
  }
});

module.exports = router;
