// src/lib/boot-report.js
// pay2-hardening-v1-boot
//
// One glance at the top of every boot answers: which Paystack mode, which
// prices, which billing period + grace, which gate mode, which NODE_ENV.
// A wrong key or a typo'd PRICE_* env is visible in the first ten log lines
// forever, instead of being discovered when a school is charged.

const paystack = require('./paystack');

function fmtNaira(kobo) {
  return '\u20A6' + (kobo / 100).toLocaleString('en-NG');
}

module.exports = function bootReport() {
  try {
    const key = process.env.PAYSTACK_SECRET_KEY || '';
    const payMode = key.indexOf('sk_live_') === 0 ? 'LIVE'
      : key.indexOf('sk_test_') === 0 ? 'TEST' : 'NOT SET';
    const prices = paystack.planPrices();
    const periodDays = (function () {
      const n = Number(process.env.BILLING_PERIOD_DAYS);
      return Number.isInteger(n) && n >= 1 && n <= 366 ? n : 30;
    })();
    const graceDays = (function () {
      const n = Number(process.env.BILLING_GRACE_DAYS);
      return Number.isInteger(n) && n >= 0 && n <= 30 ? n : 3;
    })();
    const rawGate = process.env.GATING_MODE;
    const gate = rawGate === 'enforce' ? 'enforce'
      : (rawGate && rawGate !== 'observe') ? 'observe (unrecognized "' + rawGate + '")' : 'observe';
    console.log('[boot] Paystack: %s | prices: starter %s / standard %s / premium %s | period: %sd + %sd grace | gate: %s | NODE_ENV: %s',
      payMode, fmtNaira(prices.starter), fmtNaira(prices.standard), fmtNaira(prices.premium),
      periodDays, graceDays, gate, process.env.NODE_ENV || '(unset)');
    var names = ['STARTER', 'STANDARD', 'PREMIUM'];
    for (var i = 0; i < names.length; i++) {
      var raw = process.env['PRICE_' + names[i]];
      if (raw !== undefined && (!Number.isInteger(Number(raw)) || Number(raw) < 100)) {
        console.warn('[boot] WARNING: PRICE_%s is set but invalid ("%s") - the fallback price is in use. Fix the env.', names[i], raw);
      }
    }
  } catch (e) {
    // The report must never take the API down.
    console.error('[boot] boot-report failed (non-fatal):', e && e.message);
  }
};
