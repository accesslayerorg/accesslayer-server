-- CreateTable
CREATE TABLE "key_retirement" (
    "id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "buyback_price" TEXT,
    "notice_expiry" TIMESTAMP(3),
    "reason" TEXT,
    "actor" TEXT,
    "ledger" INTEGER NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "event_index" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_retirement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "key_retirement_tx_hash_event_index_key" ON "key_retirement"("tx_hash", "event_index");

-- CreateIndex
CREATE INDEX "key_retirement_key_id_created_at_idx" ON "key_retirement"("key_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "key_retirement_ledger_idx" ON "key_retirement"("ledger");
