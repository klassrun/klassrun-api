-- batch-2c-phase-1
-- Adds startDate/endDate/updatedAt to academic_sessions
-- Creates AcademicEventType enum and academic_events table

ALTER TABLE "academic_sessions" ADD COLUMN "startDate" TIMESTAMP(3);
ALTER TABLE "academic_sessions" ADD COLUMN "endDate" TIMESTAMP(3);
ALTER TABLE "academic_sessions" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "academic_sessions" SET "updatedAt" = "createdAt";

CREATE TYPE "AcademicEventType" AS ENUM (
  'SESSION_CREATED',
  'SESSION_MADE_CURRENT',
  'TERM_ADVANCED'
);

CREATE TABLE "academic_events" (
  "id" TEXT NOT NULL,
  "type" "AcademicEventType" NOT NULL,
  "schoolId" TEXT NOT NULL,
  "actorId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "academic_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "academic_events_schoolId_idx" ON "academic_events"("schoolId");
CREATE INDEX "academic_events_type_idx" ON "academic_events"("type");
CREATE INDEX "academic_events_createdAt_idx" ON "academic_events"("createdAt");
