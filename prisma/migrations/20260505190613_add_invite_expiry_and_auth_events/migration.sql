-- CreateEnum
CREATE TYPE "AuthEventType" AS ENUM ('SIGNUP_SUCCESS', 'LOGIN_SUCCESS', 'LOGIN_FAILED', 'INVITE_SENT', 'INVITE_ACCEPTED', 'INVITE_FAILED', 'INVITE_RESENT', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED', 'SUPER_ADMIN_SEEDED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "inviteExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "auth_events" (
    "id" TEXT NOT NULL,
    "type" "AuthEventType" NOT NULL,
    "email" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "schoolId" TEXT,

    CONSTRAINT "auth_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_events_type_idx" ON "auth_events"("type");

-- CreateIndex
CREATE INDEX "auth_events_email_idx" ON "auth_events"("email");

-- CreateIndex
CREATE INDEX "auth_events_userId_idx" ON "auth_events"("userId");

-- CreateIndex
CREATE INDEX "auth_events_createdAt_idx" ON "auth_events"("createdAt");

-- AddForeignKey
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
