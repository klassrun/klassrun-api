// ─────────────────────────────────────────────────────────────────────────────
//  SCHEMA ADDITIONS — apply these changes to klassrun-api/prisma/schema.prisma
// ─────────────────────────────────────────────────────────────────────────────
//
// What you're adding:
//   1. User.inviteExpiresAt    → expiry timestamp for invite links (7 days)
//   2. AuthEvent model          → audit log for security-sensitive events
//
// HOW TO APPLY:
//   1. Open prisma/schema.prisma
//   2. Add the new field to the User model (see "USER MODEL DIFF" below)
//   3. Append the AuthEvent model + AuthEventType enum at the bottom
//   4. Run: npx prisma migrate dev --name add-invite-expiry-and-auth-events
//
//
// ── USER MODEL DIFF ─────────────────────────────────────────────────────────
//
// In the User model, add this field next to inviteToken and inviteAccepted:
//
//     inviteExpiresAt DateTime?     // when the invite token stops working
//
// And add a relation back to AuthEvent (optional but useful):
//
//     authEvents      AuthEvent[]
//
//
// ── APPEND TO THE BOTTOM OF schema.prisma ───────────────────────────────────

enum AuthEventType {
  SIGNUP_SUCCESS
  LOGIN_SUCCESS
  LOGIN_FAILED
  INVITE_SENT
  INVITE_ACCEPTED
  INVITE_FAILED          // wrong email, expired, already accepted, etc.
  INVITE_RESENT
  PASSWORD_RESET_REQUESTED
  PASSWORD_RESET_COMPLETED
  SUPER_ADMIN_SEEDED
}

// AuthEvent — append-only audit log for security-sensitive events.
// Every signup, login attempt, invite, etc. logs a row here. We never
// update or delete these rows; they exist to answer "who did what when?"
// during investigations.
model AuthEvent {
  id          String        @id @default(uuid())
  type        AuthEventType
  email       String?       // for failed logins, may not match a user
  ipAddress   String?
  userAgent   String?
  metadata    Json?         // freeform context (school slug, target email, etc.)
  createdAt   DateTime      @default(now())

  // Optional relations — null when event isn't tied to a specific user/school yet
  userId      String?
  user        User?         @relation(fields: [userId], references: [id], onDelete: SetNull)
  schoolId    String?

  @@index([type])
  @@index([email])
  @@index([userId])
  @@index([createdAt])
  @@map("auth_events")
}
