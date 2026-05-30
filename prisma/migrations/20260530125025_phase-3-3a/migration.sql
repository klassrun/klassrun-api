-- Batch 3 Phase 3a: Assessment soft-delete + new AcademicEventType values
-- batch-3-phase-3a-migration

-- Add deletedAt column to assessments
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

-- Add compound index for soft-delete queries
CREATE INDEX IF NOT EXISTS "assessments_schoolId_deletedAt_idx" ON assessments("schoolId", "deletedAt");

-- Add new AcademicEventType enum values (idempotent in Postgres)
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'QUESTION_GENERATED';
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'ASSESSMENT_EDITED';
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'ASSESSMENT_DISCARDED';
