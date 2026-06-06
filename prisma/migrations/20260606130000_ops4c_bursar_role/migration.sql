-- ops-4c-bursar-role
-- Adds the BURSAR value to the Role enum.
-- NOTE: Postgres cannot use a newly-added enum value in the same transaction
-- it is added in. This migration only ADDS the value; the first row using it
-- is created later via the invite API, in a separate transaction.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'BURSAR';
