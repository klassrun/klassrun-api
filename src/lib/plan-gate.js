// src/lib/plan-gate.js
// gate-1-plan-gate-lib
//
// Two-axis entitlement gate for Klassrun. Ships DORMANT (observe): it computes
// and LOGS what it WOULD block, then allows the request through. Flip
// GATING_MODE=enforce only AFTER Paystack ships (the upgrade path). Anything
// other than the literal string 'enforce' means observe (fail-open).
//
//   Axis 1 — requirePlan(feature):     does the school's PLAN include this?
//            First enforcement pass blocks the Starter boundary ONLY
//            (a Starter-tier school reaching Standard/Premium writes).
//   Axis 2 — requireActiveForWrites:   is the subscription live enough to write?
//            Mirrors checkGenerationAllowed (402). Read-only freezes ALL
//            mutations (AI + operations); GETs always pass.
//
// An ACTIVE (non-expired) TRIAL gets ALL-ACCESS (effective tier = premium),
// regardless of the placeholder `plan` column that signup sets to 'starter'.
// Both wrappers no-op on GET/HEAD/OPTIONS, so reads are never gated here.

const prisma = require('../config/db');

const TIER_RANK = { starter: 0, standard: 1, premium: 2 };

const PLAN_FEATURES = {
  AI_LESSON_NOTES:             { minTier: 'starter'  },
  AI_SCHEMES:                  { minTier: 'starter'  },
  AI_EXAMS:                    { minTier: 'starter'  },
  QUESTION_BANK:               { minTier: 'starter'  },
  BRANDING:                    { minTier: 'starter'  },
  NERDC_ALIGNMENT:             { minTier: 'standard' },
  SCHEME_UPLOAD:               { minTier: 'standard' },
  RESULTS_REPORTCARDS:         { minTier: 'standard' },
  AI_COMMENTS:                 { minTier: 'standard' },
  ATTENDANCE:                  { minTier: 'standard' },
  BEHAVIOUR:                   { minTier: 'standard' },
  STUDENTS:                    { minTier: 'standard' },
  PROMOTION:                   { minTier: 'standard' },
  FEES:                        { minTier: 'premium'  },
  BURSAR_ROLE:                 { minTier: 'premium'  },
  PARENT_PORTAL:               { minTier: 'premium'  },
  CBT:                         { minTier: 'premium'  },
  CMS_NOTIFICATIONS_ANALYTICS: { minTier: 'premium'  },
};

function mode() { return process.env.GATING_MODE === 'enforce' ? 'enforce' : 'observe'; }
function isWrite(method) { return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'; }
function trialActive(sub) {
  return sub.status === 'TRIAL' && !!sub.trialEndsAt && sub.trialEndsAt.getTime() > Date.now();
}
function effectiveRank(sub) {
  if (trialActive(sub)) return TIER_RANK.premium;
  const r = TIER_RANK[String(sub.plan || 'starter').toLowerCase()];
  return (r === undefined) ? 0 : r;
}
function canWrite(sub) {
  if (sub.status === 'ACTIVE' || sub.status === 'PAST_DUE') return true;
  if (sub.status === 'TRIAL') return trialActive(sub);
  return false;
}
function loadSub(schoolId) {
  if (!schoolId) return Promise.resolve(null);
  return prisma.subscription.findUnique({ where: { schoolId } });
}
function logObserve(axis, req, extra) {
  console.warn('[GATE observe] axis=%s would-block school=%s %s %s %s',
    axis, (req.user && req.user.schoolId) || 'none', req.method, req.originalUrl, extra || '');
}
function requireActiveForWrites(req, res, next) {
  if (!isWrite(req.method)) return next();
  loadSub(req.user && req.user.schoolId).then(function (sub) {
    if (sub && canWrite(sub)) return next();
    if (mode() === 'observe') { logObserve('write', req, 'status=' + (sub ? sub.status : 'no-sub')); return next(); }
    return res.status(402).json({ error: { message: 'Your subscription is read-only. Subscribe to make changes.' } });
  }).catch(next);
}
function requirePlan(feature) {
  return function (req, res, next) {
    if (!isWrite(req.method)) return next();
    const def = PLAN_FEATURES[feature];
    const requiredRank = def ? TIER_RANK[def.minTier] : 0;
    loadSub(req.user && req.user.schoolId).then(function (sub) {
      if (!sub) return next();
      const rank = effectiveRank(sub);
      const blocked = rank === 0 && requiredRank > 0;
      if (!blocked) return next();
      if (mode() === 'observe') { logObserve('plan', req, 'plan=' + sub.plan + ' feature=' + feature); return next(); }
      return res.status(403).json({ error: { message: "Your plan doesn't include this feature. Upgrade to continue." }, upgrade: true, feature: feature });
    }).catch(next);
  };
}
module.exports = {
  requirePlan: requirePlan,
  requireActiveForWrites: requireActiveForWrites,
  PLAN_FEATURES: PLAN_FEATURES,
  _internal: { effectiveRank: effectiveRank, canWrite: canWrite, trialActive: trialActive, TIER_RANK: TIER_RANK },
};
