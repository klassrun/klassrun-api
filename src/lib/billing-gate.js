// src/lib/billing-gate.js
//
// Trial / subscription gate for AI generation endpoints.
//
// Returns a 402-shaped error when:
//   - school has no Subscription row (shouldn't happen - signup creates one)
//   - subscription.status is EXPIRED or CANCELLED
//   - subscription.status is TRIAL AND trialEndsAt is in the past
//   - subscription.status is ACTIVE/PAST_DUE AND endDate + grace is past
//
// batch-3-phase-1-billing-gate + pay2-hardening-v1
//
// pay2-hardening-v1: ACTIVE/PAST_DUE now expire BY DATE, computed on every
// read. Nothing in the stack flips the status string on lapse (there is no
// cron) - the string is "last paid state", liveness comes from the dates.
// A 3-day grace (BILLING_GRACE_DAYS env) applies to PAID lapse only; trials
// still end hard at trialEndsAt.

const prisma = require('../config/db');

const GRACE_DAYS = (function () {
  const n = Number(process.env.BILLING_GRACE_DAYS);
  return Number.isInteger(n) && n >= 0 && n <= 30 ? n : 3;
})();
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Check whether a school can use AI generation.
 *
 * @param {string} schoolId
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
async function checkGenerationAllowed(schoolId) {
  if (!schoolId) {
    return { ok: false, message: 'No school context for this user' };
  }

  const sub = await prisma.subscription.findUnique({
    where: { schoolId },
  });

  if (!sub) {
    return {
      ok: false,
      message: 'No subscription found for your school. Contact support.',
    };
  }

  if (sub.status === 'EXPIRED' || sub.status === 'CANCELLED') {
    return {
      ok: false,
      message: 'Your subscription has ended. Subscribe to keep generating lesson notes.',
    };
  }

  if (sub.status === 'TRIAL') {
    if (!sub.trialEndsAt || sub.trialEndsAt.getTime() < Date.now()) {
      return {
        ok: false,
        message: 'Your free trial has ended. Subscribe to keep generating lesson notes.',
      };
    }
  }

  // pay2-hardening-v1: date-aware expiry for paid states (+ grace).
  if (sub.status === 'ACTIVE' || sub.status === 'PAST_DUE') {
    if (sub.endDate && new Date(sub.endDate).getTime() + GRACE_MS < Date.now()) {
      return {
        ok: false,
        message: 'Your subscription has ended. Renew to keep generating lesson notes.',
      };
    }
  }

  return { ok: true };
}

module.exports = { checkGenerationAllowed };
