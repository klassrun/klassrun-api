-- rc-next-term-v1: "Next term begins" date per term, printed on report cards.
ALTER TABLE "academic_sessions" ADD COLUMN IF NOT EXISTS "nextTermBeginsByTerm" JSONB;
