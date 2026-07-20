// src/modules/billing/billing.activate.js
// pay-1-billing-activate + pay2-hardening-v1
//
// Shared activation logic used by BOTH the webhook (primary, production) and
// the verify endpoint (backup). Idempotent on reference.
//
// pay2-hardening-v1 (monthly billing):
//   - Every successful payment buys a fixed period (BILLING_PERIOD_DAYS env,
//     default 30). The old session-end anchor is gone: sessions are school
//     years, prices are per month.
//   - NEVER-SHRINK: if the school still has paid time left, the new endDate
//     is old endDate + period, so stacking payments = prepaying months. A
//     lapsed or trial school anchors from now. A payment can never leave the
//     endDate where it was.
//   - Naira only: any other currency is terminal (PAY_BAD_CURRENCY).
//   - Price-config guard: a broken PRICE_* env can never silently activate
//     (PAY_PRICE_CONFIG is retryable, so Paystack keeps redelivering while
//     the env is fixed - the payment is never lost).

const prisma = require('../../config/db');
const paystack = require('../../lib/paystack');

const PERIOD_DAYS = (function () {
  const n = Number(process.env.BILLING_PERIOD_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= 366 ? n : 30;
})();
const PERIOD_MS = PERIOD_DAYS * 24 * 60 * 60 * 1000;

// New endDate for a successful payment. sub is the current Subscription row.
// pay2-hardening-v1: period-based and never-shrink.
function resolveEndDate(sub) {
  const now = Date.now();
  const paidTimeLeft = !!sub
    && (sub.status === 'ACTIVE' || sub.status === 'PAST_DUE')
    && sub.endDate
    && new Date(sub.endDate).getTime() > now;
  const base = paidTimeLeft ? new Date(sub.endDate).getTime() : now;
  return new Date(base + PERIOD_MS);
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

  // pay2-hardening-v1: naira only. A "success" in any other currency must
  // never deliver value (terminal: acked, logged, investigated by hand).
  if (txn.currency !== 'NGN') {
    const e = new Error('Unexpected currency ' + txn.currency + ' on ' + reference);
    e.code = 'PAY_BAD_CURRENCY'; throw e;
  }

  const meta = txn.metadata || {};
  const schoolId = meta.schoolId;
  const plan = meta.plan;
  if (!schoolId || !paystack.VALID_PLANS.includes(plan)) {
    const e = new Error('Transaction metadata missing schoolId/plan'); e.code = 'PAY_BAD_METADATA'; throw e;
  }

  const price = paystack.priceForPlan(plan);
  // pay2-hardening-v1: never compare money against garbage. If the resolved
  // price is not a sane integer, fail retryable so no payment is lost while
  // the env is fixed.
  if (!Number.isInteger(price) || price < 100) {
    const e = new Error('Plan price misconfigured for ' + plan + ' (' + price + ')');
    e.code = 'PAY_PRICE_CONFIG'; throw e;
  }
  if (typeof txn.amount !== 'number' || txn.amount < price) {
    const e = new Error('Amount ' + txn.amount + ' below plan price ' + price); e.code = 'PAY_UNDERPAID'; throw e;
  }

  const sub = await prisma.subscription.findUnique({ where: { schoolId } });
  if (!sub) { const e = new Error('No subscription for school ' + schoolId); e.code = 'PAY_NO_SUB'; throw e; }
  if (sub.paystackRef === reference) {
    return { activated: false, alreadyProcessed: true, status: sub.status, plan: sub.plan };
  }

  const endDate = resolveEndDate(sub); // pay2-hardening-v1 never-shrink

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

module.exports = { activateFromReference, resolveEndDate, PERIOD_DAYS };
