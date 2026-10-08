// src/lib/pdf/report-card-pdf.js
// ops-1-pdf-report-card · rc-onepage-v1
//
// One student's term report card on ONE A4 page — always.
//
// Why this was rewritten (rc-onepage-v1):
//  - The old layout drew rows at fixed y positions. Past ~12 subjects they ran
//    off the bottom and pdfkit threw each cell onto a new page (17 subjects = 8
//    pages, one behaviour trait per page).
//  - brand.js drawFooter() writes 8pt BELOW the bottom margin, so pdfkit opened
//    a second page just for the footer. Every card printed on two sheets.
//
// How this layout guarantees one page:
//  - The document has NO bottom margin, so pdfkit never auto-adds a page; the
//    layout owns the bottom edge (BOTTOM) itself.
//  - Every block's height is measured BEFORE drawing. Fixed blocks first, then
//    the subject rows share what is left (row height 16pt down to 8pt), and
//    comments are capped at a few lines with an ellipsis.
//  - A 'pageAdded' guard logs loudly if anything ever spills (it should not).
//
// Exports keep their old names and shapes:
//  - renderReportCardPdf(snapshot, school) -> Promise<Buffer>   (same as before)
//  - BEHAVIOUR_ATTRS                                             (single source; behaviour + comments routes import it)
//  - _scoreCols                                                  (unchanged, grading-config-v1 tests)
// New, for the class print (rc-class-pdf-v1):
//  - drawReportCardPage(doc, snapshot, school, logo) draws one card on the current page
//  - loadLogo(url) -> Buffer | null (fetch once, reuse for every page)

const PDFDocument = require('pdfkit');
const { BRAND, fetchImageBuffer } = require('./brand');
const grading = require('../grading');

const DASH = '\u2014';

const BEHAVIOUR_ATTRS = [
  'Punctuality', 'Attendance', 'Neatness', 'Honesty', 'Politeness',
  'Cooperation', 'Self-control', 'Attentiveness', 'Perseverance',
  'Relationship', 'Leadership',
];

const TERM_LABEL = { FIRST: 'First', SECOND: 'Second', THIRD: 'Third' };

function safe(v, fallback = DASH) {
  return v === null || v === undefined || v === '' ? fallback : String(v);
}
function ordinal(n) {
  if (n === null || n === undefined || n === '') return DASH;
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const s = ['th', 'st', 'nd', 'rd'];
  const m = v % 100;
  return v + (s[(m - 20) % 10] || s[m] || s[0]);
}

// grading-config-v1 (kept verbatim for its existing tests)
const LEGACY_SCORE_COLS = [
  { key: 'ca1', label: 'CA1', w: 0.08, align: 'center' },
  { key: 'ca2', label: 'CA2', w: 0.08, align: 'center' },
  { key: 'objective', label: 'Obj', w: 0.08, align: 'center' },
  { key: 'theory', label: 'Theory', w: 0.10, align: 'center' },
];
function scoreCols(snapshot, contentW) {
  const g = snapshot && snapshot.grading;
  const comps = g && Array.isArray(g.components) ? g.components : null;
  if (!comps || comps.length === 0 || grading.isDefaultComponents(comps)) return LEGACY_SCORE_COLS;
  const w = 0.34 / comps.length;
  const fit = Math.max(3, Math.floor((w * contentW - 4) / 4.6));
  return comps.map((c) => {
    const label = String(c.label || c.key);
    return { key: c.key, label: label.length > fit ? label.slice(0, fit) : label, w, align: 'center' };
  });
}

// rc-onepage-v1: score columns with their maximums (header shows "CA1 / 20").
const LEGACY_COMPONENTS = [
  { key: 'ca1', label: 'CA1', max: 20 },
  { key: 'ca2', label: 'CA2', max: 20 },
  { key: 'objective', label: 'Obj', max: 20 },
  { key: 'theory', label: 'Theory', max: 40 },
];
function components(snapshot) {
  const g = snapshot && snapshot.grading;
  const comps = g && Array.isArray(g.components) && g.components.length ? g.components : null;
  if (!comps) return LEGACY_COMPONENTS;
  return comps.slice(0, 6).map((c) => ({ key: c.key, label: String(c.label || c.key), max: c.max }));
}

// ── Logo ──────────────────────────────────────────────────────────────────────
// pdfkit embeds PNG and JPEG only. For a Cloudinary logo, ask Cloudinary for a
// small PNG so a .webp/.svg/huge upload still prints. Anything else is fetched
// as-is. Best-effort: a missing, slow or unreadable logo never blocks the PDF.
function logoUrlForPdf(url) {
  if (!url || typeof url !== 'string') return null;
  if (/^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(url)) {
    return url.replace('/image/upload/', '/image/upload/f_png,w_240,h_240,c_limit/');
  }
  return url;
}
function isPngOrJpeg(buf) {
  if (!buf || buf.length < 4) return false;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8;
  return png || jpg;
}
async function loadLogo(url) {
  const u = logoUrlForPdf(url);
  if (!u) return null;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 6000));
  const buf = await Promise.race([fetchImageBuffer(u), timeout]);
  return isPngOrJpeg(buf) ? buf : null;
}

// ── Small drawing helpers ────────────────────────────────────────────────────
// Trim a string with "…" until it fits maxW at the CURRENT font + size.
function fitLine(doc, text, maxW) {
  let s = String(text);
  if (doc.widthOfString(s) <= maxW) return s;
  while (s.length > 1 && doc.widthOfString(s + '\u2026') > maxW) s = s.slice(0, -1);
  return s.trimEnd() + '\u2026';
}
function cellText(doc, text, x, y, w, opts = {}) {
  const pad = opts.pad == null ? 3 : opts.pad;
  const s = fitLine(doc, safe(text, opts.blank ? '' : DASH), Math.max(4, w - pad * 2));
  doc.text(s, x + pad, y, { width: w - pad * 2, align: opts.align || 'left', lineBreak: false });
}
function hline(doc, x1, x2, y, color, width) {
  doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(width || 0.5).strokeColor(color || BRAND.hair).stroke().restore();
}
function boxStroke(doc, x, y, w, h, color) {
  doc.save().rect(x, y, w, h).lineWidth(0.6).strokeColor(color || BRAND.hair).stroke().restore();
}

// ── One card on the CURRENT page ─────────────────────────────────────────────
function drawReportCardPage(doc, snapshot, school, logo) {
  const snap = snapshot || {};
  const W = doc.page.width;
  const H = doc.page.height;
  const M = 34;
  const left = M;
  const right = W - M;
  const cw = right - left;
  const BOTTOM = H - 30;   // content ends here; the footer sits below it
  const GAP = 7;

  const stu = snap.student || {};
  const sum = snap.summary || {};
  const att = snap.attendance || {};
  const comments = snap.comments || {};
  const subjects = Array.isArray(snap.subjects) ? snap.subjects : [];
  const termLabel = TERM_LABEL[snap.term] || safe(snap.term, '');

  // ── Header: logo + school name ──
  let y = M;
  const LOGO = 56;
  let hasLogo = false;
  if (logo) {
    try { doc.image(logo, left, y, { fit: [LOGO, LOGO], align: 'center', valign: 'center' }); hasLogo = true; }
    catch (_e) { hasLogo = false; }
  }
  const inset = hasLogo ? LOGO + 10 : 0;
  const nameX = left + inset;
  const nameW = cw - inset * 2;           // symmetric, so the name stays centred on the page
  const schoolName = String((school && school.name) || 'School').toUpperCase();
  doc.font('Helvetica-Bold');
  let nameSize = 20;
  while (nameSize > 13 && doc.fontSize(nameSize).widthOfString(schoolName) > nameW) nameSize -= 1;
  doc.fontSize(nameSize);
  const oneLine = doc.widthOfString(schoolName) <= nameW;
  const nameH = oneLine ? nameSize * 1.15 : Math.min(doc.heightOfString(schoolName, { width: nameW, align: 'center' }), nameSize * 1.2 * 2);
  doc.fillColor(BRAND.navy).text(schoolName, nameX, y + 2, { width: nameW, align: 'center', height: nameH, ellipsis: true });
  let ty = y + 2 + nameH + 3;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND.green)
     .text(`${termLabel ? termLabel.toUpperCase() + ' TERM ' : ''}REPORT CARD`, nameX, ty, { width: nameW, align: 'center', lineBreak: false });
  ty += 13;
  doc.font('Helvetica').fontSize(8.5).fillColor(BRAND.grey)
     .text(`${safe(snap.session, '')} Academic Session`, nameX, ty, { width: nameW, align: 'center', lineBreak: false });
  ty += 11;
  y = Math.max(ty, y + (hasLogo ? LOGO : 0)) + 5;
  hline(doc, left, right, y, BRAND.green, 1.2);
  y += GAP;

  // ── Student strip ──
  const infoH = 30;
  boxStroke(doc, left, y, cw, infoH);
  const infoCols = [
    { label: 'Student', value: safe(stu.fullName), w: 0.40, bold: true },
    { label: 'Admission No.', value: safe(stu.admissionNumber), w: 0.22 },
    { label: 'Class', value: safe(stu.class), w: 0.20 },
    { label: 'No. in class', value: safe(sum.classSize), w: 0.18 },
  ];
  let ix = left;
  infoCols.forEach((c, i) => {
    const w = c.w * cw;
    if (i > 0) doc.save().moveTo(ix, y + 5).lineTo(ix, y + infoH - 5).lineWidth(0.5).strokeColor(BRAND.hair).stroke().restore();
    doc.font('Helvetica').fontSize(6.5).fillColor(BRAND.grey);
    cellText(doc, c.label.toUpperCase(), ix + 3, y + 5, w - 3, { blank: true });
    doc.font('Helvetica-Bold').fontSize(c.bold ? 10 : 9.5).fillColor(BRAND.navy);
    cellText(doc, c.value, ix + 3, y + 15, w - 3);
    ix += w;
  });
  y += infoH + GAP;

  // ── Measure everything below the table first ──
  const summaryH = 36;
  const behRows = Math.ceil(BEHAVIOUR_ATTRS.length / 4);
  const behH = 15 + behRows * 13 + 3;
  const resumption = snap.resumptionDate ? String(snap.resumptionDate) : null;
  const resumH = resumption ? 14 : 0;

  // Comments: an empty comment leaves two ruled lines to write on by hand
  // (Starter schools have no AI comments, so this is their normal case).
  const commentW = cw - 16;
  const commentFont = 8.5;
  function commentBodyH(text, maxLines) {
    if (!text) return 2 * 13;
    doc.font('Helvetica').fontSize(commentFont);
    const full = doc.heightOfString(String(text), { width: commentW });
    const lineH = doc.currentLineHeight(true);
    return Math.min(full, lineH * maxLines);
  }
  let maxLines = 4;
  const commentBlockH = () =>
    (14 + commentBodyH(comments.classTeacher, maxLines) + 16) +
    (14 + commentBodyH(comments.principal, maxLines) + 16);

  const tableTop = y;
  const comps = components(snap);
  // Widths: score parts get more room as they multiply (up to 6); Subject never drops below ~24%.
  const fixedW = { total: 0.075, grade: 0.065, pos: 0.065 };
  const remarkW = comps.length >= 5 ? 0.105 : 0.15;
  const compW = Math.min(0.085, (1 - 0.235 - 0.205 - remarkW) / comps.length);
  const subjW = 1 - 0.205 - remarkW - compW * comps.length;
  const cols = [
    { key: 'name', label: 'Subject', w: subjW, align: 'left' },
    ...comps.map((c) => ({ key: c.key, label: c.label, sub: c.max != null ? String(c.max) : '', w: compW, align: 'center' })),
    { key: 'total', label: 'Total', sub: '100', w: fixedW.total, align: 'center', bold: true },
    { key: 'grade', label: 'Grade', w: fixedW.grade, align: 'center', bold: true },
    { key: 'subjectPosition', label: 'Pos.', w: fixedW.pos, align: 'center' },
    { key: 'remark', label: 'Remark', w: remarkW, align: 'left' },
  ];
  // Header labels: shrink to fit one line (7.5pt down to 5.5pt for a single word);
  // a multi-word label wraps onto up to three lines; only then is it trimmed.
  function wrapWords(words, avail) {
    const lines = [];
    let cur = '';
    for (const w of words) {
      if (doc.widthOfString(w) > avail) return null;
      const next = cur ? cur + ' ' + w : w;
      if (doc.widthOfString(next) <= avail) cur = next; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines.length <= 3 ? lines : null;
  }
  doc.font('Helvetica-Bold');
  cols.forEach((c) => {
    const avail = c.w * cw - 3;
    const words = String(c.label).trim().split(/\s+/);
    c.lines = [c.label]; c.size = 7.5;
    const minSingle = words.length === 1 ? 5.5 : 6.5;
    for (let sz = 7.5; sz >= minSingle; sz -= 0.5) { if (doc.fontSize(sz).widthOfString(c.label) <= avail) { c.size = sz; return; } }
    for (const sz of [6.5, 6]) {
      doc.fontSize(sz);
      const lines = words.length > 1 ? wrapWords(words, avail) : null;
      if (lines) { c.lines = lines; c.size = sz; return; }
    }
    c.size = 5.5; // trimmed with an ellipsis by cellText
  });
  const headLines = Math.max(...cols.map((c) => c.lines.length));
  const headH = headLines >= 3 ? 33 : headLines === 2 ? 27 : 20;
  // (column + header measurement moved up so the header height is known before fitting rows)
  const n = Math.max(subjects.length, 1);
  const fixedBelow = () => GAP + summaryH + GAP + behH + GAP + commentBlockH() + (resumH ? GAP + resumH : 0);
  let rowH = Math.min(16, (BOTTOM - tableTop - headH - fixedBelow()) / n);
  if (rowH < 11) { maxLines = 2; rowH = Math.min(16, (BOTTOM - tableTop - headH - fixedBelow()) / n); }
  rowH = Math.max(8, rowH);
  const rowFont = Math.max(6, Math.min(8.5, rowH * 0.56));

  // ── Subjects table ──
  const xs = [];
  let acc = left;
  cols.forEach((c) => { xs.push(acc); acc += c.w * cw; });

  doc.rect(left, y, cw, headH).fill(BRAND.navy);
  cols.forEach((c, i) => {
    const w = c.w * cw;
    const lineGap = c.size + 1;
    const block = c.lines.length * lineGap + (c.sub ? 7 : 0);
    let ly = y + (headH - block) / 2 + 0.5;
    doc.font('Helvetica-Bold').fontSize(c.size).fillColor('white');
    c.lines.forEach((ln) => { cellText(doc, ln, xs[i], ly, w, { align: c.align, blank: true, pad: 1.5 }); ly += lineGap; });
    if (c.sub) {
      doc.font('Helvetica').fontSize(6).fillColor('#c9d1d9');
      cellText(doc, c.sub, xs[i], ly, w, { align: c.align, blank: true, pad: 1.5 });
    }
  });
  y += headH;

  if (subjects.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(BRAND.grey)
       .text('No results entered for this term.', left + 4, y + (rowH - 8.5) / 2 + 1, { lineBreak: false });
    y += rowH;
  } else {
    subjects.forEach((row, idx) => {
      if (idx % 2 === 1) doc.rect(left, y, cw, rowH).fill('#f3f4f6');
      cols.forEach((c, i) => {
        let v = row[c.key];
        if (c.key === 'subjectPosition') v = row.subjectPosition ? ordinal(row.subjectPosition) : null;
        doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(rowFont).fillColor('black');
        cellText(doc, v, xs[i], y + (rowH - rowFont) / 2 + 0.5, c.w * cw, { align: c.align });
      });
      y += rowH;
    });
  }
  boxStroke(doc, left, tableTop, cw, y - tableTop, '#d1d5db');
  y += GAP;

  // ── Term summary + attendance (one strip) ──
  function statBox(x, w, title, cells) {
    boxStroke(doc, x, y, w, summaryH);
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(BRAND.green).text(title, x + 6, y + 4, { lineBreak: false });
    const cwid = (w - 6) / cells.length;
    cells.forEach((c, i) => {
      const cx = x + 3 + i * cwid;
      doc.font('Helvetica').fontSize(6.3).fillColor(BRAND.grey);
      cellText(doc, c[0].toUpperCase(), cx, y + 14, cwid, { align: 'center', blank: true });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND.navy);
      cellText(doc, c[1], cx, y + 22, cwid, { align: 'center' });
    });
  }
  const obtainable = Number.isFinite(Number(sum.subjectsCount)) ? Number(sum.subjectsCount) * 100 : null;
  const totalScore = sum.aggregate == null ? null : (obtainable ? `${sum.aggregate} / ${obtainable}` : String(sum.aggregate));
  const position = sum.overallPosition ? `${ordinal(sum.overallPosition)} of ${safe(sum.classSize)}` : null;
  const sumW = cw * 0.63;
  statBox(left, sumW, 'TERM SUMMARY', [
    ['Subjects', safe(sum.subjectsCount, '0')],
    ['Total score', totalScore],
    ['Average', sum.average],
    ['Position', position],
    ['Cumulative avg.', sum.cumulativeAverage],
  ]);
  statBox(left + sumW + 6, cw - sumW - 6, 'ATTENDANCE', [
    ['School opened', att.schoolOpened],
    ['Present', att.present],
    ['Absent', att.absent],
  ]);
  y += summaryH + GAP;

  // ── Behaviour (4 columns) ──
  boxStroke(doc, left, y, cw, behH);
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(BRAND.green)
     .text('BEHAVIOURAL ASSESSMENT', left + 6, y + 4, { lineBreak: false });
  doc.font('Helvetica').fontSize(6.3).fillColor(BRAND.grey)
     .text('Rated 1 (lowest) to 5 (highest)', left + 6, y + 4, { width: cw - 12, align: 'right', lineBreak: false });
  const byAttr = {};
  (Array.isArray(snap.behaviour) ? snap.behaviour : []).forEach((b) => { if (b && b.attribute) byAttr[b.attribute] = b.score; });
  const bColW = (cw - 12) / 4;
  BEHAVIOUR_ATTRS.forEach((attr, i) => {
    const bx = left + 6 + (i % 4) * bColW;
    const by = y + 16 + Math.floor(i / 4) * 13;
    doc.font('Helvetica').fontSize(8).fillColor('black');
    cellText(doc, attr, bx, by, bColW - 24, { pad: 0 });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BRAND.navy);
    cellText(doc, byAttr[attr], bx + bColW - 30, by, 18, { align: 'right', pad: 0 });
    hline(doc, bx, bx + bColW - 10, by + 10.5, '#eef0f2', 0.4);
  });
  y += behH + GAP;

  // ── Comments with signature lines ──
  function commentBlock(title, text) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(BRAND.navy).text(title, left, y, { lineBreak: false });
    y += 12;
    const bodyH = commentBodyH(text, maxLines);
    if (text) {
      doc.font('Helvetica').fontSize(commentFont).fillColor('black')
         .text(String(text), left + 8, y, { width: commentW, height: bodyH + 1, ellipsis: true });
    } else {
      hline(doc, left + 8, right, y + 10, '#c7cbd1', 0.6);
      hline(doc, left + 8, right, y + 23, '#c7cbd1', 0.6);
    }
    y += bodyH + 4;
    doc.font('Helvetica').fontSize(7.5).fillColor(BRAND.grey)
       .text('Signature & date:', right - 190, y + 1, { lineBreak: false });
    hline(doc, right - 120, right, y + 9, '#9ca3af', 0.6);
    y += 14;
  }
  commentBlock("Class Teacher's Comment", comments.classTeacher);
  commentBlock("Principal's Comment", comments.principal);

  if (resumption) {
    y += GAP - 4;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BRAND.navy)
       .text(`Next term begins: ${resumption}`, left, y, { lineBreak: false });
    y += resumH;
  }

  // ── Footer (inside the page; the doc has no bottom margin) ──
  doc.font('Helvetica').fontSize(7).fillColor(BRAND.grey)
     .text('Generated by Klassrun \u00b7 klassrun.com', left, H - 22, { width: cw, align: 'center', lineBreak: false });
  doc.fillColor('black');
  return y; // where content ended (tests assert y <= BOTTOM)
}

// snapshot: the frozen ReportCard payload. school: { name, logoUrl }.
async function renderReportCardPdf(snapshot, school) {
  const logo = await loadLogo(school && school.logoUrl);
  return new Promise((resolve, reject) => {
    try {
      // No bottom margin: pdfkit must never auto-add a page. The layout owns the bottom edge.
      const doc = new PDFDocument({ size: 'A4', margins: { top: 34, left: 34, right: 34, bottom: 0 } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.on('pageAdded', () => {
        console.error('[report-card-pdf] rc-onepage-v1: a card spilled onto a second page', snapshot && snapshot.student && snapshot.student.id);
      });
      drawReportCardPage(doc, snapshot, school, logo);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  renderReportCardPdf,
  drawReportCardPage, // rc-onepage-v1: reused by the class print
  loadLogo,           // rc-onepage-v1
  BEHAVIOUR_ATTRS,
  _scoreCols: scoreCols, // grading-config-v1: _scoreCols for tests
};
