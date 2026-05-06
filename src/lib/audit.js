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

module.exports = { recordAuthEvent };
