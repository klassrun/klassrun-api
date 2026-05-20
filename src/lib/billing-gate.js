// src/lib/billing-gate.js
//
// Trial / subscription gate for AI generation endpoints.
//
// Returns a 402-shaped error when:
//   - school has no Subscription row (shouldn't happen — signup creates one)
//   - subscription.status is EXPIRED or CANCELLED
//   - subscription.status is TRIAL AND trialEndsAt is in the past
//
// Active subscriptions (ACTIVE, PAST_DUE) can always generate.
// (Paystack integration in a later batch will move PAST_DUE to EXPIRED
// after grace period; until then we don't block past-due users.)
//
// batch-3-phase-1-billing-gate

const prisma = require('../config/db');

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

  return { ok: true };
}

module.exports = { checkGenerationAllowed };
