// src/modules/auth/auth.routes.js
//
// All authentication-related routes.

const router = require('express').Router();
const {
  signup, login, inviteTeacher, resendInvite, acceptInvite, me,
} = require('./auth.controller');
const {
  forgotPassword, resetPassword,
} = require('./password-reset.controller');
const { authenticate, authorize } = require('../../middleware/auth');

// ── Public endpoints ──────────────────────────────────────────────────────
router.post('/signup',          signup);
router.post('/login',           login);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password',  resetPassword);
router.post('/invite/:token/accept', acceptInvite);

// ── Authenticated endpoints ────────────────────────────────────────────────
router.get('/me', authenticate, me);

// ── School-admin actions ───────────────────────────────────────────────────
router.post('/invite',                   authenticate, authorize('SCHOOL_ADMIN'), inviteTeacher);
router.post('/invite/resend/:teacherId', authenticate, authorize('SCHOOL_ADMIN'), resendInvite);

module.exports = router;
