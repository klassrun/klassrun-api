// src/middleware/auth.js
//
// JWT authentication + role authorization.
//
// authenticate: verifies the JWT, loads the user, blocks revoked accounts,
//   blocks suspended schools, and blocks locked-out accounts.
//
// authorize(...roles): restricts access to specific user roles. Use AFTER
//   authenticate.

const jwt = require('jsonwebtoken');
const prisma = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set in environment');
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
  // Fall back to cookie if forwarded by Vercel proxy
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

    // Load the user fresh from the DB so we always check current state
    // (revoked / locked / school suspended) on every request.
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: {
        school: { select: { id: true, name: true, status: true } },
      },
    });

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
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return res.status(423).json({
        error: { message: 'Account is temporarily locked due to too many failed attempts. Try again later.' },
      });
    }

    // Attach the user to the request for downstream handlers
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

/**
 * Restrict access to specific roles.
 *
 * @example
 *   router.post('/invite', authenticate, authorize('SCHOOL_ADMIN'), handler);
 *   router.get('/admin/schools', authenticate, authorize('SUPER_ADMIN'), handler);
 */
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

module.exports = { authenticate, authorize };
