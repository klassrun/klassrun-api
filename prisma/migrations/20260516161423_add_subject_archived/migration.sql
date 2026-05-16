-- Batch 2C Phase 3a — add archive + updatedAt to subjects, extend AcademicEventType enum

-- Add archivedAt (nullable)
ALTER TABLE "subjects" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Add updatedAt (NOT NULL with default, then backfill from createdAt)
ALTER TABLE "subjects" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "subjects" SET "updatedAt" = "createdAt";

-- Compound index for fast active-list filtering
CREATE INDEX "subjects_schoolId_archivedAt_idx" ON "subjects"("schoolId", "archivedAt");

-- Extend AcademicEventType enum
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'SUBJECT_CREATED';
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'SUBJECT_UPDATED';
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'SUBJECT_ARCHIVED';
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'SUBJECT_RESTORED';
