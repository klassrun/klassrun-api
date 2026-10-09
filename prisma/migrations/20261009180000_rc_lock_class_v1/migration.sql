-- rc-lock-class-v1: audit event for unlocking report cards.
ALTER TYPE "AcademicEventType" ADD VALUE IF NOT EXISTS 'REPORT_CARD_UNLOCKED';
