-- grading-config-v1: per-school score breakdown, frozen per term.
-- Applied by hand in the Neon SQL Editor (MTN blocks 5432). Additive only.
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "gradingConfig" JSONB;
ALTER TABLE "academic_sessions" ADD COLUMN IF NOT EXISTS "gradingConfigByTerm" JSONB;
ALTER TABLE "result_entries" ADD COLUMN IF NOT EXISTS "score5" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "result_entries" ADD COLUMN IF NOT EXISTS "score6" INTEGER NOT NULL DEFAULT 0;
