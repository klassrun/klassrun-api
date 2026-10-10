-- term-back-v1: audit event for moving the current term back.
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'TERM_REVERTED';
