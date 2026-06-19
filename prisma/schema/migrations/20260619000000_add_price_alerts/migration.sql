-- CreateEnum
CREATE TYPE "AlertDirection" AS ENUM ('ABOVE', 'BELOW');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('PENDING', 'TRIGGERED', 'FAILED');

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "targetPrice" DECIMAL(38,18) NOT NULL,
    "direction" "AlertDirection" NOT NULL,
    "callbackUrl" TEXT NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'PENDING',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "triggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Alert_creatorId_idx" ON "Alert"("creatorId");

-- CreateIndex
CREATE INDEX "Alert_status_idx" ON "Alert"("status");
