-- perf-4: hot-path indexes
CREATE INDEX IF NOT EXISTS "lesson_notes_schoolId_teacherId_deletedAt_idx"
  ON "lesson_notes"("schoolId", "teacherId", "deletedAt");

CREATE INDEX IF NOT EXISTS "users_schoolId_role_revokedAt_idx"
  ON "users"("schoolId", "role", "revokedAt");
