const router = require('express').Router();
const { signup, login, inviteTeacher, acceptInvite, me } = require('./auth.controller');
const { authenticate, authorize } = require('../../middleware/auth');

router.post('/signup', signup);
router.post('/login', login);
router.post('/invite', authenticate, authorize('SCHOOL_ADMIN'), inviteTeacher);
router.post('/invite/:token/accept', acceptInvite);
router.get('/me', authenticate, me);

module.exports = router;
