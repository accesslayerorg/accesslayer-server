-- CreateTable
CREATE TABLE "treasury_balance" (
    "source" TEXT NOT NULL,
    "balance" DECIMAL(40,0) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treasury_balance_pkey" PRIMARY KEY ("source")
);

-- CreateTable
CREATE TABLE "treasury_inflows" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "amount" DECIMAL(40,0) NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "ledger" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasury_inflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_allocations" (
    "id" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "amount" DECIMAL(40,0) NOT NULL,
    "purpose" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "ledger" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "treasury_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_early_slot_events" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "slotsTotal" INTEGER NOT NULL,
    "bonusBps" INTEGER NOT NULL,
    "investor" TEXT,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "ledger" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_early_slot_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issuer_verification_events" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "tier" TEXT,
    "expiresAt" TIMESTAMP(3),
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "ledger" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issuer_verification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issuer_verification" (
    "wallet" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "tier" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastLedger" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issuer_verification_pkey" PRIMARY KEY ("wallet")
);

-- CreateIndex
CREATE UNIQUE INDEX "treasury_inflows_txHash_eventIndex_key" ON "treasury_inflows"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "treasury_inflows_source_occurredAt_idx" ON "treasury_inflows"("source", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "treasury_inflows_occurredAt_idx" ON "treasury_inflows"("occurredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "treasury_allocations_txHash_eventIndex_key" ON "treasury_allocations"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "treasury_allocations_occurredAt_idx" ON "treasury_allocations"("occurredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_early_slot_events_txHash_eventIndex_key" ON "invoice_early_slot_events"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "invoice_early_slot_events_invoiceId_ledger_eventIndex_idx" ON "invoice_early_slot_events"("invoiceId", "ledger" DESC, "eventIndex" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "issuer_verification_events_txHash_eventIndex_key" ON "issuer_verification_events"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "issuer_verification_events_wallet_occurredAt_idx" ON "issuer_verification_events"("wallet", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "issuer_verification_isVerified_expiresAt_idx" ON "issuer_verification"("isVerified", "expiresAt");
