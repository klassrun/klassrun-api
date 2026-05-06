const router = require('express').Router();
const {
  signup, login, inviteTeacher, resendInvite, acceptInvite, me,
} = require('./auth.controller');
const { authenticate, authorize } = require('../../middleware/auth');

router.post('/signup', signup);
router.post('/login',  login);

// School-admin actions
router.post('/invite',                       authenticate, authorize('SCHOOL_ADMIN'), inviteTeacher);
router.post('/invite/resend/:teacherId',     authenticate, authorize('SCHOOL_ADMIN'), resendInvite);

// Public — accepts the invite link
router.post('/invite/:token/accept', acceptInvite);

router.get('/me', authenticate, me);

module.exports = router;
