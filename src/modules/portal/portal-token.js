// src/modules/portal/portal-token.js
// ops-5-portal-token
//
// Portal JWTs are SEPARATE from staff JWTs. They carry a `kind:'portal'` claim
// and a `sub` (studentId). Staff tokens (which carry userId/role and no kind)
// will fail verifyPortalToken, and a portal token has no userId so it cannot
// pass the staff authenticate middleware. The two worlds never cross.

const jwt = require('jsonwebtoken');

const PORTAL_EXPIRES_IN =
  process.env.PORTAL_JWT_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '7d';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set in environment');
  return s;
}

function signPortalToken(studentId, schoolId) {
  return jwt.sign(
    { sub: studentId, schoolId, kind: 'portal' },
    secret(),
    { expiresIn: PORTAL_EXPIRES_IN },
  );
}

function verifyPortalToken(token) {
  const payload = jwt.verify(token, secret());
  if (!payload || payload.kind !== 'portal') {
    const e = new Error('Not a portal token');
    e.code = 'NOT_PORTAL';
    throw e;
  }
  return payload;
}

module.exports = { signPortalToken, verifyPortalToken };
