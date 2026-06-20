// src/lib/paystack.js
// pay-1-paystack-lib
//
// Thin Paystack API wrapper for Klassrun billing. NO Prisma here (stays
// fake-repo testable). Prices are read from env so they can change WITHOUT a
// code change or redeploy — current values are baked in as fallbacks.
//
//   PRICE_STARTER / PRICE_STANDARD / PRICE_PREMIUM   (kobo; override anytime)
//   PAYSTACK_SECRET_KEY                               (test key, then live key)

const crypto = require('crypto');

const PAYSTACK_BASE = 'https://api.paystack.co';
const VALID_PLANS = ['starter', 'standard', 'premium'];

// Prices in kobo. Env-overridable; fallbacks = ₦40k / ₦60k / ₦150k.
function planPrices() {
  return {
    starter:  Number(process.env.PRICE_STARTER)  || 4000000,
    standard: Number(process.env.PRICE_STANDARD) || 6000000,
    premium:  Number(process.env.PRICE_PREMIUM)  || 15000000,
  };
}
function priceForPlan(plan) {
  return planPrices()[plan];
}

function secret() {
  const k = process.env.PAYSTACK_SECRET_KEY;
  if (!k) { const e = new Error('PAYSTACK_SECRET_KEY not set'); e.code = 'NO_PAYSTACK_KEY'; throw e; }
  return k;
}

// HMAC-SHA512 of the RAW request body, compared timing-safely to the
// x-paystack-signature header. rawBody must be a Buffer.
function verifySignature(rawBody, signature) {
  if (!signature || !rawBody) return false;
  let hash;
  try { hash = crypto.createHmac('sha512', secret()).update(rawBody).digest('hex'); }
  catch { return false; }
  const a = Buffer.from(hash);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function initializeTransaction({ email, amountKobo, metadata, callbackUrl }) {
  const res = await fetch(PAYSTACK_BASE + '/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, amount: amountKobo, metadata, callback_url: callbackUrl }),
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data || !data.status || !data.data) {
    const e = new Error('Paystack init failed: ' + ((data && data.message) || res.status));
    e.code = 'PAYSTACK_INIT_FAILED';
    throw e;
  }
  return {
    authorization_url: data.data.authorization_url,
    reference: data.data.reference,
    access_code: data.data.access_code,
  };
}

async function verifyTransaction(reference) {
  const res = await fetch(PAYSTACK_BASE + '/transaction/verify/' + encodeURIComponent(reference), {
    headers: { Authorization: 'Bearer ' + secret() },
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data || !data.status || !data.data) {
    const e = new Error('Paystack verify failed: ' + ((data && data.message) || res.status));
    e.code = 'PAYSTACK_VERIFY_FAILED';
    throw e;
  }
  return data.data;
}

module.exports = {
  PAYSTACK_BASE,
  VALID_PLANS,
  planPrices,
  priceForPlan,
  verifySignature,
  initializeTransaction,
  verifyTransaction,
  _internals: { secret },
};
