// src/lib/audit.js
//
// Tiny helper for writing AuthEvent rows. Use this instead of calling
// prisma.authEvent.create directly so we keep audit log shape consistent
// across the codebase.
//
// Audit logging should NEVER throw — if the DB write fails we just log
// to console. A failed audit shouldn't break the user-facing request.

const prisma = require('../config/db');

/**
 * Record an authentication event.
 *
 * @param {string}  type      — value from AuthEventType enum
 * @param {Object}  [opts]
 * @param {Object}  [opts.req]      — Express request (for IP + user-agent)
 * @param {string}  [opts.email]    — email address relevant to this event
 * @param {string}  [opts.userId]   — user id if known
 * @param {string}  [opts.schoolId] — school id if known
 * @param {Object}  [opts.metadata] — any extra context to remember later
 *
 * Returns the created event row, or null if logging failed.
 */
async function recordAuthEvent(type, opts = {}) {
  try {
    return await prisma.authEvent.create({
      data: {
        type,
        email:     opts.email ?? null,
        userId:    opts.userId ?? null,
        schoolId:  opts.schoolId ?? null,
        ipAddress: opts.req ? extractIp(opts.req) : null,
        userAgent: opts.req ? opts.req.get('user-agent') ?? null : null,
        metadata:  opts.metadata ?? null,
      },
    });
  } catch (err) {
    // Never let audit failures break callers. Just log loudly.
    console.error(`✗ Failed to record auth event (${type}):`, err.message);
    return null;
  }
}

function extractIp(req) {
  // Cloudflare / Railway both forward the real client IP via headers.
  // We trust them in the order most likely to be authoritative.
  return (
    req.get('cf-connecting-ip') ||           // Cloudflare
    req.get('x-real-ip') ||                  // common reverse proxies
    req.get('x-forwarded-for')?.split(',')[0]?.trim() || // standard
    req.ip ||
    null
  );
}


/**
 * Record an academic event (sessions, classes, subjects, etc.).
 *
 * Same fire-and-forget contract as recordAuthEvent: never throws.
 * No req-based IP capture — academic events are admin actions in-app,
 * the schoolId + actorId pair is enough provenance.
 *
 * batch-2c-phase-1-academic-audit
 *
 * @param {string} type      — value from AcademicEventType enum
 * @param {Object} [opts]
 * @param {string} [opts.schoolId]
 * @param {string} [opts.actorId]
 * @param {Object} [opts.metadata]
 */
async function recordAcademicEvent(type, opts = {}) {
  try {
    return await prisma.academicEvent.create({
      data: {
        type,
        schoolId: opts.schoolId ?? null,
        actorId:  opts.actorId ?? null,
        metadata: opts.metadata ?? null,
      },
    });
  } catch (err) {
    console.error(`✗ Failed to record academic event (${type}):`, err.message);
    return null;
  }
}

module.exports = { recordAuthEvent, recordAcademicEvent };