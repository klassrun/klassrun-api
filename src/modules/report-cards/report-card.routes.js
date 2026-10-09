// src/modules/report-cards/report-card.routes.js
// ops-1-report-card-routes
//
// Operations 1 — Report cards. Mounted at /api/report-cards.
//   POST /api/report-cards/generate     compute positions across a class + persist
//                                        one ReportCard per student (SCHOOL_ADMIN)
//   GET  /api/report-cards?classId=&sessionId=&term=   list (any auth)
//   GET  /api/report-cards/:id          one (snapshot) (any auth)
//   POST /api/report-cards/:id/pdf      pdfkit render → Cloudinary → set pdfUrl (SCHOOL_ADMIN)
//   POST /api/report-cards/:id/lock     freeze the card (SCHOOL_ADMIN)
//
// Persist-before-respond. Attendance + behavioural + comments render as
// structured "—" placeholders (data populated in Ops 2).

const router = require('express').Router();
const { requirePlan, requireActiveForWrites } = require('../../lib/plan-gate'); // gate-1-require
const { authenticate, authorize } = require('../../middleware/auth');
const prisma = require('../../config/db');
const { recordAcademicEvent } = require('../../lib/audit');
const grading = require('../../lib/grading');
const gradingConfig = require('../../lib/grading-config'); // grading-config-v1
const resultsAggregate = require('../../lib/results-aggregate'); // ops-3-cumulative-fold
const nextTerm = require('../../lib/next-term'); // rc-next-term-v1
const cloudinaryLib = require('../../lib/cloudinary');
const { renderReportCardPdf, BEHAVIOUR_ATTRS } = require('../../lib/pdf/report-card-pdf');
const { drawReportCardPage, loadLogo } = require('../../lib/pdf/report-card-pdf'); // rc-class-pdf-v1
const PDFDocument = require('pdfkit'); // rc-class-pdf-v1

const TERMS = ['FIRST', 'SECOND', 'THIRD'];
function normTerm(value) {
  const t = String(value || '').toUpperCase();
  return TERMS.includes(t) ? t : null;
}

function fullName(s) {
  return [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
}

// Standard competition ranking ("1,2,2,4") over a list of { id, value },
// higher value = better position. Returns map id → position (1-based).
// Items with value <= 0 still get ranked (last) so every student has a position.
function rankByDesc(items) {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const pos = {};
  let rank = 0;
  let seen = 0;
  let prev = null;
  for (const it of sorted) {
    seen += 1;
    if (prev === null || it.value !== prev) {
      rank = seen;
      prev = it.value;
    }
    pos[it.id] = rank;
  }
  return pos;
}

const EMPTY_BEHAVIOUR = BEHAVIOUR_ATTRS.map((attribute) => ({ attribute, score: null }));

// ops-2-generate-fold helpers — turn stored records into snapshot sections.
function behaviourFromRecord(rec) {
  if (!rec || !rec.ratings || typeof rec.ratings !== 'object') return EMPTY_BEHAVIOUR;
  return BEHAVIOUR_ATTRS.map((attribute) => {
    const v = rec.ratings[attribute];
    const score = Number.isInteger(v) && v >= 1 && v <= 5 ? v : null;
    return { attribute, score };
  });
}
function attendanceFromRecord(rec) {
  if (!rec) return { schoolOpened: null, present: null, absent: null };
  return { schoolOpened: rec.schoolOpened, present: rec.present, absent: rec.absent };
}
function commentsFromRecord(rec) {
  if (!rec) return { classTeacher: null, principal: null };
  return { classTeacher: rec.classTeacher || null, principal: rec.principal || null };
}

// rc-card-refresh-v1: does a freshly built snapshot say the same thing as the saved one?
// generatedAt is ignored (it always differs), undefined is dropped (JSON drops it too), and
// object keys are sorted — Postgres jsonb reorders keys, so raw JSON text would never match.
function rcCanon(v) {
  if (Array.isArray(v)) return v.map(rcCanon);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) if (k !== 'generatedAt' && v[k] !== undefined) out[k] = rcCanon(v[k]);
    return out;
  }
  return v;
}
function rcSameSnapshot(saved, fresh) {
  if (!saved || !fresh) return false;
  return JSON.stringify(rcCanon(saved)) === JSON.stringify(rcCanon(fresh));
}

// ── POST /generate ──────────────────────────────────────────────────────────
router.post('/generate', authenticate, authorize('SCHOOL_ADMIN'), requireActiveForWrites, requirePlan('RESULTS_REPORTCARDS'), /* gate-1-rc-gen */ async (req, res, next) => {
  try {
    const body = req.body || {};
    const term = normTerm(body.term);
    if (!term) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });

    if (typeof body.classId !== 'string' || body.classId.trim() === '') {
      return res.status(400).json({ error: { message: 'classId is required', field: 'classId' } });
    }
    const cls = await prisma.class.findFirst({
      where: { id: body.classId, schoolId: req.user.schoolId },
      select: { id: true, name: true },
    });
    if (!cls) return res.status(404).json({ error: { message: 'Class not found', field: 'classId' } });

    if (typeof body.sessionId !== 'string' || body.sessionId.trim() === '') {
      return res.status(400).json({ error: { message: 'sessionId is required', field: 'sessionId' } });
    }
    const session = await prisma.academicSession.findFirst({
      where: { id: body.sessionId, schoolId: req.user.schoolId },
      select: { id: true, name: true, nextTermBeginsByTerm: true }, // rc-next-term-v1
    });
    if (!session) return res.status(404).json({ error: { message: 'Session not found', field: 'sessionId' } });

    // b4-rc-enrollment-cohort: cohort is the (session,class) Enrollment set, not the
    // Student.classId cache. Ranking pool, classSize and the "of N" denominator must
    // reflect who was enrolled in THIS class for THIS session, or regenerating a past
    // term after a promotion ranks students against their current classmates (MOLEK
    // class-position bug). §2 normative: class = (student, session) pair.
    const enrolled = await prisma.enrollment.findMany({
      where: { schoolId: req.user.schoolId, sessionId: session.id, classId: cls.id },
      select: { studentId: true },
    });
    const enrolledIds = enrolled.map((e) => e.studentId);
    const students = enrolledIds.length === 0 ? [] : await prisma.student.findMany({
      where: { schoolId: req.user.schoolId, id: { in: enrolledIds }, archivedAt: null },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    if (students.length === 0) {
      return res.status(400).json({ error: { message: 'No students were enrolled in this class for this session' } });
    }
    const studentIds = students.map((s) => s.id);

    const subjects = await prisma.subject.findMany({
      where: { schoolId: req.user.schoolId, classId: cls.id, archivedAt: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const subjectName = {};
    subjects.forEach((s) => { subjectName[s.id] = s.name; });

    const entries = await prisma.resultEntry.findMany({
      where: { schoolId: req.user.schoolId, sessionId: session.id, term, studentId: { in: studentIds } },
    });

    // Group entries by student and by subject (for subject-position ranking).
    const byStudent = {};
    const perSubject = {}; // subjectId → [{ id: studentId, value: total }]
    for (const e of entries) {
      (byStudent[e.studentId] = byStudent[e.studentId] || []).push(e);
      (perSubject[e.subjectId] = perSubject[e.subjectId] || []).push({ id: e.studentId, value: e.total });
    }
    const subjectPos = {}; // subjectId → (studentId → position)
    Object.keys(perSubject).forEach((sid) => { subjectPos[sid] = rankByDesc(perSubject[sid]); });

    // Per-student aggregate + average for overall ranking.
    const aggregates = students.map((s) => {
      const es = byStudent[s.id] || [];
      const aggregate = es.reduce((sum, e) => sum + e.total, 0);
      const count = es.length;
      const average = count > 0 ? Math.round((aggregate / count) * 100) / 100 : 0;
      return { id: s.id, aggregate, count, average };
    });
    const overallPos = rankByDesc(aggregates.map((a) => ({ id: a.id, value: a.average })));
    const aggById = {};
    aggregates.forEach((a) => { aggById[a.id] = a; });

    // ops-2-generate-fold: pull attendance / behaviour / comments for this class+session+term
    const [attendanceRecords, behaviourRecords, commentRecords] = await Promise.all([
      prisma.attendanceRecord.findMany({ where: { schoolId: req.user.schoolId, sessionId: session.id, term, studentId: { in: studentIds } } }),
      prisma.behaviourRecord.findMany({ where: { schoolId: req.user.schoolId, sessionId: session.id, term, studentId: { in: studentIds } } }),
      prisma.reportCardComment.findMany({ where: { schoolId: req.user.schoolId, sessionId: session.id, term, studentId: { in: studentIds } } }),
    ]);
    const attById = {}; attendanceRecords.forEach((a) => { attById[a.studentId] = a; });
    const behById = {}; behaviourRecords.forEach((b) => { behById[b.studentId] = b; });
    const comById = {}; commentRecords.forEach((c) => { comById[c.studentId] = c; });

    // ops-3-cumulative-fold: cumulative average across the session's terms up to (and incl.) this one
    const cumTerms = resultsAggregate.termsUpTo(term);
    const cumEntries = await prisma.resultEntry.findMany({
      where: { schoolId: req.user.schoolId, sessionId: session.id, term: { in: cumTerms }, studentId: { in: studentIds } },
      select: { studentId: true, term: true, total: true },
    });
    const cumEntriesByStudent = {};
    for (const ce of cumEntries) {
      (cumEntriesByStudent[ce.studentId] = cumEntriesByStudent[ce.studentId] || []).push(ce);
    }
    const cumById = {};
    students.forEach((s) => {
      cumById[s.id] = resultsAggregate.cumulativeAverage(resultsAggregate.perTermAverages(cumEntriesByStudent[s.id] || []));
    });

    // grading-config-v1: the breakdown this term uses, recorded on every card
    const termGrading = await gradingConfig.componentsForTerm(req.user.schoolId, session.id, term);
    // grading-config-apply-v1: no cards while any score in this class+term does not fit the breakdown
    const misfits = entries.filter((e) => gradingConfig.misfit(e, termGrading.components));
    if (misfits.length > 0) {
      const nameById = {};
      students.forEach((s) => { nameById[s.id] = `${s.lastName} ${s.firstName}`; });
      const list = misfits.slice(0, 5).map((e) => `${nameById[e.studentId] || 'A student'} (${subjectName[e.subjectId] || 'a subject'})`).join(', ');
      return res.status(409).json({ error: {
        message: `${misfits.length} score${misfits.length === 1 ? ' does' : 's do'} not fit the current score breakdown: ${list}${misfits.length > 5 ? ', and more' : ''}. Fix ${misfits.length === 1 ? 'it' : 'them'} in Results, then generate again.`,
        code: 'SCORES_NEED_REVIEW',
      } });
    }
    const classSize = students.length;
    const generatedAt = new Date();

    // perf-6: prefetch existing cards in ONE query (was 1 findUnique per student)
    const existingCards = await prisma.reportCard.findMany({
      where: { schoolId: req.user.schoolId, sessionId: session.id, term, studentId: { in: studentIds } },
      select: { id: true, studentId: true, term: true, pdfUrl: true, lockedAt: true, snapshot: true },
    });
    const existingByStudent = {};
    existingCards.forEach((c) => { existingByStudent[c.studentId] = c; });

    // Build + persist one ReportCard per student (persist-before-respond).
    const saved = [];
    const upsertOps = []; // perf-6: batched in one transaction after the loop
    for (const s of students) {
      const es = (byStudent[s.id] || []).slice().sort((a, b) =>
        (subjectName[a.subjectId] || '').localeCompare(subjectName[b.subjectId] || ''));

      const subjectRows = es.map((e) => {
        const { grade, remark } = grading.gradeFor(e.total);
        return {
          subjectId: e.subjectId,
          name: subjectName[e.subjectId] || 'Subject',
          ca1: e.ca1, ca2: e.ca2, objective: e.objective, theory: e.theory, score5: e.score5, score6: e.score6, // grading-config-v1
          total: e.total,
          grade,
          remark,
          subjectPosition: (subjectPos[e.subjectId] && subjectPos[e.subjectId][s.id]) || null,
        };
      });

      const agg = aggById[s.id];
      const snapshot = {
        generatedAt: generatedAt.toISOString(),
        student: {
          id: s.id,
          admissionNumber: s.admissionNumber,
          fullName: fullName(s),
          firstName: s.firstName,
          middleName: s.middleName || null,
          lastName: s.lastName,
          photoUrl: s.photoUrl || null,
          class: cls.name,
        },
        session: session.name,
        grading: { components: termGrading.components }, // grading-config-v1
        term,
        subjects: subjectRows,
        summary: {
          subjectsCount: agg.count,
          aggregate: agg.aggregate,
          average: agg.average,
          overallPosition: overallPos[s.id] || null,
          classSize,
          cumulativeAverage: cumById[s.id] ?? null, // ops-3-cumulative-fold
        },
        attendance: attendanceFromRecord(attById[s.id]), // ops-2-generate-fold
        behaviour: behaviourFromRecord(behById[s.id]),    // ops-2-generate-fold
        comments: commentsFromRecord(comById[s.id]),      // ops-2-generate-fold
        resumptionDate: nextTerm.labelFor(session.nextTermBeginsByTerm, term), // rc-next-term-v1
      };

      // ops-2-generate-fold: never overwrite a finalized (locked) card
      const existingCard = existingByStudent[s.id]; // perf-6: map lookup, no query
      if (existingCard && existingCard.lockedAt) {
        saved.push(existingCard);
        continue;
      }
      // rc-card-refresh-v1: nothing on this card changed → leave it as it is, so its saved
      // PDF survives. Re-generating a class only rewrites (and un-PDFs) cards that differ.
      if (existingCard && rcSameSnapshot(existingCard.snapshot, snapshot)) {
        saved.push(existingCard);
        continue;
      }
      upsertOps.push(prisma.reportCard.upsert({
        where: {
          studentId_sessionId_term: { studentId: s.id, sessionId: session.id, term },
        },
        create: {
          schoolId: req.user.schoolId,
          studentId: s.id,
          sessionId: session.id,
          term,
          snapshot,
          generatedById: req.user.id,
        },
        update: {
          snapshot,
          generatedById: req.user.id,
          pdfUrl: null, // rc-pdf-stale-v1: the old PDF shows the old snapshot
          // regenerating clears any stale PDF; locked cards are protected below
        },
        select: {
          id: true, studentId: true, term: true, pdfUrl: true, lockedAt: true, snapshot: true,
        },
      }));
    }

    // perf-6: one transaction instead of N sequential upserts
    if (upsertOps.length > 0) {
      const upserted = await prisma.$transaction(upsertOps);
      saved.push(...upserted);
    }

    recordAcademicEvent('REPORT_CARD_GENERATED', {
      schoolId: req.user.schoolId,
      actorId: req.user.id,
      metadata: { classId: cls.id, sessionId: session.id, term, count: saved.length },
    });

    res.json({
      reportCards: saved.map((c) => ({
        id: c.id,
        studentId: c.studentId,
        term: c.term,
        pdfUrl: c.pdfUrl,
        lockedAt: c.lockedAt,
        summary: c.snapshot && c.snapshot.summary,
      })),
      classId: cls.id,
      sessionId: session.id,
      term,
      count: saved.length,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET / (list) ────────────────────────────────────────────────────────────
router.get('/', authenticate, authorize('SCHOOL_ADMIN'), /* audit-reportcard-read-role-v1 */ async (req, res, next) => {
  try {
    const where = { schoolId: req.user.schoolId };
    if (req.query.sessionId) where.sessionId = String(req.query.sessionId);
    const term = req.query.term ? normTerm(req.query.term) : null;
    if (req.query.term && !term) {
      return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });
    }
    if (term) where.term = term;

    // b4-rc-enrollment-list: when a session is specified, resolve class membership
    // through Enrollment (who was in this class THAT session), not the Student.classId
    // cache. classId alone keeps the current-"now" list, which §2.1 sanctions.
    let studentFilter = null;
    if (req.query.classId) {
      const classId = String(req.query.classId);
      let idList;
      if (req.query.sessionId) {
        const enr = await prisma.enrollment.findMany({
          where: { schoolId: req.user.schoolId, sessionId: String(req.query.sessionId), classId },
          select: { studentId: true },
        });
        idList = enr.map((e) => e.studentId);
      } else {
        const studs = await prisma.student.findMany({
          where: { schoolId: req.user.schoolId, classId },
          select: { id: true },
        });
        idList = studs.map((s) => s.id);
      }
      studentFilter = idList;
      where.studentId = { in: studentFilter };
    }

    const cards = await prisma.reportCard.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        student: { select: { id: true, admissionNumber: true, firstName: true, middleName: true, lastName: true } },
        session: { select: { id: true, name: true } },
      },
    });

    res.json({
      reportCards: cards.map((c) => ({
        id: c.id,
        student: c.student,
        session: c.session,
        term: c.term,
        pdfUrl: c.pdfUrl,
        lockedAt: c.lockedAt,
        summary: c.snapshot && c.snapshot.summary,
        createdAt: c.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /class-pdf ──────────────────────────────────────────────────────────
// rc-class-pdf-v1: every report card for one class + session + term in ONE PDF,
// one A4 page per student, alphabetical — open it and send it to the printer.
// Rendered on demand from the saved snapshots; nothing is uploaded or stored.
// A read, so a school in read-only mode can still print what it already has.
// MUST stay above GET /:id, or Express reads "class-pdf" as a report-card id.
const RC_TERM_WORD = { FIRST: 'First', SECOND: 'Second', THIRD: 'Third' }; // rc-class-pdf-v1
router.get('/class-pdf', authenticate, authorize('SCHOOL_ADMIN'), /* rc-class-pdf-v1 */ async (req, res, next) => {
  try {
    const term = normTerm(req.query.term);
    if (!term) return res.status(400).json({ error: { message: 'term must be FIRST, SECOND or THIRD', field: 'term' } });
    const classId = typeof req.query.classId === 'string' ? req.query.classId.trim() : '';
    if (!classId) return res.status(400).json({ error: { message: 'classId is required', field: 'classId' } });
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : '';
    if (!sessionId) return res.status(400).json({ error: { message: 'sessionId is required', field: 'sessionId' } });

    const [cls, session, school] = await Promise.all([
      prisma.class.findFirst({ where: { id: classId, schoolId: req.user.schoolId }, select: { id: true, name: true } }),
      prisma.academicSession.findFirst({ where: { id: sessionId, schoolId: req.user.schoolId }, select: { id: true, name: true } }),
      prisma.school.findFirst({ where: { id: req.user.schoolId }, select: { name: true, logoUrl: true } }),
    ]);
    if (!cls) return res.status(404).json({ error: { message: 'Class not found', field: 'classId' } });
    if (!session) return res.status(404).json({ error: { message: 'Session not found', field: 'sessionId' } });

    // Same cohort as /generate: who was in THIS class THIS session (Enrollment).
    const enrolled = await prisma.enrollment.findMany({
      where: { schoolId: req.user.schoolId, sessionId: session.id, classId: cls.id },
      select: { studentId: true },
    });
    const ids = enrolled.map((e) => e.studentId);
    const cards = ids.length === 0 ? [] : await prisma.reportCard.findMany({
      where: { schoolId: req.user.schoolId, sessionId: session.id, term, studentId: { in: ids } },
      select: { id: true, snapshot: true, student: { select: { lastName: true, firstName: true } } },
    });
    if (cards.length === 0) {
      return res.status(404).json({ error: {
        message: `No report cards for ${cls.name}, ${RC_TERM_WORD[term]} Term ${session.name} yet. Generate them first.`,
        code: 'NO_REPORT_CARDS',
      } });
    }
    const nm = (c, k) => String((c.student && c.student[k]) || '');
    cards.sort((a, b) => nm(a, 'lastName').localeCompare(nm(b, 'lastName')) || nm(a, 'firstName').localeCompare(nm(b, 'firstName')));

    const logoBuffer = await loadLogo(school && school.logoUrl);
    const buffer = await new Promise((resolve, reject) => {
      // Same page setup as a single card: no bottom margin, the layout owns the bottom edge.
      const doc = new PDFDocument({ size: 'A4', margins: { top: 34, left: 34, right: 34, bottom: 0 }, autoFirstPage: false });
      const chunks = [];
      let pages = 0;
      doc.on('pageAdded', () => { pages += 1; });
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => {
        if (pages !== cards.length) console.error(`[report-cards] rc-class-pdf-v1: ${cards.length} cards made ${pages} pages`);
        resolve(Buffer.concat(chunks));
      });
      doc.on('error', reject);
      try {
        let logo = null;
        if (logoBuffer) { try { logo = doc.openImage(logoBuffer); } catch (_e) { logo = null; } } // embedded once, reused on every page
        for (const c of cards) {
          doc.addPage();
          drawReportCardPage(doc, c.snapshot, school, logo);
        }
        doc.end();
      } catch (e) {
        reject(e);
      }
    });

    const fileName = `${cls.name} ${RC_TERM_WORD[term]} Term ${session.name} report cards`
      .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Report-Card-Count', String(cards.length));
    res.end(buffer);
  } catch (err) {
    next(err);
  }
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
router.get('/:id', authenticate, authorize('SCHOOL_ADMIN'), /* audit-reportcard-read-role-v1 */ async (req, res, next) => {
  try {
    const { id } = req.params;
    const card = await prisma.reportCard.findFirst({
      where: { id, schoolId: req.user.schoolId },
    });
    if (!card) return res.status(404).json({ error: { message: 'Report card not found' } });
    // rc-card-refresh-v1: the class this card belongs to (Enrollment for the card's session),
    // so the card page can refresh the class before printing. null if no enrollment row.
    const enr = await prisma.enrollment.findFirst({
      where: { schoolId: req.user.schoolId, studentId: card.studentId, sessionId: card.sessionId },
      select: { classId: true },
    });
    res.json({ reportCard: { ...card, classId: enr ? enr.classId : null } });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/pdf ─────────────────────────────────────────────────────────────
router.post('/:id/pdf', authenticate, authorize('SCHOOL_ADMIN'), requireActiveForWrites, /* gate-1-rc-pdf */ async (req, res, next) => {
  try {
    const { id } = req.params;
    const card = await prisma.reportCard.findFirst({
      where: { id, schoolId: req.user.schoolId },
      include: { school: { select: { name: true, logoUrl: true } } },
    });
    if (!card) return res.status(404).json({ error: { message: 'Report card not found' } });

    if (!cloudinaryLib.isConfigured || !cloudinaryLib.isConfigured()) {
      return res.status(503).json({ error: { message: 'PDF storage is not configured' } });
    }

    let buffer;
    try {
      buffer = await renderReportCardPdf(card.snapshot, card.school);
    } catch (e) {
      return res.status(500).json({ error: { message: 'Failed to render report card PDF' } });
    }

    const publicId = `reportcard-${card.schoolId}-${card.id}`;
    let secureUrl;
    try {
      secureUrl = await cloudinaryLib.uploadPdfBuffer(buffer, publicId);
    } catch (e) {
      return res.status(502).json({ error: { message: 'Failed to upload report card PDF' } });
    }

    const updated = await prisma.reportCard.update({
      where: { id: card.id },
      data: { pdfUrl: secureUrl },
      select: { id: true, pdfUrl: true, lockedAt: true, term: true, studentId: true },
    });

    res.json({ reportCard: updated });
  } catch (err) {
    next(err);
  }
});

// ── POST /:id/lock ────────────────────────────────────────────────────────────
router.post('/:id/lock', authenticate, authorize('SCHOOL_ADMIN'), requireActiveForWrites, requirePlan('RESULTS_REPORTCARDS'), /* gate-1-rc-lock */ async (req, res, next) => {
  try {
    const { id } = req.params;
    const card = await prisma.reportCard.findFirst({ where: { id, schoolId: req.user.schoolId } });
    if (!card) return res.status(404).json({ error: { message: 'Report card not found' } });
    if (card.lockedAt) {
      return res.json({ reportCard: { id: card.id, lockedAt: card.lockedAt, term: card.term, studentId: card.studentId, pdfUrl: card.pdfUrl } });
    }
    const updated = await prisma.reportCard.update({
      where: { id: card.id },
      data: { lockedAt: new Date() },
      select: { id: true, lockedAt: true, term: true, studentId: true, pdfUrl: true },
    });
    recordAcademicEvent('REPORT_CARD_LOCKED', {
      schoolId: req.user.schoolId, actorId: req.user.id,
      metadata: { reportCardId: updated.id },
    });
    res.json({ reportCard: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
