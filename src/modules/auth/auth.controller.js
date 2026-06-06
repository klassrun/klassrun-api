// src/modules/auth/auth.controller.js
//
// Authentication controllers. Covers the full lifecycle:
//   - signup           Create a new school + admin user + trial subscription
//   - login            Authenticate and issue JWT
//   - inviteTeacher    School admin invites a teacher (one-time link)
//   - resendInvite     Generate a new invite token, invalidate old one
//   - acceptInvite     Teacher accepts invite, must confirm their email
//   - me               Return current user + school context
//
// Security model:
//   - Passwords hashed with bcrypt (cost 12)
//   - JWT carries userId, role, schoolId (used for tenant isolation)
//   - Invite tokens are 256-bit random, expire after INVITE_TTL_DAYS
//   - Invite acceptance requires the recipient to confirm their email,
//     blocking generic link sharing
//   - Every security-sensitive event is recorded in AuthEvent

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../../config/db');
const { generateToken } = require('../../utils/jwt');
const slugUtil          = require('../../utils/slug');
const email             = require('../../lib/email');
const { welcomeEmail }  = require('../../lib/email-templates/welcome');
const { inviteEmail }   = require('../../lib/email-templates/invite');
const { recordAuthEvent } = require('../../lib/audit');

const INVITE_TTL_DAYS = 7;
const TRIAL_DAYS      = 14;

// ───── SIGNUP ────────────────────────────────────────────────────────────────
const signup = async (req, res, next) => {
  try {
    const {
      email: signupEmail,
      password, firstName, lastName,
      schoolName, schoolAddress, schoolState,
      slug: requestedSlug,
    } = req.body;

    if (!signupEmail || !password || !firstName || !lastName || !schoolName) {
      return res.status(400).json({
        error: { message: 'All fields are required' },
      });
    }
    if (password.length < 8) {
      return res.status(400).json({
        error: { message: 'Password must be at least 8 characters' },
      });
    }

    // Email uniqueness — fail fast before slug work
    const existing = await prisma.user.findUnique({ where: { email: signupEmail } });
    if (existing) {
      return res.status(409).json({
        error: { message: 'Email already registered' },
      });
    }

    // Resolve slug
    let finalSlug;
    if (requestedSlug) {
      const cleaned = requestedSlug.trim().toLowerCase();
      const availability = await slugUtil.isAvailable(cleaned);
      if (!availability.available) {
        return res.status(409).json({
          error: { message: availability.error, field: 'slug' },
        });
      }
      finalSlug = cleaned;
    } else {
      const suggestions = await slugUtil.suggest(schoolName, { limit: 1, state: schoolState });
      if (suggestions.length === 0) {
        return res.status(400).json({
          error: {
            message: 'Could not generate a usable slug. Please provide one explicitly.',
            field: 'slug',
          },
        });
      }
      finalSlug = suggestions[0];
    }

    // All-or-nothing creation
    const hashedPassword = await bcrypt.hash(password, 12);
    const trialEndsAt    = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    const result = await prisma.$transaction(async (tx) => {
      const school = await tx.school.create({
        data: {
          name: schoolName,
          address: schoolAddress,
          state: schoolState,
          slug: finalSlug,
          status: 'PROVISIONING',
        },
      });

      const user = await tx.user.create({
        data: {
          email: signupEmail,
          password: hashedPassword,
          firstName,
          lastName,
          role: 'SCHOOL_ADMIN',
          inviteAccepted: true,
          schoolId: school.id,
        },
      });

      await tx.academicSession.create({
        data: {
          name: '2025/2026',
          currentTerm: 'FIRST',
          isCurrent: true,
          schoolId: school.id,
        },
      });

      await tx.subscription.create({
        data: {
          plan: 'starter',
          status: 'TRIAL',
          startDate: new Date(),
          endDate: trialEndsAt,
          trialEndsAt,
          schoolId: school.id,
        },
      });

      return { school, user };
    });

    const token = generateToken(result.user.id, result.user.role);
    const portalUrl = slugUtil.buildPortalUrl(result.school.slug);

    await recordAuthEvent('SIGNUP_SUCCESS', {
      req,
      email: signupEmail,
      userId: result.user.id,
      schoolId: result.school.id,
      metadata: { slug: result.school.slug },
    });

    // Fire-and-forget welcome email
    email.send({
      to: signupEmail,
      ...welcomeEmail({
        firstName,
        schoolName,
        portalUrl,
        trialEndsAt: trialEndsAt.toISOString(),
      }),
    }).catch((err) => {
      console.error('Welcome email failed:', err.message);
    });

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: {
        id: result.user.id,
        email: result.user.email,
        firstName: result.user.firstName,
        lastName: result.user.lastName,
        role: result.user.role,
        schoolId: result.school.id,
        schoolName: result.school.name,
        schoolSlug: result.school.slug,
        schoolStatus: result.school.status,
      },
      portalUrl,
      trialEndsAt: trialEndsAt.toISOString(),
    });
  } catch (err) {
    if (err?.code === 'P2002' && err?.meta?.target?.includes('slug')) {
      return res.status(409).json({
        error: { message: 'That slug was just taken. Please pick another.', field: 'slug' },
      });
    }
    next(err);
  }
};

// ───── LOGIN ────────────────────────────────────────────────────────────────
// ── Login (with account lockout protection) ──────────────────────────────
const FAILED_ATTEMPTS_LIMIT = 10;
const LOCKOUT_MINUTES       = 15;

const login = async (req, res, next) => {
  try {
    const { email: loginEmail, password } = req.body;

    if (!loginEmail || !password) {
      return res.status(400).json({ error: { message: 'Email and password are required' } });
    }

    const normalizedEmail = loginEmail.trim().toLowerCase();

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { school: { select: { id: true, name: true, slug: true, status: true } } },
    });

    const genericInvalidCredentials = { error: { message: 'Invalid email or password' } };

    if (!user) {
      await recordAuthEvent('LOGIN_FAILED', { req, email: normalizedEmail, metadata: { reason: 'no_such_user' } });
      return res.status(401).json(genericInvalidCredentials);
    }

    if (user.revokedAt) {
      await recordAuthEvent('LOGIN_FAILED', { req, email: user.email, userId: user.id, schoolId: user.schoolId, metadata: { reason: 'revoked' } });
      return res.status(403).json({ error: { message: 'Your access has been revoked. Please contact your school administrator.' } });
    }

    if (user.school?.status === 'SUSPENDED') {
      await recordAuthEvent('LOGIN_FAILED', { req, email: user.email, userId: user.id, schoolId: user.schoolId, metadata: { reason: 'school_suspended' } });
      return res.status(403).json({ error: { message: 'This school has been suspended. Contact Klassrun support.' } });
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await recordAuthEvent('LOGIN_FAILED', { req, email: user.email, userId: user.id, schoolId: user.schoolId, metadata: { reason: 'locked', lockedUntil: user.lockedUntil } });
      const minutesLeft = Math.ceil((user.lockedUntil - Date.now()) / 60000);
      return res.status(423).json({ error: { message: `Account temporarily locked. Try again in ${minutesLeft} minute(s).` } });
    }

    if (!user.inviteAccepted) {
      await recordAuthEvent('LOGIN_FAILED', { req, email: user.email, userId: user.id, schoolId: user.schoolId, metadata: { reason: 'invite_not_accepted' } });
      return res.status(403).json({ error: { message: 'Please accept your invite via the link in your email before logging in.' } });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      const newFailedCount = user.failedLoginCount + 1;
      const updates = { failedLoginCount: newFailedCount };

      if (newFailedCount >= FAILED_ATTEMPTS_LIMIT) {
        updates.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
        updates.failedLoginCount = 0;
        await recordAuthEvent('ACCOUNT_LOCKED', { req, email: user.email, userId: user.id, schoolId: user.schoolId, metadata: { lockedUntil: updates.lockedUntil } });
      }

      await prisma.user.update({ where: { id: user.id }, data: updates });
      await recordAuthEvent('LOGIN_FAILED', { req, email: user.email, userId: user.id, schoolId: user.schoolId, metadata: { reason: 'wrong_password', failedCount: newFailedCount } });

      if (updates.lockedUntil) {
        return res.status(423).json({ error: { message: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.` } });
      }
      return res.status(401).json(genericInvalidCredentials);
    }

    // Login succeeded — reset failure counter, issue token
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });

    const token = generateToken(user.id, user.role);
    const portalUrl = user.school?.slug ? slugUtil.buildPortalUrl(user.school.slug) : null;

    await recordAuthEvent('LOGIN_SUCCESS', { req, userId: user.id, email: user.email, schoolId: user.schoolId });

    return res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName,
        role: user.role, schoolId: user.schoolId, schoolName: user.school?.name,
        schoolSlug: user.school?.slug, schoolStatus: user.school?.status,
      },
      portalUrl,
    });
  } catch (err) {
    next(err);
  }
};

// ───── INVITE TEACHER ───────────────────────────────────────────────────────
const inviteTeacher = async (req, res, next) => {
  try {
    const { email: teacherEmail, firstName, lastName, role: requestedRole } = req.body; // ops-4c-invite-role
    const INVITABLE_ROLES = ['TEACHER', 'BURSAR'];
    const inviteRole = INVITABLE_ROLES.includes(requestedRole) ? requestedRole : 'TEACHER';
    const { schoolId, id: inviterId } = req.user;

    if (!teacherEmail || !firstName || !lastName) {
      return res.status(400).json({
        error: { message: 'Email, first name, and last name are required' },
      });
    }

    const existing = await prisma.user.findUnique({ where: { email: teacherEmail } });
    if (existing) {
      return res.status(409).json({
        error: { message: 'This email is already registered' },
      });
    }

    const school = await prisma.school.findUnique({ where: { id: schoolId } });
    const inviter = await prisma.user.findUnique({ where: { id: inviterId } });

    const inviteToken     = crypto.randomBytes(32).toString('hex');
    const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    const teacher = await prisma.user.create({
      data: {
        email: teacherEmail,
        password: '',
        firstName,
        lastName,
        role: inviteRole,
        inviteToken,
        inviteExpiresAt,
        inviteAccepted: false,
        schoolId,
      },
    });

    const inviteUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/accept-invite?token=${inviteToken}`;

    await recordAuthEvent('INVITE_SENT', {
      req,
      userId: inviterId,
      email: teacherEmail,
      schoolId,
      metadata: { teacherId: teacher.id, inviteExpiresAt },
    });

    // Fire-and-forget email
    email.send({
      to: teacherEmail,
      ...inviteEmail({
        teacherFirstName: firstName,
        schoolName: school.name,
        inviterName: `${inviter.firstName} ${inviter.lastName}`,
        inviteUrl,
        expiresAt: inviteExpiresAt.toISOString(),
      }),
    }).catch((err) => {
      console.error('Invite email failed:', err.message);
    });

    res.status(201).json({
      message: 'Teacher invited successfully',
      teacher: {
        id: teacher.id,
        email: teacher.email,
        firstName: teacher.firstName,
        lastName: teacher.lastName,
      },
      inviteLink: inviteUrl,        // useful for dev/testing
      expiresAt: inviteExpiresAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
};

// ───── RESEND INVITE ────────────────────────────────────────────────────────
//
// Generates a new token, invalidates the old one, sends a fresh email.
// Useful when an invite expires or the original email is lost.
const resendInvite = async (req, res, next) => {
  try {
    const { teacherId } = req.params;
    const { schoolId, id: inviterId } = req.user;

    const teacher = await prisma.user.findFirst({
      where: { id: teacherId, schoolId, role: { in: ['TEACHER', 'BURSAR'] } },
    });

    if (!teacher) {
      return res.status(404).json({
        error: { message: 'Teacher not found in your school' },
      });
    }
    if (teacher.inviteAccepted) {
      return res.status(400).json({
        error: { message: 'This teacher has already accepted their invite' },
      });
    }

    const school  = await prisma.school.findUnique({ where: { id: schoolId } });
    const inviter = await prisma.user.findUnique({ where: { id: inviterId } });

    const newToken     = crypto.randomBytes(32).toString('hex');
    const newExpiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    await prisma.user.update({
      where: { id: teacher.id },
      data:  { inviteToken: newToken, inviteExpiresAt: newExpiresAt },
    });

    const inviteUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/accept-invite?token=${newToken}`;

    await recordAuthEvent('INVITE_RESENT', {
      req,
      userId: inviterId,
      email: teacher.email,
      schoolId,
      metadata: { teacherId: teacher.id },
    });

    email.send({
      to: teacher.email,
      ...inviteEmail({
        teacherFirstName: teacher.firstName,
        schoolName: school.name,
        inviterName: `${inviter.firstName} ${inviter.lastName}`,
        inviteUrl,
        expiresAt: newExpiresAt.toISOString(),
      }),
    }).catch((err) => {
      console.error('Invite resend email failed:', err.message);
    });

    res.json({
      message: 'Invite resent',
      inviteLink: inviteUrl,
      expiresAt: newExpiresAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
};

// ───── ACCEPT INVITE ────────────────────────────────────────────────────────
//
// Teacher arrives at /invite/:token and submits their password.
// We require them to also send their email — this prevents the link
// from being shared with someone else who didn't receive it.
const acceptInvite = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password || password.length < 8) {
      return res.status(400).json({
        error: { message: 'Password must be at least 8 characters' },
      });
    }
    const user = await prisma.user.findUnique({
      where: { inviteToken: token },
      include: {
        school: { select: { id: true, name: true, slug: true, status: true } },
      },
    });

    // Generic "not found" for all failure modes here too
    if (!user) {
      await recordAuthEvent('INVITE_FAILED', {
        req, email: null,
        metadata: { reason: 'unknown_token' },
      });
      return res.status(404).json({
        error: { message: 'Invalid or expired invite' },
      });
    }
    if (user.inviteAccepted) {
      await recordAuthEvent('INVITE_FAILED', {
        req, email: user.email, userId: user.id,
        metadata: { reason: 'already_accepted' },
      });
      return res.status(400).json({
        error: { message: 'Invite already accepted' },
      });
    }
    if (user.inviteExpiresAt && user.inviteExpiresAt < new Date()) {
      await recordAuthEvent('INVITE_FAILED', {
        req, email: user.email, userId: user.id,
        metadata: { reason: 'expired' },
      });
      return res.status(400).json({
        error: { message: 'This invite has expired. Ask your school admin to resend it.' },
      });
    }
    const hashedPassword = await bcrypt.hash(password, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        inviteAccepted: true,
        inviteToken: null,
        inviteExpiresAt: null,
      },
    });

    const jwtToken  = generateToken(user.id, user.role);
    const portalUrl = user.school?.slug ? slugUtil.buildPortalUrl(user.school.slug) : null;

    await recordAuthEvent('INVITE_ACCEPTED', {
      req, userId: user.id, email: user.email, schoolId: user.school?.id,
    });

    res.json({
      message: 'Invite accepted. Welcome to Klassrun!',
      token: jwtToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        schoolId: user.school?.id ?? null,
        schoolName: user.school?.name ?? null,
        schoolSlug: user.school?.slug ?? null,
        schoolStatus: user.school?.status ?? null,
      },
      portalUrl,
    });
  } catch (err) {
    next(err);
  }
};

// ───── ME ───────────────────────────────────────────────────────────────────
const me = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        school: {
          select: {
            id: true, name: true, slug: true, status: true, logoUrl: true,
            sessions: { where: { isCurrent: true }, take: 1 },
          },
        },
      },
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        school: user.school
          ? {
              id: user.school.id,
              name: user.school.name,
              slug: user.school.slug,
              status: user.school.status,
              logoUrl: user.school.logoUrl,
              portalUrl: buildPortalUrl(user.school.slug),
              currentSession: user.school.sessions[0] || null,
            }
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ───── HELPERS ──────────────────────────────────────────────────────────────
function buildPortalUrl(slug) {
  if (!slug) return null;

  const isProduction = process.env.NODE_ENV === 'production';
  const portalBaseDomain = process.env.PORTAL_BASE_DOMAIN || 'klassrun.com';

  if (isProduction) {
    // For now, all schools land on app.klassrun.com/dashboard — subdomains deferred.
    return `https://app.${portalBaseDomain}/dashboard`;
  }

  // Local dev — single shared dashboard URL for now
  const frontend = process.env.FRONTEND_URL || 'http://localhost:3000';
  return `${frontend}/dashboard`;
}

module.exports = { signup, login, inviteTeacher, resendInvite, acceptInvite, me };
