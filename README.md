# Klassrun API

> Backend for **Klassrun** — the AI-powered school operating system for Nigerian schools.

REST API powering klassrun-app. Handles authentication, school onboarding, multi-tenant data isolation, AI generation (lesson notes + schemes of work via Anthropic), transactional email via Resend, and image hosting via Cloudinary. Paystack billing is wired but not yet collecting payments — every school is on a 14-day trial extended by manual SQL during early access.

---

## Table of contents

- [Overview](#overview)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Quick start (local dev)](#quick-start-local-dev)
- [Environment variables](#environment-variables)
- [Database](#database)
- [How requests flow](#how-requests-flow)
- [Auth & security model](#auth--security-model)
- [AI generation pipeline](#ai-generation-pipeline)
- [Audit logging](#audit-logging)
- [Multi-tenancy](#multi-tenancy)
- [Testing](#testing)
- [Deployment](#deployment)
- [Conventions](#conventions)
- [License](#license)

---

## Overview

Klassrun is a multi-tenant SaaS — every school operates in its own isolated data space, identified by a unique `slug`. The API enforces tenant isolation at the data layer: every per-school query includes `schoolId` from the JWT, so cross-tenant leaks are structurally impossible.

The API is one of three repositories. They communicate over REST with JWT bearer tokens:

| Repo | Domain | Hosting | Role |
|---|---|---|---|
| `klassrun-web` | klassrun.com | Cloudflare Pages | Marketing site |
| `klassrun-app` | app.klassrun.com | Vercel | School portal UI |
| **`klassrun-api`** _(this)_ | klassrun-api.onrender.com | Render | Backend, AI, email, image hosting |

---

## Tech stack

- **Runtime:** Node.js 22, Express 5
- **Database:** PostgreSQL 16, Prisma 7 ORM (with `@prisma/adapter-pg`)
- **Auth:** bcryptjs (cost 12), JWT (jsonwebtoken) — wrapped in `src/utils/jwt.js`, never call `jwt.sign` directly
- **AI:** Anthropic Claude (`@anthropic-ai/sdk`) — default model `claude-haiku-4-5-20251001`
- **Email:** Resend, with stub mode for local dev
- **Image hosting:** Cloudinary v2 SDK — signed uploads only
- **Security:** helmet, CORS allow-list with regex for school subdomains, audit logging

> Both `bcrypt` and `bcryptjs` appear in `package.json`. **All code uses `bcryptjs`** — `bcrypt` is an unused stray dependency. Don't introduce new `require('bcrypt')` calls.

---

## Project structure

```
klassrun-api/
├── prisma/
│   ├── schema.prisma          # Source of truth for the DB schema
│   ├── migrations/            # Generated migration history
│   └── seed.js                # Seeds reserved_slugs
│
├── src/
│   ├── server.js              # Entry point — Express on port 4000
│   ├── app.js                 # Middleware, CORS, route registration, errors
│   │
│   ├── config/
│   │   └── db.js              # Prisma client singleton — IMPORT THIS, never `new PrismaClient()`
│   │
│   ├── middleware/
│   │   └── auth.js            # JWT verification + role-based authorize()
│   │
│   ├── utils/
│   │   ├── jwt.js             # generateToken() — call instead of jwt.sign
│   │   └── slug.js            # Slug generation, validation, availability
│   │
│   ├── lib/
│   │   ├── anthropic.js       # Anthropic SDK wrapper + AI prompts (lesson notes + schemes)
│   │   ├── billing-gate.js    # checkGenerationAllowed() — 402 when trial expired
│   │   ├── email.js           # Resend wrapper with stub mode
│   │   ├── audit.js           # recordAuthEvent + recordAcademicEvent
│   │   ├── cloudinary.js      # Signed upload helpers
│   │   └── email-templates/
│   │       ├── welcome.js
│   │       └── invite.js
│   │
│   └── modules/
│       ├── auth/              # signup, login, invite, accept, me, password reset
│       ├── slug/              # check, suggest, generate
│       ├── schools/           # School details, settings, logo upload
│       ├── sessions/          # Academic sessions + terms
│       ├── classes/           # Classes CRUD + archive
│       ├── subjects/          # Subjects CRUD + teacher assignment
│       ├── teachers/          # SCHOOL_ADMIN-gated teacher list + teachers-self (TEACHER /me)
│       ├── notes/             # AI lesson notes (POST /generate, CRUD)
│       ├── schemes/           # AI schemes of work (POST /generate, CRUD)
│       ├── assessments/       # Exam questions — placeholder, AI gen coming in Phase 3.3
│       └── curriculum/        # NERDC curriculum browser
│
├── scripts/
│   ├── seed-super-admin.js    # ENV-based super admin seeder
│   ├── test-slug.js
│   └── test-auth.js
│
├── prisma.config.ts           # Prisma 7 config pattern
├── .env.example
├── package.json
└── README.md
```

---

## Quick start (local dev)

### Prerequisites

- Node 20+ (production runs on 22), npm 10+
- PostgreSQL 15+ running locally on port 5432

### 1. Install dependencies

```bash
npm install
```

This auto-runs `prisma generate` via the `postinstall` hook.

### 2. Create the database

```bash
psql -U postgres -c "CREATE DATABASE klassrun_db;"
```

### 3. Configure `.env`

```bash
cp .env.example .env
```

Edit `.env` and fill in:

- `DATABASE_URL` — your local Postgres connection string
- `JWT_SECRET` — generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

You can leave AI/payment keys blank for non-AI work. The AI endpoints will return a clean 503 if `ANTHROPIC_API_KEY` is missing.

### 4. Run migrations

```bash
npx prisma migrate dev
```

### 5. Seed reserved slugs

```bash
npm run db:seed
```

### 6. Seed your SUPER_ADMIN

```bash
# Add to .env first:
# SUPER_ADMIN_EMAIL=you@klassrun.com
# SUPER_ADMIN_PASSWORD=use-a-password-manager
# SUPER_ADMIN_FIRST_NAME=Your
# SUPER_ADMIN_LAST_NAME=Name

npm run db:seed:super-admin
```

### 7. Start the server

```bash
npm run dev
```

Verify:

```bash
curl http://localhost:4000/api/health
# {"status":"ok","service":"klassrun-api","timestamp":"..."}
```

### 8. Run the auth tests

In a second terminal:

```bash
npm run test:auth
```

Expected: 30+ ✓ passes.

---

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string. Local dev: pointed at localhost. Production: Neon pooled URL (with `-pooler`). |
| `JWT_SECRET` | ✅ | — | Secret for signing JWTs (32-byte random hex) |
| `JWT_EXPIRES_IN` | | `7d` | Token TTL |
| `PORT` | | `4000` | Listen port |
| `NODE_ENV` | | `development` | `development` or `production` |
| `FRONTEND_URL` | | `http://localhost:3000` | Used to build invite/portal links. Production: `https://app.klassrun.com` |
| `ALLOWED_ORIGINS` | | sensible defaults | Comma-separated CORS allow-list. Subdomains of klassrun.com are auto-allowed via regex in `app.js`. |
| `PORTAL_BASE_DOMAIN` | | `klassrun.com` | Used to build portal URLs |
| `RESEND_API_KEY` | prod only | — | If missing, email module runs in **stub mode** (logs to console). |
| `EMAIL_FROM` | | `Klassrun <info@klassrun.com>` | Default sender |
| `EMAIL_REPLY_TO` | | `info@klassrun.com` | Default reply-to |
| `SUPER_ADMIN_EMAIL` | for seeding | — | Used by `db:seed:super-admin` |
| `SUPER_ADMIN_PASSWORD` | for seeding | — | Same |
| `SUPER_ADMIN_FIRST_NAME` | for seeding | — | Same |
| `SUPER_ADMIN_LAST_NAME` | for seeding | — | Same |
| `ANTHROPIC_API_KEY` | for AI | — | Anthropic Claude API key. AI endpoints 503 without it. |
| `ANTHROPIC_MODEL` | | `claude-haiku-4-5-20251001` | Override Anthropic model |
| `CLOUDINARY_CLOUD_NAME` | for logo upload | — | Cloudinary account name |
| `CLOUDINARY_API_KEY` | for logo upload | — | Cloudinary key |
| `CLOUDINARY_API_SECRET` | for logo upload | — | Cloudinary secret |
| `CLOUDINARY_UPLOAD_PRESET` | for logo upload | — | Preset name (must match Cloudinary console) |
| `PAYSTACK_SECRET_KEY` | for billing | — | Wired but not yet collecting payments |

---

## Database

The full schema lives in `prisma/schema.prisma`. **Tables are plural snake_case** via `@@map` directives (`users`, `schools`, `lesson_notes`, `schemes_of_work`, etc.); **columns are camelCase** (`schoolId`, `trialEndsAt`).

When writing raw SQL: lowercase plural table names without quotes, camelCase columns WITH double quotes. Example:

```sql
UPDATE subscriptions SET "trialEndsAt" = NOW() + INTERVAL '14 days' WHERE "schoolId" = '...';
```

**Tenant tables** (per-school, scoped by `schoolId`):

`schools`, `users`, `academic_sessions`, `classes`, `subjects`, `lesson_notes`, `schemes_of_work`, `assessments`, `question_bank`, `subscriptions`, `academic_events`

**Shared tables** (not per-school):

`curriculum_topics`, `reserved_slugs`, `auth_events`, `password_reset_tokens`

### Migrations

```bash
# After editing schema.prisma:
npx prisma migrate dev --name <descriptive-name>

# Apply migrations to production (Neon):
# 1. Swap .env to point at Neon DIRECT URL (not pooled)
# 2. npx prisma migrate deploy
# 3. Swap .env back to localhost
```

> **Nigerian-ISP fallback:** Some Nigerian ISPs (notably MTN) intermittently block outbound TCP 5432. If `prisma migrate deploy` fails with P1001, apply the migration manually via the Neon SQL Editor and record it in `_prisma_migrations` yourself. See `KLASSRUN_CONTEXT.md` for the exact SQL.

### Seeds

```bash
npm run db:seed              # Reserved slugs
npm run db:seed:super-admin  # Platform-wide admin user (you)
```

### Inspect

```bash
npm run db:studio
```

---

## How requests flow

```
Browser
   │  user action (e.g. "generate scheme of work")
   ▼
klassrun-app (Vercel)
   │  fetch('/api/schemes/generate', { ... })
   ▼
Next.js Route Handler in klassrun-app
   │  reads klassrun_auth cookie → forwards as Bearer token
   ▼
klassrun-api  ← this repo
   │  authenticate() middleware verifies JWT
   │  authorize('TEACHER') checks role
   │  billing-gate checks subscription status (402 if expired)
   │  validate inputs → fetch from DB scoped by schoolId
   │  call Anthropic via src/lib/anthropic.js
   │  persist to DB BEFORE responding (so user always has a record)
   │  fire-and-forget audit log via recordAcademicEvent
   ▼
Response → app → browser
```

The browser **never** talks to klassrun-api directly. All traffic flows through klassrun-app's Route Handlers, which store the JWT in an httpOnly cookie (`klassrun_auth`) the browser can't read.

---

## Auth & security model

- **Passwords:** bcryptjs with cost 12. Minimum 8 characters.
- **JWT:** signed with `JWT_SECRET`, 7-day TTL by default. Payload includes `userId`, `role`, `schoolId`. Generated via `src/utils/jwt.js` exporting `generateToken(userId, role)` — call this, never `jwt.sign` directly.
- **Tenant isolation:** every per-school query includes `schoolId` from `req.user.schoolId`. Enforced at handler level today.
- **Invite tokens:** 256-bit random, expire after 7 days, single-use. Acceptance requires email confirmation to prevent link sharing. Token rotates on resend.
- **Account lockout:** 5 failed logins → 15-minute lock. Audit-logged as `ACCOUNT_LOCKED`.
- **Login responses:** identical for unknown email, inactive account, and wrong password — never leak which exists.
- **PATCH endpoints:** use **explicit allowlist validation**. When adding a new editable field, remember to extend the allowlist in the handler.
- **Soft-delete only:** `revokedAt`, `suspendedAt`, `archivedAt`, `deletedAt`. Never hard-delete.

---

## AI generation pipeline

The AI lives in `src/lib/anthropic.js`. Two generators ship:

- `generateLessonNote(params)` — Phase 3.1 + 3.1.5
- `generateSchemeOfWork(params)` — Phase 3.2

Both share a private `_callAnthropicWithSystem()` helper. Both throw structured errors with a `.code` field consumers can switch on:

| Code | HTTP equivalent | Meaning |
|---|---|---|
| `NO_API_KEY` | 503 | `ANTHROPIC_API_KEY` not set |
| `AI_REFUSED` | 422 | Model returned the refusal sentinel |
| `AI_ERROR_OBJECT` | 422 | Model returned `{"error": "..."}` |
| `AI_TRUNCATED` | 422 | Output hit `max_tokens` — raise the cap or split the request |
| `AI_TRANSIENT` | 503 | Anthropic 429/529 — retry in a minute |
| `AI_PERMANENT` | 503 | Anthropic 400/401/403 — config issue, needs human |
| `AI_MALFORMED` | 503 | JSON.parse failed twice |
| `AI_INVALID` | 503 | JSON parsed but missing required fields |
| `AI_API_ERROR` | 503 | Anything else from the Anthropic SDK |

**Locked pipeline rules:**

1. Billing gate first → validate inputs → authorize → call AI → persist BEFORE responding → fire-and-forget audit log → return persisted record.
2. AI generation is **TEACHER-only**. SCHOOL_ADMIN can view but not generate.
3. Cost telemetry stored inline: `{model, inputTokens, outputTokens, generatedAt}` lives in `<entity>.content._metadata`.
4. **No server-side retries on permanent errors or validation failures.** Same prompt + same model = same failure. Throw immediately, save the cost.
5. Generation is batch (not streaming) for V1.

---

## Audit logging

Two streams: `auth_events` (login, invite, password reset, account lockout, etc.) and `academic_events` (sessions, classes, subjects, AI generations).

Both tables are **durable** — no FK relations on the user/school columns. If a user is deleted, the audit row stays.

Writes are **best-effort** — failures log to console but never break user-facing requests.

Use the helpers in `src/lib/audit.js`:

```js
const { recordAuthEvent, recordAcademicEvent } = require('../../lib/audit')

recordAuthEvent('LOGIN_SUCCESS', { req, userId: user.id })
recordAcademicEvent('SCHEME_GENERATED', {
  schoolId: req.user.schoolId,
  actorId:  req.user.id,
  metadata: { schemeId, subjectId, classId, model, inputTokens, outputTokens },
})
```

Use `req.user.id` (not `req.user.userId`) when passing actorId.

To inspect:

```bash
npm run db:studio
# Open auth_events or academic_events
```

---

## Multi-tenancy

Each school is identified by a unique `slug`. The slug doubles as the future subdomain (`{slug}.klassrun.com`). Subdomain provisioning hooks exist but are disabled — all schools currently land on `app.klassrun.com/dashboard` and the app routes based on the user's `schoolId` from the JWT.

Slug rules:
- 3–40 chars, lowercase + digits + hyphens
- No leading/trailing/consecutive hyphens
- Must not appear in `reserved_slugs`
- Must be unique across all schools
- Locked after 30 days of activity (`School.slugLockedAt`)

The slug utility (`src/utils/slug.js`) handles generation, validation, availability checking, and suggestion of alternatives. Use `slugUtil.buildPortalUrl(slug)` to build portal URLs — never construct them inline.

---

## Testing

```bash
npm run test:slug   # Slug utility (no server required)
npm run test:auth   # Full auth flow (requires npm run dev in another terminal)
```

The auth test creates a school + teacher with timestamped emails, so it's safe to run repeatedly without cleanup.

---

## Deployment

Production: **Render** (free tier — sleeps after 15 min of inactivity, upgrade to Starter $7/mo once paid customers arrive).

Auto-deploys from the `main` branch on GitHub push. Build takes ~3-5 minutes.

Production environment is configured on the Render dashboard. After any push that needs new env vars, set them on Render *before* the deploy lands or the server boots in a broken state.

Database: **Neon** (Postgres 16 on free tier). Two URLs — pooled (used by the running server) and DIRECT (used only for `prisma migrate deploy`).

---

## Conventions

- **Inline-handler style** for newer route modules (sessions, classes, subjects, notes, schemes). Older modules have separate controller/service files — match the style already in the module you're editing.
- **Shared Prisma singleton:** `const prisma = require('../../config/db')`. **Never** `new PrismaClient()` in a route file.
- **Error responses** always have shape `{ error: { message: string, field?: string } }`. On Prisma P2002, return 409 with `field` set.
- **PATCH allowlists** are explicit. Adding an editable field? Extend the allowlist in the handler.
- **Dual-mount Express routers** for resources with both nested and id-direct addressing (`/api/classes/:classId/subjects` AND `/api/subjects`). Use `mergeParams: true`.
- **Self-vs-admin router split** when endpoint role gates differ (e.g. `teachers-self.routes.js` mounted at `/api/teachers/me` for TEACHER access, separate from `teachers.routes.js` at `/api/teachers` for SCHOOL_ADMIN access).
- **Compound `@@index([schoolId, archivedAt])`** on every new soft-deletable model.
- **Atomic invariants** via `prisma.$transaction` (e.g. "only one current session per school").

---

## License

UNLICENSED — © Klassrun Technologies Ltd. All rights reserved.

---

## Contact

- **Website:** [klassrun.com](https://klassrun.com)
- **Email:** info@klassrun.com
- **Company:** Klassrun Technologies Ltd · RC 9463863 · Lagos, Nigeria
