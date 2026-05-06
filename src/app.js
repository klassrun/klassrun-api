const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');

// Route imports
const authRoutes        = require('./modules/auth/auth.routes');
const schoolRoutes      = require('./modules/schools/school.routes');
const noteRoutes        = require('./modules/notes/note.routes');
const assessmentRoutes  = require('./modules/assessments/assessment.routes');
const curriculumRoutes  = require('./modules/curriculum/curriculum.routes');
const slugRoutes        = require('./modules/slug/slug.routes');

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
app.use(express.json({ limit: '10mb' }));

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
app.use('/api/schools',     schoolRoutes);
app.use('/api/notes',       noteRoutes);
app.use('/api/assessments', assessmentRoutes);
app.use('/api/curriculum',  curriculumRoutes);
app.use('/api/slug',        slugRoutes);

// ── ERROR HANDLER ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  const status = err.status || (err.message?.startsWith('CORS') ? 403 : 500);
  res.status(status).json({
    error: {
      message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
    },
  });
});

// ── 404 ─────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Route not found' } });
});

module.exports = app;
