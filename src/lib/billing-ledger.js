// src/lib/billing-ledger.js
// phaseb1-ledger
//
// The payments ledger and the activation receipt. Both are deliberately
// NON-FATAL: a school that has paid must end up ACTIVE even if the ledger
// insert races, the receipt bounces, or Resend is down. Money first,
// bookkeeping second.
//
// EXACTLY-ONCE: payments.reference is UNIQUE in the database. The webhook
// and the /verify backup activator can both reach recordPayment for the same
// reference (they race by design - the webhook is primary, verify is the
// safety net). The unique index settles it: the loser gets P2002 and is
// treated as a no-op success. No advisory locks, no read-then-write window.

const prisma = require('../config/db');
const email = require('./email');
const { receiptEmail } = require('./email-templates/receipt');

// Prisma's unique-constraint code. A duplicate reference means the other
// caller (webhook or verify) already booked this payment.
const P2002 = 'P2002';

function nairaFromKobo(kobo) {
  const n = Number(kobo);
  if (!Number.isFinite(n)) return '\u20A60';
  return '\u20A6' + (n / 100).toLocaleString('en-NG');
}

/**
 * Book one payment. Idempotent on reference.
 *
 * @returns {Promise<{ written: boolean, duplicate: boolean, error?: string }>}
 */
async function recordPayment(row) {
  try {
    await prisma.payment.create({
      data: {
        reference: row.reference,
        schoolId: row.schoolId,
        plan: row.plan,
        amountKobo: row.amountKobo,
        currency: row.currency || 'NGN',
        channel: row.channel || null,
        source: row.source,
        paidAt: row.paidAt || new Date(),
        rawEvent: row.rawEvent === undefined ? null : row.rawEvent,
        note: row.note || null,
      },
    });
    return { written: true, duplicate: false };
  } catch (err) {
    if (err && err.code === P2002) {
      // The other activator won the race. Correct outcome, not an error.
      return { written: false, duplicate: true };
    }
    // A ledger failure must never un-pay a school. Log loudly, carry on.
    console.error('[billing/ledger] could NOT record payment', row.reference, (err && err.message) || err);
    return { written: false, duplicate: false, error: (err && err.message) || 'unknown' };
  }
}

/**
 * Send the activation receipt. Never throws, never blocks activation.
 * The Terms promise the school a billing record for every payment.
 *
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
async function sendReceipt(opts) {
  try {
    const school = await prisma.school.findUnique({
      where: { id: opts.schoolId },
      select: { name: true, contactEmail: true },
    });
    if (!school) return { sent: false, reason: 'no-school' };

    const to = school.contactEmail;
    if (!to) {
      console.warn('[billing/receipt] no contactEmail for school', opts.schoolId, '- receipt not sent');
      return { sent: false, reason: 'no-contact-email' };
    }

    const tpl = receiptEmail({
      schoolName: school.name,
      plan: opts.plan,
      amountNaira: nairaFromKobo(opts.amountKobo),
      reference: opts.reference,
      endDate: opts.endDate,
      manual: !!opts.manual,
    });

    const result = await email.send({ to: to, subject: tpl.subject, html: tpl.html });
    if (result && result.error) return { sent: false, reason: result.error };
    return { sent: true };
  } catch (err) {
    console.error('[billing/receipt] receipt failed (activation unaffected):', (err && err.message) || err);
    return { sent: false, reason: (err && err.message) || 'unknown' };
  }
}

module.exports = { recordPayment, sendReceipt, nairaFromKobo };
