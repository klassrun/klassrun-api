-- Operations 2a — Attendance + Behaviour + Report-card comments
-- AlterEnum
ALTER TYPE "AcademicEventType" ADD VALUE 'ATTENDANCE_RECORDED';
ALTER TYPE "AcademicEventType" ADD VALUE 'BEHAVIOUR_RECORDED';
ALTER TYPE "AcademicEventType" ADD VALUE 'REPORT_CARD_COMMENT_GENERATED';
ALTER TYPE "AcademicEventType" ADD VALUE 'REPORT_CARD_COMMENT_EDITED';

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" TEXT NOT NULL,
    "term" "SessionTerm" NOT NULL,
    "schoolOpened" INTEGER NOT NULL DEFAULT 0,
    "present" INTEGER NOT NULL DEFAULT 0,
    "absent" INTEGER NOT NULL DEFAULT 0,
    "schoolId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "enteredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "behaviour_records" (
    "id" TEXT NOT NULL,
    "term" "SessionTerm" NOT NULL,
    "ratings" JSONB NOT NULL,
    "schoolId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "enteredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "behaviour_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_card_comments" (
    "id" TEXT NOT NULL,
    "term" "SessionTerm" NOT NULL,
    "classTeacher" TEXT,
    "principal" TEXT,
    "source" TEXT NOT NULL DEFAULT 'ai',
    "aiModel" TEXT,
    "aiGeneratedAt" TIMESTAMP(3),
    "schoolId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "generatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "report_card_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_studentId_sessionId_term_key" ON "attendance_records"("studentId", "sessionId", "term");
CREATE INDEX "attendance_records_schoolId_idx" ON "attendance_records"("schoolId");
CREATE INDEX "attendance_records_schoolId_sessionId_term_idx" ON "attendance_records"("schoolId", "sessionId", "term");

CREATE UNIQUE INDEX "behaviour_records_studentId_sessionId_term_key" ON "behaviour_records"("studentId", "sessionId", "term");
CREATE INDEX "behaviour_records_schoolId_idx" ON "behaviour_records"("schoolId");
CREATE INDEX "behaviour_records_schoolId_sessionId_term_idx" ON "behaviour_records"("schoolId", "sessionId", "term");

CREATE UNIQUE INDEX "report_card_comments_studentId_sessionId_term_key" ON "report_card_comments"("studentId", "sessionId", "term");
CREATE INDEX "report_card_comments_schoolId_idx" ON "report_card_comments"("schoolId");
CREATE INDEX "report_card_comments_schoolId_sessionId_term_idx" ON "report_card_comments"("schoolId", "sessionId", "term");

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "academic_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "behaviour_records" ADD CONSTRAINT "behaviour_records_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "behaviour_records" ADD CONSTRAINT "behaviour_records_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "behaviour_records" ADD CONSTRAINT "behaviour_records_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "academic_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "report_card_comments" ADD CONSTRAINT "report_card_comments_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_card_comments" ADD CONSTRAINT "report_card_comments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_card_comments" ADD CONSTRAINT "report_card_comments_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "academic_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
