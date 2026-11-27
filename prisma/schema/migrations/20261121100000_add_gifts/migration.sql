-- Migration safety: abort instead of queueing behind locks, and bound statement runtime
SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- CreateTable
CREATE TABLE "Gift" (
    "id" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "sender" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "message" VARCHAR(140) NOT NULL DEFAULT '',
    "seenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Gift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Gift_txHash_key" ON "Gift"("txHash");

-- CreateIndex
CREATE INDEX "Gift_recipient_seenAt_idx" ON "Gift"("recipient", "seenAt");

-- CreateIndex
CREATE INDEX "Gift_sender_idx" ON "Gift"("sender");
