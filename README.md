# Klassrun API

> Backend for **Klassrun** — the AI-powered school operating system for Nigerian schools.

[![Node](https://img.shields.io/badge/node-%3E%3D20-3DB54A)](https://nodejs.org/)
[![Prisma](https://img.shields.io/badge/Prisma-7-1A2332)](https://www.prisma.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-336791)](https://www.postgresql.org/)
[![License](https://img.shields.io/badge/license-UNLICENSED-red)](#license)

REST API powering klassrun-app. Handles authentication, school onboarding,
multi-tenant data isolation, AI generation (coming), Paystack billing
(coming), and transactional email via Resend.

---

## Table of contents

- [Overview](#overview)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Database](#database)
- [API reference](#api-reference)
  - [Auth endpoints](#auth-endpoints)
  - [Slug endpoints](#slug-endpoints)
- [Auth & security model](#auth--security-model)
- [Email](#email)
- [Audit logging](#audit-logging)
- [Multi-tenancy](#multi-tenancy)
- [Testing](#testing)
- [Deployment](#deployment)
- [License](#license)

---

## Overview

Klassrun is a multi-tenant SaaS — every school operates in their own isolated
data space, identified by a unique `slug`. The API enforces tenant isolation
at the data layer (every per-school query scoped by `schoolId`), so cross-tenant
leaks are structurally impossible.

The API ships in three pieces:

| Repo | Domain | Role |
|---|---|---|
| `klassrun-web` | klassrun.com | Marketing |
| `klassrun-app` | app.klassrun.com | School portal UI |
| **`klassrun-api`** _(this)_ | api.klassrun.com | Backend, AI, billing, email |

All three communicate via REST + JWT bearer tokens.

---

## Tech stack

- **Runtime:** Node.js 20+, Express 5
- **Database:** PostgreSQL 15+, Prisma 7 ORM
- **Auth:** bcryptjs (cost 12), JWT (jsonwebtoken)
- **Email:** Resend (with stub mode for dev)
- **Security:** helmet, CORS allow-list, audit logging
- **External integrations:** Anthropic Claude (coming), Paystack (coming), Vercel API (later)

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
│   │   └── db.js              # Prisma client singleton (PrismaPg adapter)
│   │
│   ├── middleware/
│   │   └── auth.js            # JWT verification + role-based authz
│   │
│   ├── utils/
│   │   ├── jwt.js             # Token generation
│   │   └── slug.js            # Slug generation, validation, availability
│   │
│   ├── lib/
│   │   ├── email.js           # Resend wrapper with stub mode
│   │   ├── audit.js           # Audit log helper
│   │   └── email-templates/
│   │       ├── welcome.js     # Sent on signup
│   │       └── invite.js      # Sent when admins invite teachers
│   │
│   ├── modules/
│   │   ├── auth/              # signup, login, invite, accept, me
│   │   ├── slug/              # check, suggest, generate
│   │   ├── schools/           # School details, classes, stats
│   │   ├── notes/             # Lesson notes (AI generation upcoming)
│   │   ├── assessments/       # Assessments (AI generation upcoming)
│   │   └── curriculum/        # NERDC curriculum browser
│   │
│   └── ai/                    # Anthropic integration (upcoming)
│
├── docs/
│   ├── schema.md              # ERD + multi-tenancy concepts
│   └── architecture.md        # System architecture diagrams
│
├── scripts/
│   ├── seed-super-admin.js    # ENV-based super admin seeder
│   ├── test-slug.js           # Slug utility tests
│   └── test-auth.js           # End-to-end auth flow tests
│
├── prisma.config.ts
├── .env.example
├── package.json
└── README.md
```

---

## Quick start

### Prerequisites

- Node 20+, PostgreSQL 15+, npm 10+

### 1. Install dependencies

```bash
npm install
```

### 2. Create the database

```sql
CREATE DATABASE klassrun_db;
```

### 3. Configure `.env`

```bash
cp .env.example .env
```

Fill in `DATABASE_URL` and generate a strong `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Run migrations

```bash
npx prisma migrate dev
```

### 5. Seed reserved slugs

```bash
npm run db:seed
```

### 6. Seed your SUPER_ADMIN

Add to `.env`:

```bash
SUPER_ADMIN_EMAIL=you@klassrun.com
SUPER_ADMIN_PASSWORD=use-a-password-manager-min-16-chars
SUPER_ADMIN_FIRST_NAME=Your
SUPER_ADMIN_LAST_NAME=Name
```

Then run:

```bash
npm run db:seed:super-admin
```

### 7. Start the server

```bash
npm run dev
```

Verify: `curl http://localhost:4000/api/health` should return `{"status":"ok"...}`.

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
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `JWT_SECRET` | ✅ | — | Secret for signing JWTs (32-byte random) |
| `JWT_EXPIRES_IN` | | `7d` | Token TTL |
| `PORT` | | `4000` | Listen port |
| `NODE_ENV` | | `development` | `development` or `production` |
| `FRONTEND_URL` | | `http://localhost:3000` | Used to build invite/portal links |
| `ALLOWED_ORIGINS` | | (sensible defaults) | Comma-separated CORS allow-list |
| `PORTAL_BASE_DOMAIN` | | `klassrun.com` | Used to build portal URLs in production |
| `RESEND_API_KEY` | prod only | — | Resend API key. Empty = stub mode |
| `EMAIL_FROM` | | `Klassrun <info@klassrun.com>` | Default sender |
| `EMAIL_REPLY_TO` | | `info@klassrun.com` | Default reply-to |
| `SUPER_ADMIN_*` | for seeding | — | See `seed-super-admin.js` |
| `ANTHROPIC_API_KEY` | for AI | — | Claude API (coming) |
| `PAYSTACK_SECRET_KEY` | for billing | — | Paystack (coming) |

---

## Database

The full schema lives in `prisma/schema.prisma`. ERD + concepts in
[`docs/schema.md`](docs/schema.md).

**Tenant tables** (per-school, scoped by `schoolId`):

`schools`, `users`, `academic_sessions`, `classes`, `subjects`,
`lesson_notes`, `assessments`, `question_bank`, `subscriptions`

**Shared tables** (not per-school):

`curriculum_topics`, `reserved_slugs`, `auth_events`

### Migrations

```bash
# After editing schema.prisma:
npx prisma migrate dev --name <descriptive-name>

# Reset dev DB completely:
npx prisma migrate reset
```

### Seeds

```bash
npm run db:seed              # Reserved slugs
npm run db:seed:super-admin  # Platform-wide admin user (you)
```

---

## API reference

All endpoints return JSON. Errors have shape `{ error: { message: string, field?: string } }`.

Authenticated endpoints expect `Authorization: Bearer <token>`.

### Auth endpoints

#### `POST /api/auth/signup`

Create a school + initial school admin + 14-day trial. Returns JWT.

Body:
```json
{
  "email": "principal@school.com",
  "password": "minimum-8-characters",
  "firstName": "Adegbite",
  "lastName": "Mohammed",
  "schoolName": "Greenfield Academy",
  "schoolState": "Lagos",
  "schoolAddress": "(optional)",
  "slug": "(optional — auto-generated if omitted)"
}
```

Response (201):
```json
{
  "message": "Account created successfully",
  "token": "eyJhbGc...",
  "user": { "id": "...", "schoolSlug": "greenfield-academy", "..." },
  "portalUrl": "https://app.klassrun.com/dashboard",
  "trialEndsAt": "2026-05-19T..."
}
```

#### `POST /api/auth/login`

Standard email/password login.

#### `GET /api/auth/me`

Returns current user + school context. Requires JWT.

#### `POST /api/auth/invite`

School admin invites a teacher. Generates a 7-day token and emails the
teacher. Audit-logged. Requires JWT + `SCHOOL_ADMIN` role.

#### `POST /api/auth/invite/resend/:teacherId`

Generates a new token (invalidating the old one) and resends the invite.
Requires JWT + `SCHOOL_ADMIN`.

#### `POST /api/auth/invite/:token/accept`

Teacher accepts invitation. Requires the recipient to confirm their email
address — protects against link sharing.

Body:
```json
{
  "password": "minimum-8-characters",
  "email": "must-match-invitation@school.com"
}
```

Failure modes (all audit-logged):
- 404 — token doesn't exist
- 400 — already accepted, or expired
- 403 — email doesn't match the invitation

### Slug endpoints

Public (no auth).

#### `GET /api/slug/check?slug=<slug>`

Returns `{ available: bool, error: string|null }`.

#### `GET /api/slug/suggest?name=<name>&state=<state>&limit=<n>`

Returns `{ suggestions: string[] }` — up to N available slug ideas.

#### `GET /api/slug/generate?name=<name>`

Pure transform. Returns `{ slug, valid, error }`. No DB lookup.

---

## Auth & security model

- **Passwords:** bcrypt with cost 12. Minimum 8 characters enforced.
- **JWT:** signed with `JWT_SECRET`, 7-day TTL by default. Carries
  `userId`, `role`, `schoolId`. Verified on every authenticated request.
- **Tenant isolation:** every per-school query includes `schoolId` from
  the JWT. Enforced at controller level today; will move to a scoped
  Prisma client middleware in a follow-up.
- **Invite tokens:** 256-bit random, expire after 7 days, single-use.
  Acceptance requires email confirmation to prevent link sharing.
  Token rotation on resend.
- **Login responses:** identical for unknown email, inactive account, and
  wrong password. Doesn't leak which exists.
- **Rate limiting:** TODO — to be added in a follow-up. For now relies on
  Cloudflare's edge rate limiting.

---

## Email

Resend is the email provider. The wrapper at `src/lib/email.js` includes
**stub mode**: if `RESEND_API_KEY` is missing, emails are logged to the
console instead of sent. This lets devs run locally without credentials.

In production, the absence of `RESEND_API_KEY` triggers a loud warning at
startup — set the key on Railway.

Templates live in `src/lib/email-templates/`. Each template exports a
function that returns `{ subject, html }`. Add new templates following
the same shape.

---

## Audit logging

Security-sensitive events are written to the `auth_events` table:

- `SIGNUP_SUCCESS`
- `LOGIN_SUCCESS`
- `LOGIN_FAILED` (with reason: `unknown_email`, `inactive`, `wrong_password`)
- `INVITE_SENT`
- `INVITE_RESENT`
- `INVITE_ACCEPTED`
- `INVITE_FAILED` (with reason: `unknown_token`, `already_accepted`, `expired`, `email_mismatch`)
- `SUPER_ADMIN_SEEDED`

Each row records the timestamp, IP address, user agent, and freeform
`metadata` JSON. Audit log writes are best-effort — failures are logged
to console but never break user-facing requests.

To inspect:

```bash
npm run db:studio
# Open auth_events table
```

---

## Multi-tenancy

Each school is identified by a unique `slug` mapping to a future subdomain
(`{slug}.klassrun.com`). Currently all schools land on `app.klassrun.com/dashboard`
— per-school subdomains are deferred until we hit Vercel Pro (or migrate
to Cloudflare Pages with custom domains).

Slug rules:
- 3–40 chars, lowercase + digits + hyphens, no leading/trailing/consecutive hyphens
- Must not appear in `reserved_slugs` (system-protected names)
- Must be unique across all schools

The slug utility (`src/utils/slug.js`) handles generation from school names,
validation, availability checking, and suggestion of alternatives.

---

## Testing

```bash
npm run test:slug   # Slug utility (16 tests, no server required)
npm run test:auth   # Full auth flow (30+ tests, server must be running)
```

The auth test creates a real school and teacher in your dev database with
unique timestamps, so it's safe to run repeatedly without cleanup.

---

## Deployment

Production target: **Railway** (API + PostgreSQL). See
[`SETUP_GUIDE.md`](../SETUP_GUIDE.md) section 9 for step-by-step.

---

## License

UNLICENSED — © Klassrun Technologies Ltd. All rights reserved.

---

## Contact

- **Website:** [klassrun.com](https://klassrun.com)
- **Email:** info@klassrun.com
- **Company:** Klassrun Technologies Ltd · RC 9463863 · Lagos, Nigeria
