// ─────────────────────────────────────────────────────────────────────────────
//  SCHEMA PATCH v3 — apply these changes to klassrun-api/prisma/schema.prisma
// ─────────────────────────────────────────────────────────────────────────────
//
// What this patch adds:
//
//   1. User.revokedAt        → DateTime when user was revoked (soft delete)
//   2. User.failedLoginCount → Counter for account lockout
//   3. User.lockedUntil      → Auto-locked until this time
//   4. New PasswordResetToken model
//   5. New AuthEventType enum values
//
// HOW TO APPLY (manual, before running the installer):
//
// Step 1: Open prisma/schema.prisma in your editor.
//
// Step 2: In the User model, add these three new fields next to the
//         existing inviteToken, inviteAccepted, etc:
//
//         revokedAt        DateTime?
//         failedLoginCount Int       @default(0)
//         lockedUntil      DateTime?
//         passwordResets   PasswordResetToken[]
//
// Step 3: In the AuthEventType enum, add these new values at the bottom:
//
//         PASSWORD_RESET_FAILED
//         TEACHER_REVOKED
//         TEACHER_REINSTATED
//         TEACHER_PASSWORD_RESET
//         ACCOUNT_LOCKED
//
// Step 4: Append the PasswordResetToken model at the bottom of the file:

model PasswordResetToken {
  id          String   @id @default(uuid())
  tokenHash   String   @unique          // SHA-256 hash of the actual token
  userId      String
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt   DateTime                  // 1 hour from creation
  usedAt      DateTime?                 // null until consumed; one-time use
  createdAt   DateTime @default(now())
  ipAddress   String?
  userAgent   String?

  @@index([userId])
  @@index([expiresAt])
  @@map("password_reset_tokens")
}

//
// Step 5: Run the migration (with .env pointing at LOCAL Postgres):
//
//         npx prisma migrate dev --name add-password-reset-and-revoke
//
// Step 6: When ready to apply to Neon, point .env at Neon DIRECT:
//
//         npx prisma migrate deploy
//
// ─────────────────────────────────────────────────────────────────────────────
