// src/modules/teachers/teachers.routes.js

const router = require('express').Router();
const {
  listTeachers,
  revokeTeacher,
  reinstateTeacher,
  resetTeacherPassword,
} = require('./teachers.controller');
const { authenticate, authorize } = require('../../middleware/auth');

// All teacher management requires SCHOOL_ADMIN role
router.use(authenticate, authorize('SCHOOL_ADMIN'));

router.get('/',                           listTeachers);
router.patch('/:id/revoke',               revokeTeacher);
router.patch('/:id/reinstate',            reinstateTeacher);
router.post('/:id/reset-password',        resetTeacherPassword);

module.exports = router;
