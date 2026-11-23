-- CreateEnum
CREATE TYPE "KeyReportReason" AS ENUM ('scam', 'impersonation', 'harassment', 'other');

-- CreateEnum
CREATE TYPE "KeyReportStatus" AS ENUM ('open', 'reviewing', 'dismissed', 'actioned');

-- CreateTable
CREATE TABLE "key_reports" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "reporter" TEXT NOT NULL,
    "reason" "KeyReportReason" NOT NULL,
    "details" VARCHAR(500),
    "status" "KeyReportStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "key_reports_reporter_idx" ON "key_reports"("reporter");

-- CreateIndex
CREATE INDEX "key_reports_keyId_reporter_status_idx" ON "key_reports"("keyId", "reporter", "status");

-- CreateIndex
CREATE INDEX "key_reports_status_createdAt_id_idx" ON "key_reports"("status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "key_reports_createdAt_id_idx" ON "key_reports"("createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "key_reports" ADD CONSTRAINT "key_reports_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

