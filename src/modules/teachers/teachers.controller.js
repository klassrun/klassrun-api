// src/modules/teachers/teachers.controller.js
//
// School-admin teacher management:
//   - GET   /api/teachers              → list my school's teachers
//   - PATCH /api/teachers/:id/revoke   → soft delete (set revokedAt)
//   - PATCH /api/teachers/:id/reinstate → undo revoke
//   - POST  /api/teachers/:id/reset-password → re-invite (new password)
//
// Security:
//   - All endpoints require SCHOOL_ADMIN authentication
//   - Strict school-scoping: school admin from School A can never touch
//     teachers in School B (we filter by req.user.schoolId on every query)
//   - Cannot revoke yourself
//   - Cannot revoke a SCHOOL_ADMIN role (only TEACHER role)

const crypto = require('crypto');
const prisma = require('../../config/db');
const email  = require('../../lib/email');
const { inviteEmail }         = require('../../lib/email-templates/invite');
const { teacherRevokedEmail } = require('../../lib/email-templates/teacher-revoked');
const { recordAuthEvent }     = require('../../lib/audit');
const { invalidateUserCache } = require('../../middleware/auth'); // perf-2-auth-cache

const INVITE_TTL_DAYS = 7;
const FRONTEND_URL    = process.env.FRONTEND_URL || 'http://localhost:3000';
const STAFF_ROLES = ['TEACHER', 'BURSAR']; // ops-4c-staff-roles — bursar managed alongside teachers

function extractIp(req) {
  return (
    req.get('cf-connecting-ip') ||
    req.get('x-real-ip') ||
    req.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.ip ||
    null
  );
}

// ── GET /api/teachers ────────────────────────────────────────────────────────
//
// Returns the list of teachers for the requesting school admin's school.

const listTeachers = async (req, res, next) => {
  try {
    const schoolId = req.user.schoolId;

    const teachers = await prisma.user.findMany({
      where: {
        schoolId,
        role: { in: STAFF_ROLES },
      },
      select: {
        id:              true,
        email:           true,
        firstName:       true,
        lastName:        true,
        inviteAccepted:  true,
        revokedAt:       true,
        createdAt:       true,
        role:            true,
        // Don't expose password, tokens, etc.
      },
      orderBy: [
        { revokedAt: 'asc' },     // active first (null sorts before dates)
        { createdAt: 'desc' },
      ],
    });

    // Compute display status for each teacher
    const teachersWithStatus = teachers.map((t) => ({
      ...t,
      status:
        t.revokedAt        ? 'REVOKED' :
        !t.inviteAccepted  ? 'INVITED' :
                             'ACTIVE',
    }));

    return res.json({ teachers: teachersWithStatus });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/teachers/:id/revoke ───────────────────────────────────────────

const revokeTeacher = async (req, res, next) => {
  try {
    const teacherId = req.params.id;
    const schoolId  = req.user.schoolId;
    const adminId   = req.user.id;

    // Find the teacher and verify they belong to this school
    const teacher = await prisma.user.findFirst({
      where: {
        id:       teacherId,
        schoolId,
        role:     { in: STAFF_ROLES },
      },
    });

    if (!teacher) {
      return res.status(404).json({
        error: { message: 'Teacher not found' },
      });
    }

    if (teacher.revokedAt) {
      return res.status(400).json({
        error: { message: 'Teacher is already revoked' },
      });
    }

    // Cannot revoke yourself (defensive — also caught by role filter above)
    if (teacherId === adminId) {
      return res.status(400).json({
        error: { message: 'You cannot revoke yourself' },
      });
    }

    await prisma.user.update({
      where: { id: teacherId },
      data:  { revokedAt: new Date() },
    });
    invalidateUserCache(teacherId); // perf-2: revocation takes effect immediately

    await recordAuthEvent('TEACHER_REVOKED', {
      req,
      userId:   adminId,
      schoolId,
      email:    teacher.email,
      metadata: { teacherId },
    });

    // Notify the teacher — fire and forget
    const tpl = teacherRevokedEmail({
      firstName:  teacher.firstName,
      schoolName: req.user.schoolName || 'your school',
    });
    email.send({
      to: teacher.email,
      subject: tpl.subject,
      html: tpl.html,
    }).catch((err) => {
      console.error('✗ Revocation email failed:', err.message);
    });

    return res.json({ message: 'Teacher access revoked' });
  } catch (err) {
    next(err);
  }
};

// ── PATCH /api/teachers/:id/reinstate ────────────────────────────────────────

const reinstateTeacher = async (req, res, next) => {
  try {
    const teacherId = req.params.id;
    const schoolId  = req.user.schoolId;
    const adminId   = req.user.id;

    const teacher = await prisma.user.findFirst({
      where: { id: teacherId, schoolId, role: { in: STAFF_ROLES } },
    });

    if (!teacher) {
      return res.status(404).json({ error: { message: 'Teacher not found' } });
    }
    if (!teacher.revokedAt) {
      return res.status(400).json({ error: { message: 'Teacher is already active' } });
    }

    await prisma.user.update({
      where: { id: teacherId },
      data:  { revokedAt: null },
    });

    await recordAuthEvent('TEACHER_REINSTATED', {
      req,
      userId:   adminId,
      schoolId,
      email:    teacher.email,
      metadata: { teacherId },
    });

    return res.json({ message: 'Teacher access reinstated' });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/teachers/:id/reset-password ────────────────────────────────────
//
// Issues a new invite link for the teacher, invalidating any existing
// password and forcing them to set a new one. Reuses the existing invite
// flow rather than introducing a separate "admin password reset" path.

const resetTeacherPassword = async (req, res, next) => {
  try {
    const teacherId = req.params.id;
    const schoolId  = req.user.schoolId;
    const adminId   = req.user.id;

    const teacher = await prisma.user.findFirst({
      where: { id: teacherId, schoolId, role: { in: STAFF_ROLES } },
      include: { school: { select: { name: true } } },
    });

    if (!teacher) {
      return res.status(404).json({ error: { message: 'Teacher not found' } });
    }
    if (teacher.revokedAt) {
      return res.status(400).json({
        error: { message: 'Cannot reset password for a revoked teacher. Reinstate them first.' },
      });
    }

    // Generate a fresh invite token (same shape as new invites)
    const newInviteToken      = crypto.randomBytes(32).toString('hex');
    const newInviteExpiresAt  = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    // Setting password to a random unguessable value effectively "logs out"
    // any active sessions because their cached password hash won't match.
    // (More importantly, prevents login until they accept the new invite.)
    const randomLockedPassword = crypto.randomBytes(48).toString('hex');

    await prisma.user.update({
      where: { id: teacherId },
      data: {
        password:        randomLockedPassword,
        inviteToken:     newInviteToken,
        inviteExpiresAt: newInviteExpiresAt,
        inviteAccepted:  false,
        failedLoginCount: 0,
        lockedUntil:     null,
      },
    });

    await recordAuthEvent('TEACHER_PASSWORD_RESET', {
      req,
      userId:   adminId,
      schoolId,
      email:    teacher.email,
      metadata: { teacherId, newInviteExpiresAt },
    });

    // Send the new invite email
    const inviteUrl = `${FRONTEND_URL}/accept-invite?token=${newInviteToken}`;
    const tpl = inviteEmail({
      firstName:  teacher.firstName,
      schoolName: teacher.school.name,
      inviteUrl,
      expiresAt:  newInviteExpiresAt.toISOString(),
      isReset:    true,
    });
    email.send({
      to: teacher.email,
      subject: tpl.subject,
      html: tpl.html,
    }).catch((err) => {
      console.error('✗ Reset invite email failed:', err.message);
    });

    return res.json({
      message: 'Password reset link sent to teacher',
      expiresAt: newInviteExpiresAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listTeachers,
  revokeTeacher,
  reinstateTeacher,
  resetTeacherPassword,
};
