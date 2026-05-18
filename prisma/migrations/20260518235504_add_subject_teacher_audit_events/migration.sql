-- Batch 2C Phase 3b — Add teacher assignment audit event values
-- Idempotent at the Postgres level (ADD VALUE IF NOT EXISTS)

ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'SUBJECT_TEACHER_ASSIGNED';
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'SUBJECT_TEACHER_UNASSIGNED';
