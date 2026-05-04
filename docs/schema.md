# Klassrun Database Schema

This document is the visual reference for the Klassrun PostgreSQL schema.
It is generated from and stays aligned with `prisma/schema.prisma`.

When the schema changes, **update this file in the same PR**.

---

## Entity-Relationship Diagram

```mermaid
erDiagram
    School ||--o{ User : "employs"
    School ||--o{ Class : "has"
    School ||--o{ Subject : "offers"
    School ||--o{ AcademicSession : "tracks"
    School ||--o{ LessonNote : "owns"
    School ||--o{ Assessment : "owns"
    School ||--o{ QuestionBankEntry : "owns"
    School ||--o| Subscription : "has"

    Class ||--o{ Subject : "contains"
    Class ||--o{ LessonNote : "for"
    Class ||--o{ Assessment : "for"

    Subject ||--o{ LessonNote : "for"
    Subject ||--o{ Assessment : "for"
    Subject ||--o{ QuestionBankEntry : "categorizes"

    User ||--o{ LessonNote : "creates"
    User ||--o{ Assessment : "creates"

    AcademicSession ||--o{ LessonNote : "stamped"
    AcademicSession ||--o{ Assessment : "stamped"

    School {
        string id PK
        string name
        string slug UK "subdomain"
        string customDomain UK "future white-label"
        SchoolStatus status
        datetime slugLockedAt
        string address
        string state
        string logoUrl
        string rcNumber
        datetime createdAt
        datetime updatedAt
    }

    User {
        string id PK
        string email UK
        string password
        string firstName
        string lastName
        Role role
        boolean isActive
        string inviteToken UK
        boolean inviteAccepted
        string schoolId FK "nullable for SUPER_ADMIN"
        datetime createdAt
        datetime updatedAt
    }

    AcademicSession {
        string id PK
        string name "2025/2026"
        SessionTerm currentTerm
        boolean isCurrent
        string schoolId FK
        datetime createdAt
    }

    Class {
        string id PK
        string name "JSS 1, SS 2"
        string level "junior or senior"
        string schoolId FK
        datetime createdAt
    }

    Subject {
        string id PK
        string name "Mathematics"
        string schoolId FK
        string classId FK
        string teacherId
        datetime createdAt
    }

    LessonNote {
        string id PK
        string topic
        int week
        json content
        ContentType contentType
        string sessionStamp
        string pdfUrl
        boolean isEdited
        json editHistory
        string schoolId FK
        string teacherId FK
        string classId FK
        string subjectId FK
        string sessionId FK
        datetime createdAt
        datetime updatedAt
    }

    Assessment {
        string id PK
        string title
        json questions
        int totalMarks
        int duration
        ContentType contentType
        string sessionStamp
        string pdfUrl
        json usedQuestionIds "deduplication"
        string schoolId FK
        string teacherId FK
        string classId FK
        string subjectId FK
        string sessionId FK
        datetime createdAt
        datetime updatedAt
    }

    QuestionBankEntry {
        string id PK
        string question
        json options
        string answer
        string questionType
        string difficulty
        string topic
        boolean waecAligned
        string fingerprint "dedup hash"
        int timesUsed
        datetime lastUsedAt
        string schoolId FK
        string subjectId FK
        datetime createdAt
    }

    Subscription {
        string id PK
        string plan "starter, standard, premium"
        SubscriptionStatus status
        datetime startDate
        datetime endDate
        datetime trialEndsAt "14-day trial"
        string paystackSubId
        string paystackCustId
        string schoolId FK_UK
        datetime createdAt
        datetime updatedAt
    }

    CurriculumTopic {
        string id PK
        string subject
        string className
        SessionTerm term
        int week
        string topic
        json subtopics
        json objectives
        string source "NERDC, WAEC"
    }

    ReservedSlug {
        string slug PK
        string reason
        datetime createdAt
    }
```

---

## Key concepts

### Multi-tenancy

Every per-school table has a `schoolId` foreign key. **All queries must scope by
`schoolId`.** This is enforced at the data layer via the scoped Prisma client
(see `src/lib/db.js`) — never write a raw query that omits the school context.

The `School.slug` field maps to the subdomain at which the school operates:

- `greenfield-academy` → `greenfield-academy.klassrun.com`
- `sunrise-school`     → `sunrise-school.klassrun.com`

### Shared data (not per-school)

Two models live outside the per-school scope:

- **`CurriculumTopic`** — the NERDC/WAEC curriculum is universal. Every school
  reads from the same curriculum data; no school can modify it.
- **`ReservedSlug`** — system-level allow/deny list for subdomain claims.
  Seeded by `prisma/seed.js` and managed by super admins only.

### Question bank deduplication

Every `QuestionBankEntry` has a `fingerprint` (a normalized hash of the
question content). The compound unique constraint `[schoolId, fingerprint]`
guarantees a school cannot accidentally store the same question twice. When
generating a new exam, query for questions with `timesUsed > 0` to filter out
already-used questions.

### Subscription and trial flow

A new school is created with:

- `School.status = PROVISIONING` (until the Vercel subdomain is ready)
- `Subscription.status = TRIAL`
- `Subscription.trialEndsAt = now() + 14 days`
- `Subscription.endDate = trialEndsAt` (initially)

When the trial ends without payment:

- `Subscription.status = EXPIRED`
- `School.status = EXPIRED`
- Middleware in klassrun-app redirects to a billing page

### Slug locking

After 30 days of school activity, `School.slugLockedAt` is set. Any future
slug change requires super admin approval — this protects URLs already in
WhatsApp groups, parent emails, printed materials, etc.

---

## Indexes

Indexes are added on every `schoolId` column to keep tenant-scoped queries
fast. Compound indexes exist for common dashboard patterns:

| Table | Compound Index | Used by |
|---|---|---|
| `lesson_notes` | `(schoolId, subjectId, classId)` | Teacher dashboard "my notes" view |
| `question_bank` | `(schoolId, subjectId, topic)` | Question bank filtering |

---

## Updating this document

When you change `schema.prisma`:

1. Update the Mermaid block above
2. Update the "Key concepts" section if a new pattern is introduced
3. Update the "Indexes" table if you add new compound indexes
4. Commit both changes in the same PR

This stays as a manually-maintained document for now. When the team grows
beyond 3 engineers, switch to `prisma-erd-generator` for auto-generation.
