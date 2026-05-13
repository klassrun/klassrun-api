-- Backfill state for any existing schools missing it.
-- Phase 2 captures state at signup; this catches dev schools created earlier.
UPDATE "schools" SET state = 'Lagos' WHERE state IS NULL;
