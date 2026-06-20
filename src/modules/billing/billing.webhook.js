// src/modules/billing/billing.webhook.js
// pay-1-billing-webhook
//
// Public endpoint. MOUNTED WITH express.raw BEFORE express.json (req.body is a
// Buffer) so the HMAC signature can be verified over the exact raw bytes.
// Paystack retries until it gets a 2xx, so:
//   - transient failure (Paystack API down) -> 500 (let it retry)
//   - terminal failure  (underpaid / bad metadata) -> 200 (stop retrying)
//   - success / ignored event -> 200

const paystack = require('../../lib/paystack');
const { activateFromReference } = require('./billing.activate');

const TRANSIENT = new Set(['PAYSTACK_VERIFY_FAILED', 'NO_PAYSTACK_KEY']);

async function billingWebhook(req, res) {
  const raw = req.body;
  if (!Buffer.isBuffer(raw)) {
    console.error('[billing/webhook] body is not a raw Buffer — check mount order (must precede express.json)');
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
    if (TRANSIENT.has(err.code)) {
      console.error('[billing/webhook] transient — Paystack will retry:', err.code, err.message);
      return res.sendStatus(500);
    }
    console.error('[billing/webhook] terminal (acked):', err.code || err.message);
    return res.sendStatus(200);
  }
}

module.exports = billingWebhook;
