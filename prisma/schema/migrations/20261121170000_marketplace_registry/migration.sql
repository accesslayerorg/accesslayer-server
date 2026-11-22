CREATE TABLE "approved_marketplaces" (
    "address" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "ledger" INTEGER NOT NULL DEFAULT -1,
    "transactionIndex" INTEGER,
    "eventIndex" INTEGER NOT NULL DEFAULT -1,
    "txHash" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "approved_marketplaces_pkey" PRIMARY KEY ("address")
);

CREATE TABLE "key_royalty_enforcement" (
    "keyId" TEXT NOT NULL,
    "royaltyEnforced" BOOLEAN NOT NULL DEFAULT false,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "ledger" INTEGER NOT NULL DEFAULT -1,
    "transactionIndex" INTEGER,
    "eventIndex" INTEGER NOT NULL DEFAULT -1,
    "txHash" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "key_royalty_enforcement_pkey" PRIMARY KEY ("keyId")
);

CREATE TABLE "marketplace_registry_events" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "transactionIndex" INTEGER,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    CONSTRAINT "marketplace_registry_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "approved_marketplaces_approved_approvedAt_idx" ON "approved_marketplaces"("approved", "approvedAt");
CREATE UNIQUE INDEX "marketplace_registry_events_txHash_eventIndex_key" ON "marketplace_registry_events"("txHash", "eventIndex");
