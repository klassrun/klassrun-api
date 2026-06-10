// src/middleware/auth.js
//
// JWT authentication + role authorization.
//
// perf-2-auth-cache: the per-request user lookup is cached in-memory for 60s.
// Revocation / suspension / lockout still take effect within the TTL window,
// and revokeTeacher calls invalidateUserCache() for immediate effect.
// NOTE: in-memory cache assumes a single instance. If we ever scale to
// multiple instances, swap this for Redis.

const jwt = require('jsonwebtoken');
const prisma = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set in environment');
}

// ── perf-2: tiny TTL cache ──────────────────────────────────────────────────
const USER_CACHE_TTL_MS = 60_000;
const USER_CACHE_MAX    = 5_000; // hard cap so it can't grow unbounded
const userCache = new Map();     // userId → { user, expires }

function getCachedUser(userId) {
  const hit = userCache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.user;
  if (hit) userCache.delete(userId);
  return null;
}

function setCachedUser(userId, user) {
  if (userCache.size >= USER_CACHE_MAX) {
    // Drop the oldest entry (Map preserves insertion order)
    const oldest = userCache.keys().next().value;
    if (oldest !== undefined) userCache.delete(oldest);
  }
  userCache.set(userId, { user, expires: Date.now() + USER_CACHE_TTL_MS });
}

/** Force a user's next request to hit the DB (e.g. after revocation). */
function invalidateUserCache(userId) {
  userCache.delete(userId);
}

/**
 * Extracts the JWT from either:
 *   1. Authorization: Bearer <token>  (preferred)
 *   2. cookie: klassrun_token=<token> (set by Vercel route handler)
 */
function extractToken(req) {
  const authHeader = req.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  const cookieHeader = req.get('cookie');
  if (cookieHeader) {
    const match = cookieHeader.match(/klassrun_token=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

const authenticate = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({
        error: { message: 'Not authenticated' },
      });
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({
        error: { message: 'Invalid or expired session' },
      });
    }

    // perf-2: serve from cache when fresh; otherwise load + cache.
    let user = getCachedUser(payload.userId);
    if (!user) {
      user = await prisma.user.findUnique({
        where: { id: payload.userId },
        include: {
          school: { select: { id: true, name: true, status: true } },
        },
      });
      if (user) setCachedUser(payload.userId, user);
    }

    if (!user) {
      return res.status(401).json({
        error: { message: 'Account not found' },
      });
    }

    // Soft-deleted by school admin
    if (user.revokedAt) {
      return res.status(403).json({
        error: { message: 'Your access has been revoked. Please contact your school administrator.' },
      });
    }

    // School suspended by super admin
    if (user.school?.status === 'SUSPENDED') {
      return res.status(403).json({
        error: { message: 'This school has been suspended. Please contact Klassrun support.' },
      });
    }

    // Account temporarily locked due to failed login attempts
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      return res.status(423).json({
        error: { message: 'Account is temporarily locked due to too many failed attempts. Try again later.' },
      });
    }

    req.user = {
      id:         user.id,
      email:      user.email,
      firstName:  user.firstName,
      lastName:   user.lastName,
      role:       user.role,
      schoolId:   user.schoolId,
      schoolName: user.school?.name,
    };

    next();
  } catch (err) {
    next(err);
  }
};

const authorize = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: { message: 'Not authenticated' } });
  }
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({
      error: { message: `Forbidden — requires role: ${allowedRoles.join(' or ')}` },
    });
  }
  next();
};

module.exports = { authenticate, authorize, invalidateUserCache };
