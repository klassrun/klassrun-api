// src/modules/portal/portal.controller.js
// ops-5-portal-controller
//
// Public:  portalLogin (slug + admissionNumber + password)
//          portalAccept (set password via invite token)
// Staff :  sendPortalInvite (SCHOOL_ADMIN emails a student's guardian a link)
//
// Audit reuses existing AuthEventType values with metadata.portal = true, so
// no enum migration is needed. userId is NEVER set for portal events (a
// student is not a User; the AuthEvent.userId FK would reject it) — studentId
// goes in metadata instead.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../../config/db');
const { signPortalToken } = require('./portal-token');
const { isFeeBlocked } = require('./portal-auth.middleware');
const { recordAuthEvent } = require('../../lib/audit');
const emailLib = require('../../lib/email');
const { portalInviteEmail } = require('../../lib/email-templates/portal-invite');

const PORTAL_INVITE_TTL_DAYS = 7;

function studentPublic(student, school) {
  return {
    id: student.id,
    admissionNumber: student.admissionNumber,
    firstName: student.firstName,
    lastName: student.lastName,
    schoolId: school.id,
    schoolName: school.name,
    schoolSlug: school.slug,
  };
}

// ── POST /api/portal/login (public) ─────────────────────────────────────────
const portalLogin = async (req, res, next) => {
  try {
    const body = req.body || {};
    const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
    const admissionNumber = typeof body.admissionNumber === 'string' ? body.admissionNumber.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const generic = { error: { message: 'Invalid admission number or password' } };

    if (!slug || !admissionNumber || !password) {
      return res.status(400).json({ error: { message: 'School, admission number and password are required' } });
    }

    const school = await prisma.school.findUnique({
      where: { slug },
      select: { id: true, name: true, slug: true, status: true, portalFeeBlockEnabled: true },
    });
    if (!school) return res.status(401).json(generic);
    if (school.status === 'SUSPENDED') {
      return res.status(403).json({ error: { message: 'This school has been suspended. Contact Klassrun support.' } });
    }

    const student = await prisma.student.findUnique({
      where: { schoolId_admissionNumber: { schoolId: school.id, admissionNumber } },
      select: {
        id: true, schoolId: true, firstName: true, lastName: true, admissionNumber: true,
        portalPasswordHash: true, portalInviteAccepted: true, archivedAt: true,
      },
    });
    if (!student || !student.portalPasswordHash || !student.portalInviteAccepted) {
      await recordAuthEvent('LOGIN_FAILED', { req, schoolId: school.id, metadata: { portal: true, reason: 'no_portal_account', slug } });
      return res.status(401).json(generic);
    }
    if (student.archivedAt) {
      return res.status(403).json({ error: { message: 'This portal account is no longer active. Contact your school.' } });
    }

    const match = await bcrypt.compare(password, student.portalPasswordHash);
    if (!match) {
      await recordAuthEvent('LOGIN_FAILED', { req, schoolId: school.id, metadata: { portal: true, reason: 'wrong_password', studentId: student.id } });
      return res.status(401).json(generic);
    }

    if (school.portalFeeBlockEnabled && (await isFeeBlocked(school.id, student.id))) {
      return res.status(403).json({ error: { message: 'Outstanding fees. Please contact the school bursary.' }, code: 'FEE_BLOCK' });
    }

    const token = signPortalToken(student.id, school.id);
    recordAuthEvent('LOGIN_SUCCESS', { req, schoolId: school.id, metadata: { portal: true, studentId: student.id, admissionNumber: student.admissionNumber } });

    return res.json({ message: 'Login successful', token, student: studentPublic(student, school) });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/portal/accept/:token (public) ─────────────────────────────────
const portalAccept = async (req, res, next) => {
  try {
    const { token } = req.params;
    const body = req.body || {};
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password || password.length < 8) {
      return res.status(400).json({ error: { message: 'Password must be at least 8 characters' } });
    }

    const student = await prisma.student.findFirst({
      where: { portalInviteToken: token },
      include: { school: { select: { id: true, name: true, slug: true, status: true } } },
    });
    if (!student) {
      await recordAuthEvent('INVITE_FAILED', { req, metadata: { portal: true, reason: 'unknown_token' } });
      return res.status(404).json({ error: { message: 'Invalid or expired invite' } });
    }
    if (student.portalInviteAccepted) {
      return res.status(400).json({ error: { message: 'This portal invite has already been accepted' } });
    }
    if (student.portalInviteExpiresAt && student.portalInviteExpiresAt < new Date()) {
      return res.status(400).json({ error: { message: 'This invite has expired. Ask the school to resend it.' } });
    }

    const hash = await bcrypt.hash(password, 12);
    await prisma.student.update({
      where: { id: student.id },
      data: {
        portalPasswordHash: hash,
        portalInviteAccepted: true,
        portalInviteToken: null,
        portalInviteExpiresAt: null,
      },
    });

    const jwtToken = signPortalToken(student.id, student.schoolId);
    await recordAuthEvent('INVITE_ACCEPTED', { req, schoolId: student.schoolId, metadata: { portal: true, studentId: student.id } });

    return res.json({
      message: 'Portal access set up. Welcome to Klassrun!',
      token: jwtToken,
      student: studentPublic(student, student.school),
    });
  } catch (err) {
    next(err);
  }
};

// ── POST /api/portal/invite/:studentId (staff: SCHOOL_ADMIN) ────────────────
const sendPortalInvite = async (req, res, next) => {
  try {
    const { studentId } = req.params;
    const body = req.body || {};
    const overrideEmail = typeof body.email === 'string' ? body.email.trim() : '';

    const student = await prisma.student.findFirst({
      where: { id: studentId, schoolId: req.user.schoolId },
      include: { school: { select: { id: true, name: true, slug: true } } },
    });
    if (!student) return res.status(404).json({ error: { message: 'Student not found' } });
    if (student.archivedAt) return res.status(400).json({ error: { message: 'Cannot invite an archived student' } });

    const recipient = overrideEmail || student.guardianEmail;
    if (!recipient) {
      return res.status(400).json({ error: { message: 'No email on file. Add a guardian email or pass one in.', field: 'email' } });
    }

    const inviteToken = crypto.randomBytes(32).toString('hex');
    const inviteExpiresAt = new Date(Date.now() + PORTAL_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    await prisma.student.update({
      where: { id: student.id },
      data: { portalInviteToken: inviteToken, portalInviteExpiresAt: inviteExpiresAt, portalInviteAccepted: false },
    });

    const base = process.env.FRONTEND_URL || 'http://localhost:3000';
    const inviteUrl = base + '/portal/' + student.school.slug + '/accept/' + inviteToken;

    await recordAuthEvent('INVITE_SENT', {
      req, userId: req.user.id, email: recipient, schoolId: req.user.schoolId,
      metadata: { portal: true, studentId: student.id },
    });

    emailLib.send({
      to: recipient,
      ...portalInviteEmail({
        studentName: [student.firstName, student.lastName].filter(Boolean).join(' '),
        admissionNumber: student.admissionNumber,
        schoolName: student.school.name,
        inviteUrl,
        expiresAt: inviteExpiresAt.toISOString(),
      }),
    }).catch((e) => { console.error('Portal invite email failed:', e.message); });

    return res.status(201).json({
      message: 'Portal invite sent',
      inviteLink: inviteUrl,
      sentTo: recipient,
      expiresAt: inviteExpiresAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { portalLogin, portalAccept, sendPortalInvite };
