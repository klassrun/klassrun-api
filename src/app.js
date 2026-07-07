const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');

// Route imports
const authRoutes        = require('./modules/auth/auth.routes');
const teacherRoutes = require('./modules/teachers/teachers.routes');
const teachersSelfRoutes = require('./modules/teachers/teachers-self.routes'); // batch-2c-phase-4a-teachers-self-mount
const schoolRoutes      = require('./modules/schools/school.routes');
const noteRoutes        = require('./modules/notes/note.routes');
const schemeRoutes      = require('./modules/schemes/scheme.routes'); // batch-3-phase-2-schemes-mount
const assessmentRoutes  = require('./modules/assessments/assessment.routes');
const curriculumRoutes  = require('./modules/curriculum/curriculum.routes');
const slugRoutes        = require('./modules/slug/slug.routes');
const sessionRoutes     = require('./modules/sessions/session.routes'); // batch-2c-phase-1-sessions-mount
const classRoutes      = require('./modules/classes/class.routes'); // batch-2c-phase-2-classes-mount
const subjectRoutes    = require('./modules/subjects/subject.routes'); // batch-2c-phase-3a-subjects-mount
const studentRoutes    = require('./modules/students/student.routes'); // ops-1-routes-mount
const resultRoutes     = require('./modules/results/result.routes'); // ops-1-routes-mount
const reportCardRoutes = require('./modules/report-cards/report-card.routes'); // ops-1-routes-mount
const attendanceRoutes        = require('./modules/attendance/attendance.routes'); // ops-2-routes-mount
const behaviourRoutes         = require('./modules/behaviour/behaviour.routes'); // ops-2-routes-mount
const reportCardCommentRoutes = require('./modules/report-card-comments/report-card-comments.routes'); // ops-2-routes-mount
const promotionRoutes = require('./modules/promotions/promotion.routes'); // ops-3-routes-mount
const feeRoutes = require('./modules/fees/fee.routes'); // ops-4-routes-mount
const portalRoutes = require('./modules/portal/portal.routes'); // ops-5-routes-mount


const app = express();

// ── TRUST PROXY ─────────────────────────────────────────────────────────────
// Railway and Cloudflare both sit in front of us. Without this, req.ip
// shows the proxy's IP instead of the real client IP for audit logs.
app.set('trust proxy', 1);

// ── CORS ────────────────────────────────────────────────────────────────────
//
// klassrun-app (frontend) is served from Cloudflare Pages at
// app.klassrun.com. The backend is on Railway at api.klassrun.com.
// They're different origins, so we need explicit CORS configuration.
//
// ALLOWED_ORIGINS env var should be a comma-separated list:
//   ALLOWED_ORIGINS=https://app.klassrun.com,https://klassrun.com,http://localhost:3000

const DEFAULT_ALLOWED = ['http://localhost:3000', 'http://localhost:3001'];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)
  .concat(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : [])
  .concat(DEFAULT_ALLOWED);

const corsOptions = {
  origin(origin, cb) {
    // Allow same-origin / no-origin requests (Postman, curl, server-to-server)
    if (!origin) return cb(null, true);

    // Allow exact matches from our allow-list
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);

    // Allow any *.klassrun.com subdomain in production (future per-school portals)
    if (/^https:\/\/[a-z0-9-]+\.klassrun\.com$/i.test(origin)) return cb(null, true);

    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// ── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors(corsOptions));
app.use('/api/billing/webhook', express.raw({ type: '*/*' }), require('./modules/billing/billing.webhook')); // pay-1-webhook-mount
app.use(express.json({ limit: '2mb' })); // perf: 10mb let anyone POST huge bodies anywhere

// ── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'klassrun-api',
    timestamp: new Date().toISOString(),
  });
});

// ── ROUTES ──────────────────────────────────────────────────────────────────
app.use('/api/auth',        authRoutes);
app.use('/api/teachers/me', teachersSelfRoutes); // batch-2c-phase-4a-teachers-self-mount
app.use('/api/teachers',    teacherRoutes);
app.use('/api/schools',     schoolRoutes);
app.use('/api/notes',       noteRoutes);
app.use('/api/schemes',     schemeRoutes); // batch-3-phase-2-schemes-mount
app.use('/api/assessments', assessmentRoutes);
app.use('/api/curriculum',  curriculumRoutes);
app.use('/api/slug',        slugRoutes);
app.use('/api/sessions',    sessionRoutes);
app.use('/api/classes',     classRoutes);
app.use('/api/classes/:classId/subjects', subjectRoutes); // batch-2c-phase-3a-subjects-mount
app.use('/api/subjects', subjectRoutes);
app.use('/api/students',     studentRoutes); // ops-1-routes-mount
app.use('/api/results',      resultRoutes); // ops-1-routes-mount
app.use('/api/promotions',   promotionRoutes); // ops-3-routes-mount
app.use('/api/fees',          feeRoutes); // ops-4-routes-mount
app.use('/api/portal',        portalRoutes); // ops-5-routes-mount
app.use('/api/attendance',            attendanceRoutes); // ops-2-routes-mount
app.use('/api/behaviour',             behaviourRoutes); // ops-2-routes-mount
app.use('/api/report-cards/comments', reportCardCommentRoutes); // ops-2-routes-mount (must precede /api/report-cards)
app.use('/api/report-cards', reportCardRoutes); // ops-1-routes-mount
app.use('/api/billing',     require('./modules/billing/billing.routes')); // pay-1-billing-mount
app.use('/api/analytics', require('./modules/analytics/analytics.routes')); // batch-6-analytics-mount
app.use('/api/leads', require('./modules/leads/lead.routes')); // leads-capture-mount

// ── 404 (must come before the error handler) ────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Route not found' } });
});

// ── ERROR HANDLER ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => { // hs-err-handler
  const { friendlyError } = require('./lib/error-messages');
  const { status, message } = friendlyError(err);
  // Full detail (code + stack) logged server-side ONLY — never sent to the client.
  console.error('[error]', status, req.method, req.originalUrl, err);
  res.status(status).json({ error: { message } });
});

module.exports = app;
