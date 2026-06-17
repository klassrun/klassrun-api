// src/modules/promotions/promotion.routes.js
// ops-3-promotion-routes
//
// Operations 3 — Promotion. Mounted at /api/promotions. SCHOOL_ADMIN only.
// MOLEK blueprint, rebuilt natively + multi-tenant. No AI cost → NOT
// billing-gated. Class names are free-form: the admin picks the target class
// explicitly (no JSS1→JSS2 inference). Promotion only changes Student.classId;
// alumni/graduation is deferred (archive the student in the meantime).
//
//   GET  /api/promotions/eligibility?classId=&sessionId=&term=&threshold=
//        roster + per-term averages + cumulative + a PROMOTE/RETAIN suggestion
//   POST /api/promotions/execute
//        bulk promote/retain in ONE transaction; writes a PromotionRecord per
//        student (history + reversibility); PROMOTE moves classId.
//   GET  /api/promotions?sessionId=&classId=
//        promotion history (most recent first)
//   POST /api/promotions/:id/reverse
//        reverse one record; restores classId if it was a PROMOTED move and the
//        student is still sitting in the target class.

const router = require('express').Router();
const { requirePlan, requireActiveForWrites } = require('../../lib/plan-gate'); // gate-1-require
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');
const resultsAggregate = require('../../lib/results-aggregate');

const TERMS = ['FIRST', 'SECOND', 'THIRD'];
function normTerm(value) {
  const t = String(value || '').toUpperCase();
  return TERMS.includes(t) ? t : null;
}

const DEFAULT_THRESHOLD = 50;
function parseThreshold(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_THRESHOLD;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

function studentBrief(s) {
  return {
    id: s.id,
    admissionNumber: s.admissionNumber,
    firstName: s.firstName,
    middleName: s.middleName || null,
    lastName: s.lastName,
  };
}

async function resolveClass(req, classId, field) {
  if (typeof classId !== 'string' || classId.trim() === '') {
    return { ok: false, status: 400, message: `${field} is required`, field };
  }
  const cls = await prisma.class.findFirst({
    where: { id: classId, schoolId: req.user.schoolId },
    select: { id: true, name: true, archivedAt: true },
  });
  if (!cls) return { ok: false, status: 404, message: 'Class not found', field };
  return { ok: true, cls };
}

async function resolveSession(req, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { ok: false, status: 400, message: 'sessionId is required', field: 'sessionId' };
  }
  const session = await prisma.academicSession.findFirst({
    where: { id: sessionId, schoolId: req.user.schoolId },
    select: { id: true, name: true },
  });
  if (!session) return { ok: false, status: 404, message: 'Session not found', field: 'sessionId' };
  return { ok: true, session };
}

// ── GET /eligibility ────────────────────────────────────────────────────────
router.get('/eligibility', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const term = normTerm(req.query.term);
    if (!term) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });

    const threshold = parseThreshold(req.query.threshold);
    if (threshold === null) {
      return res.status(400).json({ error: { message: 'threshold must be a number between 0 and 100', field: 'threshold' } });
    }

    const clsRes = await resolveClass(req, req.query.classId, 'classId');
    if (!clsRes.ok) return res.status(clsRes.status).json({ error: { message: clsRes.message, field: clsRes.field } });

    const sessRes = await resolveSession(req, req.query.sessionId);
    if (!sessRes.ok) return res.status(sessRes.status).json({ error: { message: sessRes.message, field: sessRes.field } });

    const students = await prisma.student.findMany({
      where: { schoolId: req.user.schoolId, classId: clsRes.cls.id, archivedAt: null },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, admissionNumber: true, firstName: true, middleName: true, lastName: true },
    });
    const studentIds = students.map((s) => s.id);

    const cumTerms = resultsAggregate.termsUpTo(term);
    const entries = studentIds.length === 0 ? [] : await prisma.resultEntry.findMany({
      where: {
        schoolId: req.user.schoolId,
        sessionId: sessRes.session.id,
        term: { in: cumTerms },
        studentId: { in: studentIds },
      },
      select: { studentId: true, term: true, total: true },
    });
    const byStudent = {};
    for (const e of entries) {
      (byStudent[e.studentId] = byStudent[e.studentId] || []).push(e);
    }

    // Existing non-reversed promotion records for this session block re-promotion.
    const existing = studentIds.length === 0 ? [] : await prisma.promotionRecord.findMany({
      where: {
        schoolId: req.user.schoolId,
        sessionId: sessRes.session.id,
        reversedAt: null,
        studentId: { in: studentIds },
      },
      select: { id: true, studentId: true, decision: true },
    });
    const existingByStudent = {};
    existing.forEach((p) => { existingByStudent[p.studentId] = p; });

    const rows = students.map((s) => {
      const termAverages = resultsAggregate.perTermAverages(byStudent[s.id] || []);
      const cumulative = resultsAggregate.cumulativeAverage(termAverages);
      const subjectsCount = termAverages.reduce((a, t) => a + t.subjectsCount, 0);
      let suggestion = 'NO_RESULTS';
      if (cumulative !== null) suggestion = cumulative >= threshold ? 'PROMOTE' : 'RETAIN';
      const ex = existingByStudent[s.id] || null;
      return {
        student: studentBrief(s),
        termAverages,
        cumulative,
        subjectsCount,
        suggestion,
        alreadyPromoted: !!ex,
        existingRecordId: ex ? ex.id : null,
      };
    });

    res.json({
      class: { id: clsRes.cls.id, name: clsRes.cls.name },
      session: sessRes.session,
      term,
      threshold,
      rows,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /execute ─────────────────────────────────────────────────────────────
router.post('/execute', authenticate, authorize('SCHOOL_ADMIN'), requireActiveForWrites, requirePlan('PROMOTION'), /* gate-1-promo-execute */ async (req, res, next) => {
  try {
    const body = req.body || {};
    const term = normTerm(body.term);
    if (!term) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });

    const threshold = parseThreshold(body.threshold);
    if (threshold === null) {
      return res.status(400).json({ error: { message: 'threshold must be a number between 0 and 100', field: 'threshold' } });
    }

    const srcRes = await resolveClass(req, body.sourceClassId, 'sourceClassId');
    if (!srcRes.ok) return res.status(srcRes.status).json({ error: { message: srcRes.message, field: srcRes.field } });
    if (srcRes.cls.archivedAt) {
      return res.status(400).json({ error: { message: 'Source class is archived', field: 'sourceClassId' } });
    }

    const tgtRes = await resolveClass(req, body.targetClassId, 'targetClassId');
    if (!tgtRes.ok) return res.status(tgtRes.status).json({ error: { message: tgtRes.message, field: tgtRes.field } });
    if (tgtRes.cls.archivedAt) {
      return res.status(400).json({ error: { message: 'Target class is archived', field: 'targetClassId' } });
    }
    if (tgtRes.cls.id === srcRes.cls.id) {
      return res.status(400).json({ error: { message: 'Target class must differ from source class', field: 'targetClassId' } });
    }

    const sessRes = await resolveSession(req, body.sessionId);
    if (!sessRes.ok) return res.status(sessRes.status).json({ error: { message: sessRes.message, field: sessRes.field } });

    if (!Array.isArray(body.decisions) || body.decisions.length === 0) {
      return res.status(400).json({ error: { message: 'decisions must be a non-empty array', field: 'decisions' } });
    }

    // Normalise + validate decisions up front (no partial work).
    const norm = [];
    for (const d of body.decisions) {
      if (!d || typeof d.studentId !== 'string' || d.studentId.trim() === '') {
        return res.status(400).json({ error: { message: 'each decision needs a studentId', field: 'decisions' } });
      }
      const verb = String(d.decision || '').toUpperCase();
      if (verb !== 'PROMOTE' && verb !== 'RETAIN') {
        return res.status(400).json({ error: { message: 'decision must be PROMOTE or RETAIN', field: 'decisions' } });
      }
      norm.push({ studentId: d.studentId, verb });
    }
    const requestedIds = norm.map((d) => d.studentId);

    // Only active students currently in the source class are eligible.
    const students = await prisma.student.findMany({
      where: { schoolId: req.user.schoolId, classId: srcRes.cls.id, archivedAt: null, id: { in: requestedIds } },
      select: { id: true, classId: true },
    });
    const studentById = {};
    students.forEach((s) => { studentById[s.id] = s; });
    const eligibleIds = students.map((s) => s.id);

    // Cumulative for record-keeping (same helper as eligibility + report cards).
    const cumTerms = resultsAggregate.termsUpTo(term);
    const entries = eligibleIds.length === 0 ? [] : await prisma.resultEntry.findMany({
      where: {
        schoolId: req.user.schoolId,
        sessionId: sessRes.session.id,
        term: { in: cumTerms },
        studentId: { in: eligibleIds },
      },
      select: { studentId: true, term: true, total: true },
    });
    const cumEntriesByStudent = {};
    for (const e of entries) {
      (cumEntriesByStudent[e.studentId] = cumEntriesByStudent[e.studentId] || []).push(e);
    }

    // Existing non-reversed records for this session → skip (idempotent re-run).
    const existing = eligibleIds.length === 0 ? [] : await prisma.promotionRecord.findMany({
      where: { schoolId: req.user.schoolId, sessionId: sessRes.session.id, reversedAt: null, studentId: { in: eligibleIds } },
      select: { studentId: true },
    });
    const alreadyDone = new Set(existing.map((p) => p.studentId));

    const toProcess = norm.filter((d) => studentById[d.studentId] && !alreadyDone.has(d.studentId));
    const skipped = norm.length - toProcess.length;

    if (toProcess.length === 0) {
      return res.json({
        executed: { promoted: 0, retained: 0, skipped },
        records: [],
        sourceClassId: srcRes.cls.id,
        targetClassId: tgtRes.cls.id,
        sessionId: sessRes.session.id,
        term,
      });
    }

    const created = await prisma.$transaction(async (tx) => {
      const out = [];
      for (const d of toProcess) {
        const cumulative = resultsAggregate.cumulativeAverage(
          resultsAggregate.perTermAverages(cumEntriesByStudent[d.studentId] || []),
        );
        const isPromote = d.verb === 'PROMOTE';
        if (isPromote) {
          await tx.student.update({ where: { id: d.studentId }, data: { classId: tgtRes.cls.id } });
        }
        const rec = await tx.promotionRecord.create({
          data: {
            decision: isPromote ? 'PROMOTED' : 'RETAINED',
            cumulative,
            threshold,
            uptoTerm: term,
            schoolId: req.user.schoolId,
            studentId: d.studentId,
            sessionId: sessRes.session.id,
            fromClassId: srcRes.cls.id,
            toClassId: isPromote ? tgtRes.cls.id : null,
            decidedById: req.user.id,
          },
          select: { id: true, studentId: true, decision: true, toClassId: true, cumulative: true },
        });
        out.push(rec);
      }
      return out;
    });

    const promoted = created.filter((r) => r.decision === 'PROMOTED').length;
    const retained = created.filter((r) => r.decision === 'RETAINED').length;

    recordAcademicEvent('PROMOTION_EXECUTED', {
      schoolId: req.user.schoolId,
      actorId: req.user.id,
      metadata: {
        sessionId: sessRes.session.id,
        fromClassId: srcRes.cls.id,
        toClassId: tgtRes.cls.id,
        term,
        threshold,
        promoted,
        retained,
        skipped,
      },
    });

    res.json({
      executed: { promoted, retained, skipped },
      records: created,
      sourceClassId: srcRes.cls.id,
      targetClassId: tgtRes.cls.id,
      sessionId: sessRes.session.id,
      term,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET / (history) ───────────────────────────────────────────────────────────
router.get('/', authenticate, authorize('SCHOOL_ADMIN'), async (req, res, next) => {
  try {
    const where = { schoolId: req.user.schoolId };
    if (req.query.sessionId) where.sessionId = String(req.query.sessionId);
    if (req.query.classId) where.fromClassId = String(req.query.classId);

    const records = await prisma.promotionRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        student: { select: { id: true, admissionNumber: true, firstName: true, middleName: true, lastName: true } },
        fromClass: { select: { id: true, name: true } },
        toClass: { select: { id: true, name: true } },
        session: { select: { id: true, name: true } },
      },
    });

    res.json({
      promotions: records.map((r) => ({
        id: r.id,
        decision: r.decision,
        cumulative: r.cumulative,
        threshold: r.threshold,
        uptoTerm: r.uptoTerm,
        student: r.student,
        fromClass: r.fromClass,
        toClass: r.toClass || null,
        session: r.session,
        reversedAt: r.reversedAt,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/reverse ───────────────────────────────────────────────────────
router.post('/:id/reverse', authenticate, authorize('SCHOOL_ADMIN'), requireActiveForWrites, requirePlan('PROMOTION'), /* gate-1-promo-reverse */ async (req, res, next) => {
  try {
    const { id } = req.params;
    const rec = await prisma.promotionRecord.findFirst({
      where: { id, schoolId: req.user.schoolId },
      select: { id: true, decision: true, studentId: true, fromClassId: true, toClassId: true, reversedAt: true },
    });
    if (!rec) return res.status(404).json({ error: { message: 'Promotion record not found' } });
    if (rec.reversedAt) {
      return res.json({ promotion: { id: rec.id, reversedAt: rec.reversedAt, studentId: rec.studentId, restoredClassId: null } });
    }

    let restoredClassId = null;
    await prisma.$transaction(async (tx) => {
      // Only move the student back if this was a PROMOTED move AND the student
      // is still sitting in the target class (don't clobber a later manual move).
      if (rec.decision === 'PROMOTED' && rec.toClassId) {
        const student = await tx.student.findFirst({
          where: { id: rec.studentId, schoolId: req.user.schoolId },
          select: { id: true, classId: true },
        });
        if (student && student.classId === rec.toClassId) {
          await tx.student.update({ where: { id: rec.studentId }, data: { classId: rec.fromClassId } });
          restoredClassId = rec.fromClassId;
        }
      }
      await tx.promotionRecord.update({
        where: { id: rec.id },
        data: { reversedAt: new Date(), reversedById: req.user.id },
      });
    });

    recordAcademicEvent('PROMOTION_REVERSED', {
      schoolId: req.user.schoolId,
      actorId: req.user.id,
      metadata: { promotionRecordId: rec.id, studentId: rec.studentId, restoredClassId },
    });

    res.json({ promotion: { id: rec.id, reversedAt: new Date(), studentId: rec.studentId, restoredClassId } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
