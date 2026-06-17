// src/modules/portal/portal-auth.middleware.js
// ops-5-portal-auth-middleware
//
// authenticatePortal — verifies a portal JWT, loads the Student, and (when the
// school opts in) enforces the fee login-block on EVERY request, so toggling
// the flag or marking a fee takes effect immediately.

const prisma = require('../../config/db');
const { verifyPortalToken } = require('./portal-token');

function extractToken(req) {
  const h = req.get('authorization');
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  const c = req.get('cookie');
  if (c) {
    const m = c.match(/klassrun_portal=([^;]+)/);
    if (m) return m[1];
  }
  return null;
}

// True when the student has NOT paid for the current session+term.
async function isFeeBlocked(schoolId, studentId) {
  const current = await prisma.academicSession.findFirst({
    where: { schoolId, isCurrent: true },
    select: { id: true, currentTerm: true },
  });
  if (!current) return false; // no current session → never lock people out
  const rec = await prisma.feeRecord.findFirst({
    where: { schoolId, studentId, sessionId: current.id, term: current.currentTerm },
    select: { status: true },
  });
  return !(rec && rec.status === 'PAID');
}

const authenticatePortal = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: { message: 'Not authenticated' } });

    let payload;
    try {
      payload = verifyPortalToken(token);
    } catch {
      return res.status(401).json({ error: { message: 'Invalid or expired session' } });
    }

    const student = await prisma.student.findFirst({
      where: { id: payload.sub, schoolId: payload.schoolId },
      include: {
        school: { select: { id: true, name: true, slug: true, status: true, portalFeeBlockEnabled: true } },
        class: { select: { id: true, name: true } },
      },
    });
    if (!student) return res.status(401).json({ error: { message: 'Account not found' } });
    if (student.archivedAt) {
      return res.status(403).json({ error: { message: 'This portal account is no longer active. Contact your school.' } });
    }
    if (student.school && student.school.status === 'SUSPENDED') {
      return res.status(403).json({ error: { message: 'This school has been suspended. Contact Klassrun support.' } });
    }

    if (student.school && student.school.portalFeeBlockEnabled) {
      if (await isFeeBlocked(student.schoolId, student.id)) {
        return res.status(403).json({ error: { message: 'Outstanding fees. Please contact the school bursary.' }, code: 'FEE_BLOCK' });
      }
    }

    req.portalStudent = {
      id: student.id,
      schoolId: student.schoolId,
      admissionNumber: student.admissionNumber,
      firstName: student.firstName,
      lastName: student.lastName,
      className: student.class ? student.class.name : null,
      school: student.school,
    };
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { authenticatePortal, isFeeBlocked };
