// src/lib/grading-config.js
// grading-config-v1
//
// Which score breakdown applies to a (session, term):
//   1. the breakdown FROZEN onto that term (AcademicSession.gradingConfigByTerm[term])
//   2. else, if the term already has scores, the original default breakdown -
//      those scores were entered under it before grading-config-v1 existed
//   3. else, the school's current breakdown (School.gradingConfig), or the default.
// freezeForWrite() pins the answer onto the term before its first score is saved,
// so a later change to the school's breakdown can never relabel a term's scores.

const prisma = require('../config/db');
const grading = require('./grading');

const TERMS = ['FIRST', 'SECOND', 'THIRD'];

function frozenParts(map, term) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const v = map[term];
  return Array.isArray(v) && v.length > 0 ? v : null;
}

function schoolParts(gradingConfig) {
  return gradingConfig && typeof gradingConfig === 'object'
    && Array.isArray(gradingConfig.parts) && gradingConfig.parts.length > 0
    ? gradingConfig.parts : null;
}

// → { components: [{ key, label, max }], frozen: bool, source: 'term' | 'legacy' | 'school' }
async function componentsForTerm(schoolId, sessionId, term) {
  const session = await prisma.academicSession.findFirst({
    where: { id: sessionId, schoolId },
    select: { gradingConfigByTerm: true },
  });
  const frozen = frozenParts(session && session.gradingConfigByTerm, term);
  if (frozen) return { components: grading.componentsFor(frozen), frozen: true, source: 'term' };
  const existing = await prisma.resultEntry.findFirst({
    where: { schoolId, sessionId, term },
    select: { id: true },
  });
  if (existing) return { components: grading.componentsFor(null), frozen: false, source: 'legacy' };
  const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { gradingConfig: true } });
  return { components: grading.componentsFor(schoolParts(school && school.gradingConfig)), frozen: false, source: 'school' };
}

// Freeze the term's breakdown (write-once) and return the components to validate against.
async function freezeForWrite(schoolId, sessionId, term) {
  if (!TERMS.includes(term)) throw new Error('grading-config: bad term ' + term);
  const first = await componentsForTerm(schoolId, sessionId, term);
  if (first.frozen) return first.components;
  const parts = first.components.map((c) => ({ label: c.label, max: c.max }));
  await prisma.$transaction(async (tx) => {
    const s = await tx.academicSession.findFirst({
      where: { id: sessionId, schoolId },
      select: { gradingConfigByTerm: true },
    });
    if (!s || frozenParts(s.gradingConfigByTerm, term)) return; // missing, or frozen by a concurrent save
    const map = s.gradingConfigByTerm && typeof s.gradingConfigByTerm === 'object' && !Array.isArray(s.gradingConfigByTerm)
      ? { ...s.gradingConfigByTerm } : {};
    map[term] = parts;
    await tx.academicSession.update({ where: { id: sessionId }, data: { gradingConfigByTerm: map } });
  });
  return (await componentsForTerm(schoolId, sessionId, term)).components;
}

module.exports = { componentsForTerm, freezeForWrite, schoolParts, frozenParts };
