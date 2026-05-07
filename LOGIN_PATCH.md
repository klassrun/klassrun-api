// ─────────────────────────────────────────────────────────────────────────────
//  LOGIN PATCH — apply to klassrun-api/src/modules/auth/auth.controller.js
// ─────────────────────────────────────────────────────────────────────────────
//
// This patch adds account lockout protection to the login endpoint.
//
// Replaces the existing login function (find the function `const login = async`)
// with the version below.
//
// Behavior:
//   - 10 failed login attempts in a row → account locked for 15 minutes
//   - Successful login resets the counter
//   - Lockout is per-account, not per-IP (defends against forgotten-password
//     panic attacks where a user types the wrong password 50 times).
//
// IMPORTANT: This patch ASSUMES you've added these fields to the User model:
//   failedLoginCount  Int        @default(0)
//   lockedUntil       DateTime?
// (See SCHEMA_PATCH_V3.md)

const FAILED_ATTEMPTS_LIMIT  = 10;
const LOCKOUT_MINUTES        = 15;

const login = async (req, res, next) => {
  try {
    const { email: loginEmail, password } = req.body;

    if (!loginEmail || !password) {
      return res.status(400).json({
        error: { message: 'Email and password are required' },
      });
    }

    const normalizedEmail = loginEmail.trim().toLowerCase();

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { school: { select: { id: true, name: true, slug: true, status: true } } },
    });

    // Don't reveal whether the email exists. Generic error.
    const genericInvalidCredentials = {
      error: { message: 'Invalid email or password' },
    };

    if (!user) {
      await recordAuthEvent('LOGIN_FAILED', {
        req,
        email: normalizedEmail,
        metadata: { reason: 'no_such_user' },
      });
      return res.status(401).json(genericInvalidCredentials);
    }

    // Revoked?
    if (user.revokedAt) {
      await recordAuthEvent('LOGIN_FAILED', {
        req,
        email: user.email,
        userId: user.id,
        schoolId: user.schoolId,
        metadata: { reason: 'revoked' },
      });
      return res.status(403).json({
        error: { message: 'Your access has been revoked. Please contact your school administrator.' },
      });
    }

    // School suspended?
    if (user.school?.status === 'SUSPENDED') {
      await recordAuthEvent('LOGIN_FAILED', {
        req,
        email: user.email,
        userId: user.id,
        schoolId: user.schoolId,
        metadata: { reason: 'school_suspended' },
      });
      return res.status(403).json({
        error: { message: 'This school has been suspended. Contact Klassrun support.' },
      });
    }

    // Currently locked?
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await recordAuthEvent('LOGIN_FAILED', {
        req,
        email: user.email,
        userId: user.id,
        schoolId: user.schoolId,
        metadata: { reason: 'locked', lockedUntil: user.lockedUntil },
      });
      const minutesLeft = Math.ceil((user.lockedUntil - Date.now()) / 60000);
      return res.status(423).json({
        error: { message: `Account temporarily locked. Try again in ${minutesLeft} minute(s).` },
      });
    }

    // Has invitation never been accepted?
    if (!user.inviteAccepted) {
      await recordAuthEvent('LOGIN_FAILED', {
        req,
        email: user.email,
        userId: user.id,
        schoolId: user.schoolId,
        metadata: { reason: 'invite_not_accepted' },
      });
      return res.status(403).json({
        error: { message: 'Please accept your invite via the link in your email before logging in.' },
      });
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      const newFailedCount = user.failedLoginCount + 1;
      const updates = { failedLoginCount: newFailedCount };

      if (newFailedCount >= FAILED_ATTEMPTS_LIMIT) {
        updates.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
        updates.failedLoginCount = 0; // reset counter when locking

        await recordAuthEvent('ACCOUNT_LOCKED', {
          req,
          email: user.email,
          userId: user.id,
          schoolId: user.schoolId,
          metadata: { lockedUntil: updates.lockedUntil },
        });
      }

      await prisma.user.update({
        where: { id: user.id },
        data:  updates,
      });

      await recordAuthEvent('LOGIN_FAILED', {
        req,
        email: user.email,
        userId: user.id,
        schoolId: user.schoolId,
        metadata: { reason: 'wrong_password', failedCount: newFailedCount },
      });

      if (updates.lockedUntil) {
        return res.status(423).json({
          error: { message: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.` },
        });
      }
      return res.status(401).json(genericInvalidCredentials);
    }

    // Login succeeded — reset failure counter, issue token
    await prisma.user.update({
      where: { id: user.id },
      data:  { failedLoginCount: 0, lockedUntil: null },
    });

    const token = jwt.sign(
      {
        userId:   user.id,
        role:     user.role,
        schoolId: user.schoolId,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN },
    );

    const portalUrl = user.school?.slug ? buildPortalUrl(user.school.slug) : null;

    await recordAuthEvent('LOGIN_SUCCESS', {
      req,
      userId: user.id,
      email: user.email,
      schoolId: user.schoolId,
    });

    return res.json({
      message: 'Login successful',
      token,
      user: {
        id:         user.id,
        email:      user.email,
        firstName:  user.firstName,
        lastName:   user.lastName,
        role:       user.role,
        schoolId:   user.schoolId,
        schoolName: user.school?.name,
        schoolSlug: user.school?.slug,
        schoolStatus: user.school?.status,
      },
      portalUrl,
    });
  } catch (err) {
    next(err);
  }
};
