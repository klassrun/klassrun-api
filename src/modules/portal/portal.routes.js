// src/modules/portal/portal.routes.js
// ops-5-portal-routes
//
// Mounted at /api/portal (own prefix — no ordering constraint with staff routes).
// 5b will add the portal-authenticated read endpoints (me, report-cards, fees)
// to this same router.

const router = require('express').Router();
const { authenticate, authorize } = require('../../middleware/auth');
const { portalLogin, portalAccept, sendPortalInvite } = require('./portal.controller');

// ── Public portal auth ──────────────────────────────────────────────────────
router.post('/login', portalLogin);
router.post('/accept/:token', portalAccept);

// ── Staff action: school admin sends a portal invite for a student ──────────
router.post('/invite/:studentId', authenticate, authorize('SCHOOL_ADMIN'), sendPortalInvite);

module.exports = router;
