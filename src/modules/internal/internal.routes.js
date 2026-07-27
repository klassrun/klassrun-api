// src/modules/internal/internal.routes.js
// phaseb1-internal-routes
//
// Machine-to-machine endpoints. NO user auth - these are called by GitHub
// Actions, not by a browser. The only credential is CRON_SECRET, compared in
// constant time.
//
//   POST /api/internal/billing-sweep          run today's reminder sweep
//   POST /api/internal/billing-sweep?dry=1    classify only: no locks, no mail
//
// If CRON_SECRET is unset the endpoint answers 503 rather than running
// unauthenticated. An endpoint that mails every principal on the platform
// does not get a fail-open default.

const crypto = require('crypto');
const router = require('express').Router();
const { runSweep } = require('../../lib/billing-sweep');

function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on length mismatch, so equalise first. Length is
  // not a secret; the bytes are.
  if (a.length !== b.length) {
    // Still burn a comparison so the failure path costs the same.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function requireCronSecret(req, res, next) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[internal] CRON_SECRET is not set - refusing to run internal jobs');
    return res.status(503).json({ error: { message: 'Internal jobs are not configured' } });
  }
  const provided = req.get('x-cron-secret');
  if (!secretMatches(provided, expected)) {
    console.warn('[internal] rejected billing-sweep call with bad or missing x-cron-secret');
    return res.status(401).json({ error: { message: 'Unauthorized' } });
  }
  return next();
}

router.post('/billing-sweep', requireCronSecret, async (req, res, next) => {
  try {
    const dryRun = req.query && (req.query.dry === '1' || req.query.dry === 'true');
    const summary = await runSweep({ dryRun: dryRun });
    return res.json({ ok: true, summary });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
