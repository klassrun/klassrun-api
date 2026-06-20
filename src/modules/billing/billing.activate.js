// src/modules/billing/billing.activate.js
// pay-1-billing-activate
//
// Shared activation logic used by BOTH the webhook (primary, production) and
// the verify endpoint (backup — also lets us test with test keys locally,
// where Paystack can't reach a localhost webhook). Idempotent on reference.

const prisma = require('../../config/db');
const paystack = require('../../lib/paystack');

// Paid term ends when the current academic session ends — but sessions have
// NULLABLE dates, so we guard: only use the session end when it exists AND is
// in the future, else fall back to now+120d. A payment must never land a
// school in an already-expired state.
function resolveEndDate(session) {
  const fallback = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000);
  if (session && session.endDate) {
    const end = new Date(session.endDate);
    if (end.getTime() > Date.now()) return end;
  }
  return fallback;
}

async function activateFromReference(reference) {
  if (!reference) { const e = new Error('No reference'); e.code = 'PAY_NO_REF'; throw e; }

  const seen = await prisma.subscription.findFirst({ where: { paystackRef: reference } });
  if (seen) {
    return { activated: false, alreadyProcessed: true, status: seen.status, plan: seen.plan };
  }

  const txn = await paystack.verifyTransaction(reference);
  if (!txn || txn.status !== 'success') {
    return { activated: false, alreadyProcessed: false, status: txn ? txn.status : 'unknown' };
  }

  const meta = txn.metadata || {};
  const schoolId = meta.schoolId;
  const plan = meta.plan;
  if (!schoolId || !paystack.VALID_PLANS.includes(plan)) {
    const e = new Error('Transaction metadata missing schoolId/plan'); e.code = 'PAY_BAD_METADATA'; throw e;
  }

  const price = paystack.priceForPlan(plan);
  if (typeof txn.amount !== 'number' || txn.amount < price) {
    const e = new Error('Amount ' + txn.amount + ' below plan price ' + price); e.code = 'PAY_UNDERPAID'; throw e;
  }

  const sub = await prisma.subscription.findUnique({ where: { schoolId } });
  if (!sub) { const e = new Error('No subscription for school ' + schoolId); e.code = 'PAY_NO_SUB'; throw e; }
  if (sub.paystackRef === reference) {
    return { activated: false, alreadyProcessed: true, status: sub.status, plan: sub.plan };
  }

  const session = await prisma.academicSession.findFirst({ where: { schoolId, isCurrent: true } });
  const endDate = resolveEndDate(session);

  const updated = await prisma.subscription.update({
    where: { schoolId },
    data: {
      plan,
      status: 'ACTIVE',
      endDate,
      paystackRef: reference,
      paystackCustId: (txn.customer && txn.customer.customer_code) || sub.paystackCustId || null,
    },
  });

  return { activated: true, alreadyProcessed: false, status: updated.status, plan: updated.plan, endDate };
}

module.exports = { activateFromReference, resolveEndDate };
