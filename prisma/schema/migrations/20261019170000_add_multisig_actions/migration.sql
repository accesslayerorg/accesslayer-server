-- CreateTable
CREATE TABLE "multisig_actions" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "description" TEXT,
    "target" TEXT,
    "functionName" TEXT,
    "params" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "threshold" INTEGER NOT NULL DEFAULT 2,
    "totalSigners" INTEGER NOT NULL DEFAULT 3,
    "proposedBy" TEXT NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "outcome" TEXT,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "multisig_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signatures" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "signer" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signatures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "multisig_actions_actionId_key" ON "multisig_actions"("actionId");

-- CreateIndex
CREATE INDEX "multisig_actions_status_idx" ON "multisig_actions"("status");

-- CreateIndex
CREATE INDEX "multisig_actions_proposedBy_idx" ON "multisig_actions"("proposedBy");

-- CreateIndex
CREATE UNIQUE INDEX "signatures_actionId_signer_key" ON "signatures"("actionId", "signer");

-- CreateIndex
CREATE INDEX "signatures_signer_idx" ON "signatures"("signer");

-- AddForeignKey
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "multisig_actions"("actionId") ON DELETE CASCADE ON UPDATE CASCADE;
