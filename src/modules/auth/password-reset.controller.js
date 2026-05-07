// src/modules/auth/password-reset.controller.js
//
// Forgot-password and reset-password flow.
//
// Security design:
//   - Tokens are generated as 32-byte random hex (64 chars). The token is
//     emailed to the user but stored in the DB as SHA-256 hash. So if the
//     DB is ever leaked, attackers can't use the tokens directly.
//   - Tokens expire in 1 hour and are single-use (usedAt timestamp set).
//   - Generic responses ("if that email exists, we sent a link") prevent
//     attackers from learning which emails are registered.
//   - Rate limited at the route level (3 requests per email per hour).
//   - Full audit logging at every step.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../../config/db');
const email  = require('../../lib/email');
const { passwordResetEmail }    = require('../../lib/email-templates/password-reset');
const { passwordChangedEmail }  = require('../../lib/email-templates/password-changed');
const { recordAuthEvent } = require('../../lib/audit');

const RESET_TOKEN_TTL_MINUTES = 60;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Hash a token for safe storage in the DB.
 * Plain SHA-256 is fine here — these tokens are already random 256-bit secrets
 * and we don't need bcrypt's slow hashing for non-password values.
 */
function hashToken(plainToken) {
  return crypto.createHash('sha256').update(plainToken).digest('hex');
}

function extractIp(req) {
  return (
    req.get('cf-connecting-ip') ||
    req.get('x-real-ip') ||
    req.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.ip ||
    null
  );
}

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
//
// Body: { email }
// Response: always { message: "If that email is registered, ..." } — even if
//   the email doesn't exist. This prevents email enumeration attacks.

const forgotPassword = async (req, res, next) => {
  try {
    const { email: requestedEmail } = req.body;

    if (!requestedEmail || typeof requestedEmail !== 'string') {
      return res.status(400).json({
        error: { message: 'Email is required' },
      });
    }

    const normalizedEmail = requestedEmail.trim().toLowerCase();

    // The "generic response" message — used whether or not the user exists.
    const genericResponse = {
      message: 'If that email is registered, you will receive a password reset link shortly.',
    };

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { school: { select: { id: true, status: true } } },
    });

    // Log the attempt either way (helps detect enumeration attempts)
    await recordAuthEvent('PASSWORD_RESET_REQUESTED', {
      req,
      email: normalizedEmail,
      userId:   user?.id     ?? null,
      schoolId: user?.school?.id ?? null,
      metadata: { userExisted: !!user },
    });

    if (!user) {
      // Don't reveal that the email isn't registered.
      return res.json(genericResponse);
    }

    // Don't issue resets for revoked or suspended-school users — just silently
    // pretend we sent the email. Real users can contact support.
    if (user.revokedAt || user.school?.status === 'SUSPENDED') {
      return res.json(genericResponse);
    }

    // Generate a fresh token
    const plainToken = crypto.randomBytes(32).toString('hex');
    const tokenHash  = hashToken(plainToken);
    const expiresAt  = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

    // Create the token record. Multiple outstanding tokens are allowed
    // (they all expire individually, all single-use).
    await prisma.passwordResetToken.create({
      data: {
        tokenHash,
        userId:    user.id,
        expiresAt,
        ipAddress: extractIp(req),
        userAgent: req.get('user-agent') ?? null,
      },
    });

    const resetUrl = `${FRONTEND_URL}/reset-password?token=${plainToken}`;

    // Fire-and-forget the email — even if email fails, we already created the
    // token, so the user can request another one.
    const tpl = passwordResetEmail({
      firstName: user.firstName,
      resetUrl,
      expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
    });
    email.send({
      to: user.email,
      subject: tpl.subject,
      html: tpl.html,
    }).catch((err) => {
      console.error('✗ Password reset email failed:', err.message);
    });

    return res.json(genericResponse);
  } catch (err) {
    next(err);
  }
};

// ── POST /api/auth/reset-password ────────────────────────────────────────────
//
// Body: { token, newPassword }
// Validates token, sets new password, marks token used, sends confirmation.

const resetPassword = async (req, res, next) => {
  try {
    const { token: plainToken, newPassword } = req.body;

    if (!plainToken || typeof plainToken !== 'string') {
      return res.status(400).json({ error: { message: 'Token is required' } });
    }
    if (!newPassword || typeof newPassword !== 'string') {
      return res.status(400).json({ error: { message: 'New password is required' } });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({
        error: { message: 'Password must be at least 8 characters' },
      });
    }

    const tokenHash = hashToken(plainToken);

    // Look up the token
    const resetRecord = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: { include: { school: { select: { id: true, status: true } } } } },
    });

    if (!resetRecord) {
      await recordAuthEvent('PASSWORD_RESET_FAILED', {
        req,
        metadata: { reason: 'token_not_found' },
      });
      return res.status(400).json({
        error: { message: 'Invalid or expired reset link. Please request a new one.' },
      });
    }

    // Already used?
    if (resetRecord.usedAt) {
      await recordAuthEvent('PASSWORD_RESET_FAILED', {
        req,
        userId: resetRecord.userId,
        metadata: { reason: 'token_already_used' },
      });
      return res.status(400).json({
        error: { message: 'This reset link has already been used. Please request a new one.' },
      });
    }

    // Expired?
    if (resetRecord.expiresAt < new Date()) {
      await recordAuthEvent('PASSWORD_RESET_FAILED', {
        req,
        userId: resetRecord.userId,
        metadata: { reason: 'token_expired' },
      });
      return res.status(400).json({
        error: { message: 'This reset link has expired. Please request a new one.' },
      });
    }

    // User revoked or school suspended?
    if (resetRecord.user.revokedAt) {
      await recordAuthEvent('PASSWORD_RESET_FAILED', {
        req,
        userId: resetRecord.userId,
        metadata: { reason: 'user_revoked' },
      });
      return res.status(403).json({
        error: { message: 'This account has been revoked. Contact your school administrator.' },
      });
    }
    if (resetRecord.user.school?.status === 'SUSPENDED') {
      await recordAuthEvent('PASSWORD_RESET_FAILED', {
        req,
        userId: resetRecord.userId,
        metadata: { reason: 'school_suspended' },
      });
      return res.status(403).json({
        error: { message: 'This account is currently inactive. Contact Klassrun support.' },
      });
    }

    // All checks passed — update the password and mark token used in one
    // transaction so neither can succeed without the other.
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: resetRecord.userId },
        data: {
          password: hashedPassword,
          // Clear failed login counter and any lockout
          failedLoginCount: 0,
          lockedUntil:      null,
        },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetRecord.id },
        data:  { usedAt: new Date() },
      }),
      // Invalidate any other outstanding reset tokens for this user
      prisma.passwordResetToken.updateMany({
        where: {
          userId: resetRecord.userId,
          id:     { not: resetRecord.id },
          usedAt: null,
        },
        data: { usedAt: new Date() },
      }),
    ]);

    await recordAuthEvent('PASSWORD_RESET_COMPLETED', {
      req,
      userId:   resetRecord.userId,
      schoolId: resetRecord.user.school?.id ?? null,
      email:    resetRecord.user.email,
    });

    // Send confirmation email — fire and forget
    const tpl = passwordChangedEmail({
      firstName: resetRecord.user.firstName,
      ipAddress: extractIp(req),
      userAgent: req.get('user-agent') ?? null,
      when:      new Date(),
    });
    email.send({
      to: resetRecord.user.email,
      subject: tpl.subject,
      html: tpl.html,
    }).catch((err) => {
      console.error('✗ Password changed email failed:', err.message);
    });

    return res.json({ message: 'Password reset successful. You can now log in with your new password.' });
  } catch (err) {
    next(err);
  }
};

module.exports = { forgotPassword, resetPassword };
