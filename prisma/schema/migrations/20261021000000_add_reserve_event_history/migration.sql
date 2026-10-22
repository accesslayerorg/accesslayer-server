CREATE TABLE "ReserveEvent" (
  "id" TEXT NOT NULL,
  "asset" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "amount" DECIMAL(30,7) NOT NULL,
  "reserveBalance" DECIMAL(30,7),
  "actor" TEXT,
  "txHash" TEXT NOT NULL,
  "eventIndex" INTEGER NOT NULL,
  "ledger" INTEGER NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReserveEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReserveEvent_txHash_eventIndex_key" ON "ReserveEvent"("txHash", "eventIndex");
CREATE INDEX "ReserveEvent_asset_occurredAt_idx" ON "ReserveEvent"("asset", "occurredAt" DESC);
