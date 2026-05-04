const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

// Route imports
const authRoutes = require('./modules/auth/auth.routes');
const schoolRoutes = require('./modules/schools/school.routes');
const noteRoutes = require('./modules/notes/note.routes');
const assessmentRoutes = require('./modules/assessments/assessment.routes');
const curriculumRoutes = require('./modules/curriculum/curriculum.routes');

const app = express();

// ── MIDDLEWARE ──
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// ── HEALTH CHECK ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'klassrun-api', timestamp: new Date().toISOString() });
});

// ── ROUTES ──
app.use('/api/auth', authRoutes);
app.use('/api/schools', schoolRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/assessments', assessmentRoutes);
app.use('/api/curriculum', curriculumRoutes);

// ── ERROR HANDLER ──
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  const status = err.status || 500;
  res.status(status).json({
    error: {
      message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
    },
  });
});

// ── 404 ──
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Route not found' } });
});

module.exports = app;
