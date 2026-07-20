// src/modules/billing/billing.routes.js
// pay-1-billing-routes + pay2-hardening-v1
//
// JSON routes (mounted AFTER express.json):
//   POST /api/billing/initialize     SCHOOL_ADMIN -> start a Paystack payment
//   GET  /api/billing/verify/:ref    SCHOOL_ADMIN -> callback poll; also a
//                                    backup activator (webhook is primary).
//   GET  /api/billing/plans          SCHOOL_ADMIN -> prices + billing period
//
// pay2-hardening-v1: /plans also returns periodDays + periodLabel so the
// Subscribe page renders exactly what the API will charge - the words on
// screen can never drift from the billing math.

const router = require('express').Router();
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const paystack = require('../../lib/paystack');
const { activateFromReference, PERIOD_DAYS } = require('./billing.activate');

router.post('/initialize', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const { plan } = req.body || {};
    if (!paystack.VALID_PLANS.includes(plan)) {
      return res.status(400).json({ error: { message: 'Invalid plan', field: 'plan' } });
    }
    const amountKobo = paystack.priceForPlan(plan);
    if (!amountKobo || amountKobo < 100) {
      return res.status(500).json({ error: { message: 'Plan price not configured' } });
    }

    const school = await prisma.school.findUnique({ where: { id: req.user.schoolId } });
    if (!school) return res.status(404).json({ error: { message: 'School not found' } });

    let email = school.contactEmail;
    if (!email) {
      const u = await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true } });
      email = u && u.email;
    }
    if (!email) {
      return res.status(400).json({ error: { message: 'Set a school contact email before subscribing.' } });
    }

    const appUrl = process.env.APP_URL || 'https://app.klassrun.com';
    let init;
    try {
      init = await paystack.initializeTransaction({
        email,
        amountKobo,
        metadata: { schoolId: req.user.schoolId, plan },
        callbackUrl: appUrl + '/billing/callback',
      });
    } catch (err) {
      if (err.code === 'NO_PAYSTACK_KEY') {
        return res.status(503).json({ error: { message: 'Payments not configured yet. Contact support.' } });
      }
      console.error('[billing/initialize] paystack init failed:', err.message);
      return res.status(502).json({ error: { message: 'Could not start payment. Please try again.' } });
    }

    return res.status(200).json({
      authorizationUrl: init.authorization_url,
      reference: init.reference,
    });
  } catch (err) { next(err); }
});

router.get('/verify/:reference', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const reference = req.params.reference;
    try {
      await activateFromReference(reference);
    } catch (err) {
      console.error('[billing/verify] backup activation note:', err.code || err.message);
    }
    const sub = await prisma.subscription.findUnique({ where: { schoolId: req.user.schoolId } });
    if (!sub) return res.status(404).json({ error: { message: 'No subscription' } });
    const paid = sub.paystackRef === reference && sub.status === 'ACTIVE';
    return res.json({ paid, status: sub.status, plan: sub.plan, endDate: sub.endDate });
  } catch (err) { next(err); }
});

// gate2-billing-plans + pay2-hardening-v1-period
router.get('/plans', authenticate, authorize('SCHOOL_ADMIN'), (req, res) => {
  const periodLabel = PERIOD_DAYS === 30 ? 'month' : PERIOD_DAYS === 120 ? 'term' : PERIOD_DAYS + ' days';
  res.json({ prices: paystack.planPrices(), currency: 'NGN', periodDays: PERIOD_DAYS, periodLabel });
});

module.exports = router;
