-- Batch 2C Phase 2 — Classes archive support
-- batch-2c-phase-2-class-archive

-- Add archivedAt (nullable, no backfill needed)
ALTER TABLE "classes" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Add updatedAt with backfill from createdAt (existing rows)
ALTER TABLE "classes" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "classes" SET "updatedAt" = "createdAt";

-- Compound index to keep the active-classes list fast
CREATE INDEX "classes_schoolId_archivedAt_idx" ON "classes"("schoolId", "archivedAt");

-- Extend AcademicEventType enum (Postgres ALTER TYPE is non-destructive)
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'CLASS_CREATED';
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'CLASS_UPDATED';
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'CLASS_ARCHIVED';
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'CLASS_RESTORED';
