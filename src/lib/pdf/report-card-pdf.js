// src/lib/pdf/report-card-pdf.js
// ops-1-pdf-report-card
//
// Renders a ReportCard.snapshot (see report-card.routes.js) to a PDF Buffer
// using pdfkit. Nigerian report-card layout: student block, subjects table
// (scores + grade + remark + subject position), term summary, attendance row
// and behavioural grid as structured "—" placeholders (data lands in Ops 2),
// class-teacher + principal comment blocks, resumption date.

const PDFDocument = require('pdfkit');
const { BRAND, fetchImageBuffer, drawHeader, drawFooter } = require('./brand');

const DASH = '\u2014'; // "—"

const BEHAVIOUR_ATTRS = [
  'Punctuality', 'Attendance', 'Neatness', 'Honesty', 'Politeness',
  'Cooperation', 'Self-control', 'Attentiveness', 'Perseverance',
  'Relationship', 'Leadership',
];

function fullName(s) {
  return [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
}

function safe(v, fallback = DASH) {
  return v === null || v === undefined || v === '' ? fallback : String(v);
}

// snapshot: the frozen ReportCard payload. school: { name, logoUrl }.
async function renderReportCardPdf(snapshot, school) {
  const logoBuffer = await fetchImageBuffer(school && school.logoUrl);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const contentW = right - left;

      const stu = snapshot.student || {};
      drawHeader(doc, {
        schoolName: (school && school.name) || 'School',
        title: 'Student Report Card',
        subtitle: `${safe(snapshot.session)}  ·  ${safe(snapshot.term)} Term`,
        logoBuffer,
      });

      // ── Student block ──
      doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.navy);
      doc.text(safe(stu.fullName), left, doc.y);
      doc.font('Helvetica').fontSize(9).fillColor('black');
      doc.text(
        `Admission No: ${safe(stu.admissionNumber)}     Class: ${safe(stu.class)}`,
        left,
        doc.y + 2
      );
      doc.moveDown(0.8);

      // ── Subjects table ──
      const cols = [
        { key: 'name', label: 'Subject', w: 0.30, align: 'left' },
        { key: 'ca1', label: 'CA1', w: 0.08, align: 'center' },
        { key: 'ca2', label: 'CA2', w: 0.08, align: 'center' },
        { key: 'objective', label: 'Obj', w: 0.08, align: 'center' },
        { key: 'theory', label: 'Theory', w: 0.10, align: 'center' },
        { key: 'total', label: 'Total', w: 0.09, align: 'center' },
        { key: 'grade', label: 'Grade', w: 0.08, align: 'center' },
        { key: 'subjectPosition', label: 'Pos', w: 0.07, align: 'center' },
        { key: 'remark', label: 'Remark', w: 0.12, align: 'left' },
      ];
      const xs = [];
      let acc = left;
      for (const c of cols) { xs.push(acc); acc += c.w * contentW; }

      const rowH = 16;
      function drawRow(y, values, opts = {}) {
        if (opts.fill) {
          doc.rect(left, y, contentW, rowH).fill(opts.fillColor || BRAND.hair);
        }
        doc.fillColor(opts.color || 'black')
           .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
           .fontSize(8.5);
        cols.forEach((c, i) => {
          doc.text(safe(values[c.key], opts.header ? '' : DASH), xs[i] + 2, y + 4, {
            width: c.w * contentW - 4,
            align: c.align,
            lineBreak: false,
          });
        });
      }

      // header
      const headerLabels = {};
      cols.forEach((c) => { headerLabels[c.key] = c.label; });
      drawRow(doc.y, headerLabels, { header: true, fill: true, fillColor: BRAND.navy, color: 'white', bold: true });
      doc.y += rowH;

      const subjects = Array.isArray(snapshot.subjects) ? snapshot.subjects : [];
      subjects.forEach((row, idx) => {
        drawRow(doc.y, row, { fill: idx % 2 === 1, fillColor: '#f3f4f6' });
        doc.y += rowH;
      });
      if (subjects.length === 0) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor(BRAND.grey)
           .text('No results entered for this term yet.', left, doc.y + 2);
        doc.fillColor('black');
        doc.y += rowH;
      }
      doc.moveDown(0.6);

      // ── Summary ──
      const sum = snapshot.summary || {};
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND.navy);
      doc.text('Term Summary', left, doc.y);
      doc.font('Helvetica').fontSize(9).fillColor('black');
      doc.text(
        `Subjects: ${safe(sum.subjectsCount, '0')}     Aggregate: ${safe(sum.aggregate, '0')}` +
        `     Average: ${safe(sum.average, '0')}     Overall Position: ${safe(sum.overallPosition)} of ${safe(sum.classSize)}` +
        `     Cumulative Avg: ${safe(sum.cumulativeAverage)}`,
        left, doc.y + 2, { width: contentW }
      );
      doc.moveDown(0.8);

      // ── Attendance (placeholder until Ops 2) ──
      const att = snapshot.attendance || {};
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND.navy);
      doc.text('Attendance', left, doc.y);
      doc.font('Helvetica').fontSize(9).fillColor('black');
      doc.text(
        `School Opened: ${safe(att.schoolOpened)}     Present: ${safe(att.present)}     Absent: ${safe(att.absent)}`,
        left, doc.y + 2
      );
      doc.moveDown(0.8);

      // ── Behavioural grid (placeholder until Ops 2) ──
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND.navy);
      doc.text('Behavioural Assessment (1\u20135)', left, doc.y);
      doc.font('Helvetica').fontSize(8.5).fillColor('black');
      doc.moveDown(0.2);
      const behaviour = Array.isArray(snapshot.behaviour) ? snapshot.behaviour : [];
      const byAttr = {};
      behaviour.forEach((b) => { if (b && b.attribute) byAttr[b.attribute] = b.score; });
      const gridCols = 2;
      const colW = contentW / gridCols;
      let bx = left;
      let startY = doc.y;
      BEHAVIOUR_ATTRS.forEach((attr, i) => {
        const colIdx = i % gridCols;
        const rowIdx = Math.floor(i / gridCols);
        const cx = left + colIdx * colW;
        const cy = startY + rowIdx * 14;
        doc.text(`${attr}: ${safe(byAttr[attr])}`, cx, cy, { width: colW - 6, lineBreak: false });
      });
      doc.y = startY + Math.ceil(BEHAVIOUR_ATTRS.length / gridCols) * 14 + 6;
      doc.moveDown(0.4);

      // ── Comments (placeholder until Ops 2 AI) ──
      const comments = snapshot.comments || {};
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND.navy).text("Class Teacher's Comment", left, doc.y);
      doc.font('Helvetica').fontSize(9).fillColor('black').text(safe(comments.classTeacher), left, doc.y + 2, { width: contentW });
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND.navy).text("Principal's Comment", left, doc.y);
      doc.font('Helvetica').fontSize(9).fillColor('black').text(safe(comments.principal), left, doc.y + 2, { width: contentW });
      doc.moveDown(0.6);

      doc.font('Helvetica').fontSize(9).fillColor('black')
         .text(`Resumption Date: ${safe(snapshot.resumptionDate)}`, left, doc.y);

      drawFooter(doc, 'Generated by Klassrun \u00b7 klassrun.com');
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderReportCardPdf, BEHAVIOUR_ATTRS };
