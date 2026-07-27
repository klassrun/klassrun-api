// src/lib/billing-sweep.js
// phaseb1-sweep
//
// The reminder machine. Runs once a day at 12:00 noon Lagos (GitHub Actions
// calls POST /api/internal/billing-sweep at 11:00 UTC).
//
// Five kinds, each sent at most ONCE per school per calendar day:
//   trial-ends-2d   trial ends the day after tomorrow
//   renewal-2d      paid period ends the day after tomorrow
//   grace-1/2/3     one per day of the 3-day post-lapse grace period
//
// DEDUPLICATION IS A DATABASE LOCK, NOT A FLAG. billing_reminders has
// @@unique([schoolId, kind, dateBucket]); the row is inserted BEFORE the
// email is sent. A same-day re-run (manual trigger, Actions retry, two
// workers) loses the insert with P2002 and sends nothing. The deliberate
// trade-off: if Resend fails after the lock is taken, that reminder is
// skipped for the day rather than risking a duplicate. Reminders are
// courtesy mail; the gate does the real work.
//
// Day arithmetic is CALENDAR-BASED in Africa/Lagos, not 24-hour arithmetic,
// so "ends in 2 days" means what a principal reading it at noon thinks it
// means regardless of what time of day the subscription actually expires.

const prisma = require('../config/db');
const email = require('./email');
const { billingReminderEmail } = require('./email-templates/billing-reminder');

const DAY_MS = 24 * 60 * 60 * 1000;
const TZ = 'Africa/Lagos';

// Dev/seed schools carry a sentinel trial end far in the future (the 2126
// schools). They must never receive billing mail.
const DEV_YEAR_FLOOR = 2100;

// "YYYY-MM-DD" for a date, as seen in Lagos.
function lagosDateKey(d) {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
}

// Midnight-in-Lagos of the given date, expressed as a comparable number.
function lagosDayNumber(d) {
  const key = lagosDateKey(d);
  const parts = key.split('-');
  return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) / DAY_MS;
}

function planLabelOf(plan) {
  const p = String(plan || '');
  return p.charAt(0).toUpperCase() + p.slice(1);
}

function isDevSchool(sub) {
  return !!sub.trialEndsAt && new Date(sub.trialEndsAt).getUTCFullYear() >= DEV_YEAR_FLOOR;
}

/**
 * Which reminder (if any) does this subscription earn today?
 * Pure function - no I/O - so the harness can assert every boundary.
 *
 * @returns {{ kind: string, dateLabel: string } | null}
 */
function classify(sub, now) {
  const today = lagosDayNumber(now);

  if (sub.status === 'TRIAL') {
    if (!sub.trialEndsAt) return null;
    if (lagosDayNumber(sub.trialEndsAt) - today === 2) {
      return { kind: 'trial-ends-2d', dateLabel: lagosDateKey(sub.trialEndsAt) };
    }
    return null;
  }

  if (sub.status === 'ACTIVE' || sub.status === 'PAST_DUE') {
    if (!sub.endDate) return null;
    const diff = lagosDayNumber(sub.endDate) - today;
    if (diff === 2) return { kind: 'renewal-2d', dateLabel: lagosDateKey(sub.endDate) };
    if (diff === -1) return { kind: 'grace-1', dateLabel: lagosDateKey(sub.endDate) };
    if (diff === -2) return { kind: 'grace-2', dateLabel: lagosDateKey(sub.endDate) };
    if (diff === -3) return { kind: 'grace-3', dateLabel: lagosDateKey(sub.endDate) };
    return null;
  }

  // EXPIRED / CANCELLED: the school has already been told. No more mail.
  return null;
}

/**
 * Run one sweep.
 *
 * @param {Object} [opts]
 * @param {Date}   [opts.now]     - override "today" (harness only)
 * @param {boolean}[opts.dryRun]  - classify and report, take no locks, send nothing
 */
async function runSweep(opts) {
  const options = opts || {};
  const now = options.now ? new Date(options.now) : new Date();
  const dryRun = !!options.dryRun;
  const bucket = lagosDateKey(now);
  const billingUrl = (process.env.APP_URL || 'https://app.klassrun.com') + '/dashboard/billing';

  const summary = {
    bucket: bucket,
    dryRun: dryRun,
    scanned: 0,
    skippedDev: 0,
    skippedSuspended: 0,
    skippedNoEmail: 0,
    candidates: 0,
    sent: 0,
    alreadySent: 0,
    failed: 0,
    byKind: {},
  };

  const subs = await prisma.subscription.findMany({
    select: {
      schoolId: true,
      plan: true,
      status: true,
      endDate: true,
      trialEndsAt: true,
      school: { select: { name: true, contactEmail: true, status: true } },
    },
  });

  summary.scanned = subs.length;

  for (const sub of subs) {
    if (isDevSchool(sub)) { summary.skippedDev++; continue; }
    if (sub.school && sub.school.status === 'SUSPENDED') { summary.skippedSuspended++; continue; }

    const hit = classify(sub, now);
    if (!hit) continue;

    summary.candidates++;
    summary.byKind[hit.kind] = (summary.byKind[hit.kind] || 0) + 1;

    if (!sub.school || !sub.school.contactEmail) { summary.skippedNoEmail++; continue; }
    if (dryRun) continue;

    // Take the lock FIRST. Losing this insert means today's reminder of this
    // kind already went out for this school.
    try {
      await prisma.billingReminder.create({
        data: { schoolId: sub.schoolId, kind: hit.kind, dateBucket: bucket },
      });
    } catch (err) {
      if (err && err.code === 'P2002') { summary.alreadySent++; continue; }
      console.error('[billing/sweep] lock failed for', sub.schoolId, hit.kind, (err && err.message) || err);
      summary.failed++;
      continue;
    }

    const tpl = billingReminderEmail({
      kind: hit.kind,
      schoolName: sub.school.name,
      planLabel: planLabelOf(sub.plan),
      dateLabel: hit.dateLabel,
      billingUrl: billingUrl,
    });
    if (!tpl) { summary.failed++; continue; }

    try {
      const result = await email.send({ to: sub.school.contactEmail, subject: tpl.subject, html: tpl.html });
      if (result && result.error) { summary.failed++; continue; }
      summary.sent++;
    } catch (err) {
      console.error('[billing/sweep] send failed for', sub.schoolId, hit.kind, (err && err.message) || err);
      summary.failed++;
    }
  }

  console.log('[billing/sweep]', JSON.stringify(summary));
  return summary;
}

module.exports = { runSweep, classify, lagosDateKey, lagosDayNumber, isDevSchool };
