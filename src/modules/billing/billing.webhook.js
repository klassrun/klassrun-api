// src/modules/billing/billing.webhook.js
// pay-1-billing-webhook + pay2-hardening-v1
//
// Public endpoint. MOUNTED WITH express.raw BEFORE express.json (req.body is a
// Buffer) so the HMAC signature can be verified over the exact raw bytes.
//
// pay2-hardening-v1: the error handling is INVERTED. Before, only a named
// TRANSIENT set returned 500 and every unknown failure was acked 200 - so a
// database blip mid-webhook silently swallowed a real payment (Paystack
// stopped retrying; the school paid and stayed on trial). Now only
// KNOWN-terminal codes are acked 200; every unknown failure returns 500 so
// Paystack retries (every 3 minutes x4, then hourly for 72 hours). For
// transfer/USSD payers who never return to the callback page, this webhook
// is the ONLY activator - it must never lie about having processed a payment.

const paystack = require('../../lib/paystack');
const { activateFromReference } = require('./billing.activate');

const TERMINAL = new Set(['PAY_NO_REF', 'PAY_BAD_METADATA', 'PAY_UNDERPAID', 'PAY_NO_SUB', 'PAY_BAD_CURRENCY']);

async function billingWebhook(req, res) {
  const raw = req.body;
  if (!Buffer.isBuffer(raw)) {
    console.error('[billing/webhook] body is not a raw Buffer - check mount order (must precede express.json)');
    return res.sendStatus(400);
  }

  const signature = req.headers['x-paystack-signature'];
  if (!paystack.verifySignature(raw, signature)) {
    return res.sendStatus(401);
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.sendStatus(400); }

  if (!event || event.event !== 'charge.success' || !event.data || !event.data.reference) {
    return res.sendStatus(200);
  }

  try {
    const result = await activateFromReference(event.data.reference);
    console.log('[billing/webhook] charge.success', event.data.reference, JSON.stringify(result));
    return res.sendStatus(200);
  } catch (err) {
    if (TERMINAL.has(err.code)) {
      console.error('[billing/webhook] terminal (acked, investigate):', err.code, err.message);
      return res.sendStatus(200);
    }
    console.error('[billing/webhook] retryable - Paystack will retry:', err.code || err.message);
    return res.sendStatus(500);
  }
}

module.exports = billingWebhook;
