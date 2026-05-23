-- batch-3-phase-2-scheme-of-work
--
-- 1. Enum extensions (idempotent — Postgres natively supports IF NOT EXISTS here).
-- 2. New schemes_of_work table + indexes + FKs.

ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'SCHEME_GENERATED';
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'SCHEME_EDITED';
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'SCHEME_DISCARDED';

CREATE TABLE IF NOT EXISTS "schemes_of_work" (
  "id"           TEXT PRIMARY KEY,
  "title"        TEXT NOT NULL,
  "content"      JSONB NOT NULL,
  "contentType"  "ContentType" NOT NULL DEFAULT 'SCHEME_OF_WORK',
  "sessionStamp" TEXT NOT NULL,
  "pdfUrl"       TEXT,
  "isEdited"     BOOLEAN NOT NULL DEFAULT false,
  "editHistory"  JSONB,
  "deletedAt"    TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  "schoolId"     TEXT NOT NULL,
  "teacherId"    TEXT NOT NULL,
  "classId"      TEXT NOT NULL,
  "subjectId"    TEXT NOT NULL,
  "sessionId"    TEXT NOT NULL,
  CONSTRAINT "schemes_of_work_schoolId_fkey"  FOREIGN KEY ("schoolId")  REFERENCES "schools"("id")           ON DELETE CASCADE,
  CONSTRAINT "schemes_of_work_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "users"("id"),
  CONSTRAINT "schemes_of_work_classId_fkey"   FOREIGN KEY ("classId")   REFERENCES "classes"("id"),
  CONSTRAINT "schemes_of_work_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id"),
  CONSTRAINT "schemes_of_work_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "academic_sessions"("id")
);

CREATE INDEX IF NOT EXISTS "schemes_of_work_schoolId_idx"                   ON "schemes_of_work"("schoolId");
CREATE INDEX IF NOT EXISTS "schemes_of_work_schoolId_subjectId_classId_idx" ON "schemes_of_work"("schoolId", "subjectId", "classId");
CREATE INDEX IF NOT EXISTS "schemes_of_work_schoolId_deletedAt_idx"         ON "schemes_of_work"("schoolId", "deletedAt");
