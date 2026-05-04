/*
  Warnings:

  - A unique constraint covering the columns `[schoolId,fingerprint]` on the table `question_bank` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[slug]` on the table `schools` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[customDomain]` on the table `schools` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `fingerprint` to the `question_bank` table without a default value. This is not possible if the table is not empty.
  - Added the required column `slug` to the `schools` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "SchoolStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE 'PAST_DUE';

-- AlterTable
ALTER TABLE "assessments" ADD COLUMN     "usedQuestionIds" JSONB;

-- AlterTable
ALTER TABLE "question_bank" ADD COLUMN     "fingerprint" TEXT NOT NULL,
ADD COLUMN     "lastUsedAt" TIMESTAMP(3),
ADD COLUMN     "timesUsed" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "schools" ADD COLUMN     "customDomain" TEXT,
ADD COLUMN     "slug" TEXT NOT NULL,
ADD COLUMN     "slugLockedAt" TIMESTAMP(3),
ADD COLUMN     "status" "SchoolStatus" NOT NULL DEFAULT 'PROVISIONING';

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "schoolId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "reserved_slugs" (
    "slug" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reserved_slugs_pkey" PRIMARY KEY ("slug")
);

-- CreateIndex
CREATE INDEX "academic_sessions_schoolId_idx" ON "academic_sessions"("schoolId");

-- CreateIndex
CREATE INDEX "assessments_schoolId_idx" ON "assessments"("schoolId");

-- CreateIndex
CREATE INDEX "classes_schoolId_idx" ON "classes"("schoolId");

-- CreateIndex
CREATE INDEX "lesson_notes_schoolId_idx" ON "lesson_notes"("schoolId");

-- CreateIndex
CREATE INDEX "lesson_notes_schoolId_subjectId_classId_idx" ON "lesson_notes"("schoolId", "subjectId", "classId");

-- CreateIndex
CREATE INDEX "question_bank_schoolId_idx" ON "question_bank"("schoolId");

-- CreateIndex
CREATE INDEX "question_bank_schoolId_subjectId_topic_idx" ON "question_bank"("schoolId", "subjectId", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "question_bank_schoolId_fingerprint_key" ON "question_bank"("schoolId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "schools_slug_key" ON "schools"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "schools_customDomain_key" ON "schools"("customDomain");

-- CreateIndex
CREATE INDEX "schools_slug_idx" ON "schools"("slug");

-- CreateIndex
CREATE INDEX "schools_status_idx" ON "schools"("status");

-- CreateIndex
CREATE INDEX "subjects_schoolId_idx" ON "subjects"("schoolId");

-- CreateIndex
CREATE INDEX "users_schoolId_idx" ON "users"("schoolId");
