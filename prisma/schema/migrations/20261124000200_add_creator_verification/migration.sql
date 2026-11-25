-- AlterTable
ALTER TABLE "CreatorProfile" ADD COLUMN "verifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "verification_applications" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "legalNameHash" TEXT NOT NULL,
    "proofCode" TEXT NOT NULL,
    "reviewerId" TEXT,
    "decisionNote" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_proofs" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failureReason" TEXT,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_decisions" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "verification_applications_proofCode_key" ON "verification_applications"("proofCode");

-- CreateIndex
CREATE INDEX "verification_applications_status_submittedAt_idx" ON "verification_applications"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "verification_applications_creatorId_createdAt_idx" ON "verification_applications"("creatorId", "createdAt");

-- CreateIndex
CREATE INDEX "verification_proofs_applicationId_idx" ON "verification_proofs"("applicationId");

-- CreateIndex
CREATE INDEX "verification_decisions_applicationId_createdAt_idx" ON "verification_decisions"("applicationId", "createdAt");

-- AddForeignKey
ALTER TABLE "verification_applications" ADD CONSTRAINT "verification_applications_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_proofs" ADD CONSTRAINT "verification_proofs_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "verification_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_decisions" ADD CONSTRAINT "verification_decisions_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "verification_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
