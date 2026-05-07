-- Migration: Add password reset and revoke functionality
-- Date: 2026-05-07
-- 
-- Apply via Prisma:
--   npx prisma migrate dev --name add-password-reset-and-revoke
--
-- Or apply directly via psql if Prisma migration fails:
--   psql $DATABASE_URL -f migration.sql

-- ── Add columns to users table ──────────────────────────────────────────────

ALTER TABLE "users" 
  ADD COLUMN IF NOT EXISTS "revokedAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lockedUntil"      TIMESTAMP(3);

-- ── Add new AuthEventType enum values ───────────────────────────────────────
-- (Postgres requires us to add enum values one-by-one)

DO $$ BEGIN
  ALTER TYPE "AuthEventType" ADD VALUE IF NOT EXISTS 'PASSWORD_RESET_FAILED';
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TYPE "AuthEventType" ADD VALUE IF NOT EXISTS 'TEACHER_REVOKED';
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TYPE "AuthEventType" ADD VALUE IF NOT EXISTS 'TEACHER_REINSTATED';
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TYPE "AuthEventType" ADD VALUE IF NOT EXISTS 'TEACHER_PASSWORD_RESET';
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TYPE "AuthEventType" ADD VALUE IF NOT EXISTS 'ACCOUNT_LOCKED';
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ── Create password_reset_tokens table ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id"          TEXT NOT NULL,
  "tokenHash"   TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  "usedAt"      TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress"   TEXT,
  "userAgent"   TEXT,
  CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_tokenHash_key" 
  ON "password_reset_tokens"("tokenHash");

CREATE INDEX IF NOT EXISTS "password_reset_tokens_userId_idx" 
  ON "password_reset_tokens"("userId");

CREATE INDEX IF NOT EXISTS "password_reset_tokens_expiresAt_idx" 
  ON "password_reset_tokens"("expiresAt");

ALTER TABLE "password_reset_tokens" 
  ADD CONSTRAINT "password_reset_tokens_userId_fkey" 
  FOREIGN KEY ("userId") REFERENCES "users"("id") 
  ON DELETE CASCADE ON UPDATE CASCADE;
