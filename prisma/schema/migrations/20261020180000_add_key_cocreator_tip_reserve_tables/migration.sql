-- Co-creator roster (#1139), tip history (#1132) and reserve balances
-- (#1140). Hand-written (not generated): the repo's shadow-database replay
-- is broken for full-history generation (see docs/database-migrations.md).

-- CreateTable
CREATE TABLE "key_cocreators" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'co_creator',
    "shareBps" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "ledger" INTEGER,
    "eventIndex" INTEGER,
    "txHash" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_cocreators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_tips" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "tipper" TEXT NOT NULL,
    "amount" DECIMAL(20,7) NOT NULL,
    "messageHash" TEXT,
    "ledger" INTEGER,
    "txHash" TEXT,
    "eventIndex" INTEGER,
    "tippedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_tips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_tip_totals" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "total" DECIMAL(20,7) NOT NULL DEFAULT 0,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_tip_totals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_reserves" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "balance" DECIMAL(20,7) NOT NULL DEFAULT 0,
    "totalAccrued" DECIMAL(20,7) NOT NULL DEFAULT 0,
    "totalDeployed" DECIMAL(20,7) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_reserves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_reserve_events" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(20,7) NOT NULL,
    "ledger" INTEGER,
    "txHash" TEXT,
    "eventIndex" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_reserve_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "key_reserve_events_type_check" CHECK ("type" IN ('accrued', 'deployed')),
    CONSTRAINT "key_reserve_events_amount_check" CHECK ("amount" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "key_cocreators_keyId_wallet_key" ON "key_cocreators"("keyId", "wallet");

-- CreateIndex
CREATE INDEX "key_cocreators_keyId_active_idx" ON "key_cocreators"("keyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "key_tips_txHash_eventIndex_key" ON "key_tips"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "key_tips_keyId_tippedAt_idx" ON "key_tips"("keyId", "tippedAt");

-- CreateIndex
CREATE UNIQUE INDEX "key_tip_totals_keyId_key" ON "key_tip_totals"("keyId");

-- CreateIndex
CREATE UNIQUE INDEX "key_reserves_keyId_key" ON "key_reserves"("keyId");

-- CreateIndex
CREATE UNIQUE INDEX "key_reserve_events_txHash_eventIndex_key" ON "key_reserve_events"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "key_reserve_events_keyId_idx" ON "key_reserve_events"("keyId");
