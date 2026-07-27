// src/lib/teacher-cap.js
// phaseb1-teacher-cap
//
// Seat limits per plan: Starter 10, Standard 30, Premium unlimited.
//
// SHIPPED UNWIRED in B1. The invite-creation seam is not in
// teachers.controller.js (that file only lists/revokes/reinstates/resets), so
// this module is delivered tested but not yet called. Wiring it is a
// one-line insert at the real seam once that file is identified - deliberately
// left to a follow-up rather than guessed at.
//
// Rules:
//   - An ACTIVE trial is UNCAPPED (same all-access rule as plan-gate.js).
//   - Obeys GATING_MODE exactly like plan-gate: 'observe' logs and allows,
//     'enforce' blocks. Anything not the literal 'enforce' is observe.
//   - Counts the same population the school's own teacher list counts:
//     role in (TEACHER, BURSAR), revokedAt: null.
//   - Fails OPEN on a database error. A seat check must never stop a school
//     from staffing itself.

const prisma = require('../config/db');

const CAPS = { starter: 10, standard: 30, premium: Infinity };
const STAFF_ROLES = ['TEACHER', 'BURSAR'];

function mode() { return process.env.GATING_MODE === 'enforce' ? 'enforce' : 'observe'; }

function trialActive(sub) {
  return !!sub && sub.status === 'TRIAL' && !!sub.trialEndsAt
    && new Date(sub.trialEndsAt).getTime() > Date.now();
}

function capForPlan(plan) {
  const c = CAPS[String(plan || 'starter').toLowerCase()];
  return c === undefined ? CAPS.starter : c;
}

/**
 * May this school add one more staff seat?
 *
 * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string, cap: number, current: number, upgrade: true }>}
 */
async function checkTeacherCap(schoolId) {
  if (!schoolId) return { ok: true };

  let sub;
  let current;
  try {
    sub = await prisma.subscription.findUnique({ where: { schoolId } });
    current = await prisma.user.count({
      where: { schoolId, role: { in: STAFF_ROLES }, revokedAt: null },
    });
  } catch (err) {
    console.error('[teacher-cap] check failed, allowing (fail-open):', (err && err.message) || err);
    return { ok: true };
  }

  if (!sub) return { ok: true };
  if (trialActive(sub)) return { ok: true };

  const cap = capForPlan(sub.plan);
  if (current < cap) return { ok: true };

  if (mode() === 'observe') {
    console.warn('[GATE observe] axis=seats would-block school=%s plan=%s seats=%s cap=%s',
      schoolId, sub.plan, current, cap);
    return { ok: true };
  }

  const planLabel = String(sub.plan || 'starter');
  return {
    ok: false,
    code: 'TEACHER_CAP_REACHED',
    message: 'Your ' + planLabel + ' plan includes ' + cap + ' staff accounts and all ' + cap +
      ' are in use. Upgrade your plan, or revoke an account you no longer need.',
    cap: cap,
    current: current,
    upgrade: true,
  };
}

module.exports = { checkTeacherCap, capForPlan, CAPS, _internal: { trialActive, mode } };
