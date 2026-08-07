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
const ledger = require('../../lib/billing-ledger'); // phaseb1-ledger-require

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

async function activateFromReference(reference, opts) {
  // phaseb1-ledger-source: which activator got here first. Defaults to
  // webhook because the webhook is primary and is the ONLY activator for
  // transfer/USSD payers who never return to the callback page.
  const source = (opts && opts.source) || 'webhook';
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

  // pricelock-v1: the subscription is loaded BEFORE the money checks, because
  // the price a school owes is the price it was QUOTED at checkout - not
  // whatever PRICE_* says when the webhook lands.
  const sub = await prisma.subscription.findUnique({ where: { schoolId } });
  if (!sub) { const e = new Error('No subscription for school ' + schoolId); e.code = 'PAY_NO_SUB'; throw e; }

  // pricelock-v1: the replay check also moves ahead of the money checks. An
  // already-applied payment must not be re-validated against a price that
  // may have moved since it was applied.
  if (sub.paystackRef === reference) {
    return { activated: false, alreadyProcessed: true, status: sub.status, plan: sub.plan };
  }

  // pricelock-v1: per-plan on purpose. A school locked at starter that upgrades
  // to premium must be charged premium's CURRENT price, not its old figure.
  const lockedKobo = (sub.priceKoboPlan === plan && Number.isInteger(sub.priceKobo) && sub.priceKobo >= 100)
    ? sub.priceKobo
    : null;
  const price = lockedKobo || paystack.priceForPlan(plan);
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

  const endDate = resolveEndDate(sub); // pay2-hardening-v1 never-shrink

  const updated = await prisma.subscription.update({
    where: { schoolId },
    data: {
      plan,
      status: 'ACTIVE',
      endDate,
      paystackRef: reference,
      paystackCustId: (txn.customer && txn.customer.customer_code) || sub.paystackCustId || null,
      // pricelock-v1: confirm the lock against what was actually validated, so a
      // paying school's price is settled by payment rather than by a quote.
      priceKobo: price,
      priceKoboPlan: plan,
    },
  });

  // phaseb1-ledger-book: book the payment, then receipt it. Both are
  // non-fatal by construction - the school has paid and is ACTIVE no
  // matter what the bookkeeping does next. payments.reference is UNIQUE,
  // so a webhook/verify race books exactly one row and, because the
  // receipt is gated on winning that insert, sends exactly one receipt.
  const booked = await ledger.recordPayment({
    reference: reference,
    schoolId: schoolId,
    plan: plan,
    amountKobo: txn.amount,
    currency: txn.currency,
    channel: txn.channel || null,
    source: source,
    paidAt: txn.paid_at ? new Date(txn.paid_at) : new Date(),
    rawEvent: txn,
  });
  if (booked.written) {
    await ledger.sendReceipt({
      schoolId: schoolId,
      plan: plan,
      amountKobo: txn.amount,
      reference: reference,
      endDate: endDate,
    });
  }

  return { activated: true, alreadyProcessed: false, status: updated.status, plan: updated.plan, endDate };
}

module.exports = { activateFromReference, resolveEndDate, PERIOD_DAYS };
