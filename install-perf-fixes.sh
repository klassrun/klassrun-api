#!/usr/bin/env bash
# install-perf-fixes.sh — Klassrun API performance + cost fixes (perf-1 .. perf-7)
set -e
cd ~/Desktop/klassrun-api

TS=$(date +%Y%m%d-%H%M%S)
BACKUP=".installer-backup-perf-$TS"
PATCH_DIR=$(mktemp -d)
mkdir -p "$BACKUP"

echo "==> Backing up files to $BACKUP"
for f in src/lib/anthropic.js src/middleware/auth.js src/modules/teachers/teachers.controller.js \
         src/config/db.js src/app.js prisma/schema.prisma \
         src/modules/assessments/assessment.routes.js \
         src/modules/report-cards/report-card.routes.js \
         src/modules/auth/auth.controller.js package.json; do
  mkdir -p "$BACKUP/$(dirname $f)"
  cp "$f" "$BACKUP/$f"
done

# ─────────────────────────────────────────────────────────────────────────────
# Patch helper: exact-match, must occur exactly once, else abort (nothing written)
# ─────────────────────────────────────────────────────────────────────────────
cat > "$PATCH_DIR/apply.js" <<'HELPER_EOF'
const fs = require('fs');
const path = require('path');
const manifest = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n');
const patchDir = process.argv[3];
const planned = [];
for (const line of manifest) {
  const [target, id] = line.split('|');
  const oldStr = fs.readFileSync(path.join(patchDir, id + '.old'), 'utf8');
  const newStr = fs.readFileSync(path.join(patchDir, id + '.new'), 'utf8');
  const content = fs.readFileSync(target, 'utf8');
  const count = content.split(oldStr).length - 1;
  if (count !== 1) {
    console.error(`✗ ABORT: patch ${id} → ${target}: expected exactly 1 match, found ${count}.`);
    console.error('  Your file differs from the expected version. NOTHING was modified.');
    process.exit(1);
  }
  planned.push({ target, id, oldStr, newStr });
}
// All verified — now write
for (const p of planned) {
  const content = fs.readFileSync(p.target, 'utf8');
  fs.writeFileSync(p.target, content.replace(p.oldStr, p.newStr));
  console.log(`  ✓ ${p.id} → ${p.target}`);
}
HELPER_EOF

# ─── perf-1: prompt caching (anthropic.js) ───────────────────────────────────
cat > "$PATCH_DIR/p01.old" <<'EOF'
    response = await client.messages.create({
    model:       ANTHROPIC_MODEL,
    max_tokens:  maxTokens,
    temperature: temperature,
    system:      systemPrompt,
      messages: [
        { role: 'user', content: userMessage },
      ],
    });
EOF
cat > "$PATCH_DIR/p01.new" <<'EOF'
    response = await client.messages.create({
    model:       ANTHROPIC_MODEL,
    max_tokens:  maxTokens,
    temperature: temperature,
    // perf-1-prompt-caching: system prompts are 1.5k-2.5k tokens and identical
    // across calls. Caching cuts their input cost ~90% on cache hits.
    system: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
      messages: [
        { role: 'user', content: userMessage },
      ],
    });
EOF

# ─── perf-2b: invalidate auth cache on revoke (teachers.controller.js) ───────
cat > "$PATCH_DIR/p02.old" <<'EOF'
const { recordAuthEvent }     = require('../../lib/audit');
EOF
cat > "$PATCH_DIR/p02.new" <<'EOF'
const { recordAuthEvent }     = require('../../lib/audit');
const { invalidateUserCache } = require('../../middleware/auth'); // perf-2-auth-cache
EOF

cat > "$PATCH_DIR/p03.old" <<'EOF'
    await prisma.user.update({
      where: { id: teacherId },
      data:  { revokedAt: new Date() },
    });
EOF
cat > "$PATCH_DIR/p03.new" <<'EOF'
    await prisma.user.update({
      where: { id: teacherId },
      data:  { revokedAt: new Date() },
    });
    invalidateUserCache(teacherId); // perf-2: revocation takes effect immediately
EOF

# ─── perf-3: pg adapter config + pool cap (db.js) ────────────────────────────
cat > "$PATCH_DIR/p04.old" <<'EOF'
const adapter = new PrismaPg(process.env.DATABASE_URL);
EOF
cat > "$PATCH_DIR/p04.new" <<'EOF'
// perf-3: documented adapter config + pool cap (Neon free tier connection limits)
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 5 });
EOF

# ─── perf: body limit (app.js) ───────────────────────────────────────────────
cat > "$PATCH_DIR/p05.old" <<'EOF'
app.use(express.json({ limit: '10mb' }));
EOF
cat > "$PATCH_DIR/p05.new" <<'EOF'
app.use(express.json({ limit: '2mb' })); // perf: 10mb let anyone POST huge bodies anywhere
EOF

# ─── fix: 404 before error handler (app.js) ──────────────────────────────────
cat > "$PATCH_DIR/p06.old" <<'EOF'
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
EOF
cat > "$PATCH_DIR/p06.new" <<'EOF'
// ── 404 (must come before the error handler) ────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Route not found' } });
});

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
EOF

# ─── perf-4: indexes (schema.prisma) ─────────────────────────────────────────
cat > "$PATCH_DIR/p07.old" <<'EOF'
  @@index([schoolId]) // NEW
  @@index([schoolId, subjectId, classId]) // NEW: dashboard queries
  @@map("lesson_notes")
EOF
cat > "$PATCH_DIR/p07.new" <<'EOF'
  @@index([schoolId]) // NEW
  @@index([schoolId, subjectId, classId]) // NEW: dashboard queries
  @@index([schoolId, teacherId, deletedAt]) // perf-4: GET /api/notes hot path
  @@map("lesson_notes")
EOF

cat > "$PATCH_DIR/p08.old" <<'EOF'
  @@index([schoolId]) // NEW: faster tenant-scoped queries
  @@map("users")
EOF
cat > "$PATCH_DIR/p08.new" <<'EOF'
  @@index([schoolId]) // NEW: faster tenant-scoped queries
  @@index([schoolId, role, revokedAt]) // perf-4: teacher list hot path
  @@map("users")
EOF

# ─── perf-5: createMany for question bank (assessment.routes.js) ─────────────
cat > "$PATCH_DIR/p09.old" <<'EOF'
    // Save each question to QuestionBankEntry (UUID fingerprint — no dedup in 3.3a)
    // batch-3-phase-3a-bank-save
    const questions = Array.isArray(aiResult.content.questions) ? aiResult.content.questions : [];
    const bankSavePromises = questions.map((q) =>
      prisma.questionBankEntry.create({
        data: {
          question:     q.question,
          options:      q.options || null,
          answer:       q.answer  || null,
          questionType,
          difficulty:   q.difficulty || diffVal,
          topic:        topic.trim(),
          fingerprint:  uuidv4(), // Phase 3.3b: replace with normalized hash
          waecAligned:  false,
          schoolId:     req.user.schoolId,
          subjectId:    subject.id,
        },
      }).catch((err) => {
        // Non-fatal: log and continue (bank save failure must not break the response)
        console.error('[bank-save] failed for one question:', err.message);
      })
    );
    await Promise.all(bankSavePromises);
EOF
cat > "$PATCH_DIR/p09.new" <<'EOF'
    // perf-5-createMany: one round trip instead of N inserts
    // batch-3-phase-3a-bank-save
    const questions = Array.isArray(aiResult.content.questions) ? aiResult.content.questions : [];
    try {
      await prisma.questionBankEntry.createMany({
        data: questions.map((q) => ({
          question:     q.question,
          options:      q.options || null,
          answer:       q.answer  || null,
          questionType,
          difficulty:   q.difficulty || diffVal,
          topic:        topic.trim(),
          fingerprint:  uuidv4(), // Phase 3.3b: replace with normalized hash
          waecAligned:  false,
          schoolId:     req.user.schoolId,
          subjectId:    subject.id,
        })),
        skipDuplicates: true,
      });
    } catch (err) {
      // Non-fatal: bank save failure must not break the response
      console.error('[bank-save] createMany failed:', err.message);
    }
EOF

cat > "$PATCH_DIR/p10.old" <<'EOF'
    await Promise.all(allQs.map(q =>
      prisma.questionBankEntry.create({
        data: {
          question:     q.question,
          options:      q.options || null,
          answer:       q.answer  || null,
          questionType: q.qType,
          difficulty:   q.difficulty || diffVal,
          topic:        q.topic || topics[0] || subject.name,
          fingerprint:  require('uuid').v4(),
          waecAligned:  false,
          schoolId:     req.user.schoolId,
          subjectId:    subject.id,
        },
      }).catch(e => console.error('[bank-save-eot] failed:', e.message))
    ));
EOF
cat > "$PATCH_DIR/p10.new" <<'EOF'
    // perf-5-createMany: one round trip instead of N inserts
    try {
      await prisma.questionBankEntry.createMany({
        data: allQs.map((q) => ({
          question:     q.question,
          options:      q.options || null,
          answer:       q.answer  || null,
          questionType: q.qType,
          difficulty:   q.difficulty || diffVal,
          topic:        q.topic || topics[0] || subject.name,
          fingerprint:  uuidv4(),
          waecAligned:  false,
          schoolId:     req.user.schoolId,
          subjectId:    subject.id,
        })),
        skipDuplicates: true,
      });
    } catch (e) {
      console.error('[bank-save-eot] createMany failed:', e.message);
    }
EOF

# ─── perf-6: report-card N+1 fix (report-card.routes.js, 3 patches) ──────────
cat > "$PATCH_DIR/p11.old" <<'EOF'
    const classSize = students.length;
    const generatedAt = new Date();

    // Build + persist one ReportCard per student (persist-before-respond).
    const saved = [];
    for (const s of students) {
EOF
cat > "$PATCH_DIR/p11.new" <<'EOF'
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
EOF

cat > "$PATCH_DIR/p12.old" <<'EOF'
      // ops-2-generate-fold: never overwrite a finalized (locked) card
      const existingCard = await prisma.reportCard.findUnique({
        where: { studentId_sessionId_term: { studentId: s.id, sessionId: session.id, term } },
        select: { id: true, studentId: true, term: true, pdfUrl: true, lockedAt: true, snapshot: true },
      });
      if (existingCard && existingCard.lockedAt) {
        saved.push(existingCard);
        continue;
      }
      const card = await prisma.reportCard.upsert({
EOF
cat > "$PATCH_DIR/p12.new" <<'EOF'
      // ops-2-generate-fold: never overwrite a finalized (locked) card
      const existingCard = existingByStudent[s.id]; // perf-6: map lookup, no query
      if (existingCard && existingCard.lockedAt) {
        saved.push(existingCard);
        continue;
      }
      upsertOps.push(prisma.reportCard.upsert({
EOF

cat > "$PATCH_DIR/p13.old" <<'EOF'
        select: {
          id: true, studentId: true, term: true, pdfUrl: true, lockedAt: true, snapshot: true,
        },
      });
      saved.push(card);
    }
EOF
cat > "$PATCH_DIR/p13.new" <<'EOF'
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
EOF

# ─── perf-7: fire-and-forget login-success audit (auth.controller.js) ────────
cat > "$PATCH_DIR/p14.old" <<'EOF'
    await recordAuthEvent('LOGIN_SUCCESS', { req, userId: user.id, email: user.email, schoolId: user.schoolId });
EOF
cat > "$PATCH_DIR/p14.new" <<'EOF'
    recordAuthEvent('LOGIN_SUCCESS', { req, userId: user.id, email: user.email, schoolId: user.schoolId }); // perf-7: fire-and-forget (helper never throws)
EOF

# ─── Manifest + apply (all-or-nothing) ───────────────────────────────────────
cat > "$PATCH_DIR/manifest.txt" <<EOF
src/lib/anthropic.js|p01
src/modules/teachers/teachers.controller.js|p02
src/modules/teachers/teachers.controller.js|p03
src/config/db.js|p04
src/app.js|p05
src/app.js|p06
prisma/schema.prisma|p07
prisma/schema.prisma|p08
src/modules/assessments/assessment.routes.js|p09
src/modules/assessments/assessment.routes.js|p10
src/modules/report-cards/report-card.routes.js|p11
src/modules/report-cards/report-card.routes.js|p12
src/modules/report-cards/report-card.routes.js|p13
src/modules/auth/auth.controller.js|p14
EOF

echo "==> Applying patches (verifies ALL before writing ANY)"
node "$PATCH_DIR/apply.js" "$PATCH_DIR/manifest.txt" "$PATCH_DIR"

# ─── perf-2: auth middleware with TTL user cache (full rewrite) ──────────────
echo "==> Writing src/middleware/auth.js (perf-2 TTL cache)"
cat > src/middleware/auth.js <<'AUTH_EOF'
// src/middleware/auth.js
//
// JWT authentication + role authorization.
//
// perf-2-auth-cache: the per-request user lookup is cached in-memory for 60s.
// Revocation / suspension / lockout still take effect within the TTL window,
// and revokeTeacher calls invalidateUserCache() for immediate effect.
// NOTE: in-memory cache assumes a single instance. If we ever scale to
// multiple instances, swap this for Redis.

const jwt = require('jsonwebtoken');
const prisma = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set in environment');
}

// ── perf-2: tiny TTL cache ──────────────────────────────────────────────────
const USER_CACHE_TTL_MS = 60_000;
const USER_CACHE_MAX    = 5_000; // hard cap so it can't grow unbounded
const userCache = new Map();     // userId → { user, expires }

function getCachedUser(userId) {
  const hit = userCache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.user;
  if (hit) userCache.delete(userId);
  return null;
}

function setCachedUser(userId, user) {
  if (userCache.size >= USER_CACHE_MAX) {
    // Drop the oldest entry (Map preserves insertion order)
    const oldest = userCache.keys().next().value;
    if (oldest !== undefined) userCache.delete(oldest);
  }
  userCache.set(userId, { user, expires: Date.now() + USER_CACHE_TTL_MS });
}

/** Force a user's next request to hit the DB (e.g. after revocation). */
function invalidateUserCache(userId) {
  userCache.delete(userId);
}

/**
 * Extracts the JWT from either:
 *   1. Authorization: Bearer <token>  (preferred)
 *   2. cookie: klassrun_token=<token> (set by Vercel route handler)
 */
function extractToken(req) {
  const authHeader = req.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  const cookieHeader = req.get('cookie');
  if (cookieHeader) {
    const match = cookieHeader.match(/klassrun_token=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

const authenticate = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({
        error: { message: 'Not authenticated' },
      });
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({
        error: { message: 'Invalid or expired session' },
      });
    }

    // perf-2: serve from cache when fresh; otherwise load + cache.
    let user = getCachedUser(payload.userId);
    if (!user) {
      user = await prisma.user.findUnique({
        where: { id: payload.userId },
        include: {
          school: { select: { id: true, name: true, status: true } },
        },
      });
      if (user) setCachedUser(payload.userId, user);
    }

    if (!user) {
      return res.status(401).json({
        error: { message: 'Account not found' },
      });
    }

    // Soft-deleted by school admin
    if (user.revokedAt) {
      return res.status(403).json({
        error: { message: 'Your access has been revoked. Please contact your school administrator.' },
      });
    }

    // School suspended by super admin
    if (user.school?.status === 'SUSPENDED') {
      return res.status(403).json({
        error: { message: 'This school has been suspended. Please contact Klassrun support.' },
      });
    }

    // Account temporarily locked due to failed login attempts
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      return res.status(423).json({
        error: { message: 'Account is temporarily locked due to too many failed attempts. Try again later.' },
      });
    }

    req.user = {
      id:         user.id,
      email:      user.email,
      firstName:  user.firstName,
      lastName:   user.lastName,
      role:       user.role,
      schoolId:   user.schoolId,
      schoolName: user.school?.name,
    };

    next();
  } catch (err) {
    next(err);
  }
};

const authorize = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: { message: 'Not authenticated' } });
  }
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({
      error: { message: `Forbidden — requires role: ${allowedRoles.join(' or ')}` },
    });
  }
  next();
};

module.exports = { authenticate, authorize, invalidateUserCache };
AUTH_EOF

# ─── Syntax checks ───────────────────────────────────────────────────────────
echo "==> Syntax-checking patched files"
for f in src/lib/anthropic.js src/middleware/auth.js src/modules/teachers/teachers.controller.js \
         src/config/db.js src/app.js \
         src/modules/assessments/assessment.routes.js \
         src/modules/report-cards/report-card.routes.js \
         src/modules/auth/auth.controller.js; do
  node --check "$f"
  echo "  ✓ $f"
done

# ─── package.json dependency fixes ───────────────────────────────────────────
echo "==> Fixing package.json dependencies"
npm uninstall bcrypt 2>/dev/null || true
npm install @prisma/client@7.8.0 --save-prod
npm install nodemon --save-dev
npm install prisma@7.8.0 --save-dev

# ─── Migration for the new indexes ───────────────────────────────────────────
echo "==> Creating + applying migration (local DB must be running)"
npx dotenv-cli -e .env.local -- npx prisma migrate dev --name perf_indexes

# ─── Git ─────────────────────────────────────────────────────────────────────
echo "==> Committing + pushing"
git add src/lib/anthropic.js src/middleware/auth.js \
        src/modules/teachers/teachers.controller.js src/config/db.js src/app.js \
        prisma/schema.prisma prisma/migrations \
        src/modules/assessments/assessment.routes.js \
        src/modules/report-cards/report-card.routes.js \
        src/modules/auth/auth.controller.js \
        package.json package-lock.json

git commit -m "perf: caching, N+1 fixes, indexes, dependency cleanup

- perf-1: Anthropic prompt caching on all generators (~90% system-prompt cost cut on hits)
- perf-2: 60s TTL cache in auth middleware (removes per-request DB round trip);
  revoke invalidates immediately
- perf-3: PrismaPg documented config + pool cap 5 (Neon limits)
- perf-4: indexes for GET /api/notes and teacher-list hot paths (+migration)
- perf-5: question-bank saves via createMany (1 round trip, was N)
- perf-6: report-card generate — prefetch existing cards + batched transaction
  (was 2N sequential queries per class)
- perf-7: login-success audit fire-and-forget
- fix: 404 handler before error handler; JSON body limit 10mb -> 2mb
- deps: @prisma/client -> dependencies, nodemon -> devDependencies,
  remove unused bcrypt, pin prisma CLI to 7.8.0"

git push origin main

echo ""
echo "✅ DONE. Render deploy triggered. Backups in $BACKUP"
echo "   Watch the Render build log for 'migrate deploy' applying perf_indexes."