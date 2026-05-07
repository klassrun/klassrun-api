// ─────────────────────────────────────────────────────────────────────────────
//  APP.JS PATCH — register the new teachers module
// ─────────────────────────────────────────────────────────────────────────────
//
// Open klassrun-api/src/app.js
//
// Find this section:
//
//     app.use('/api/auth',        authRoutes);
//     app.use('/api/schools',     schoolRoutes);
//     ...
//
// Add the teachers route BEFORE the schools route (any order is fine):
//
//     const teacherRoutes = require('./modules/teachers/teachers.routes');
//     ...
//     app.use('/api/teachers',    teacherRoutes);
//
// Save. Done.
