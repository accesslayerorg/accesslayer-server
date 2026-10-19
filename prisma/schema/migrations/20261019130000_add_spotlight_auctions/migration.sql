-- CreateTable
CREATE TABLE "spotlight_auctions" (
    "id" TEXT NOT NULL,
    "slot_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "bidder" TEXT,
    "bid_amount" TEXT,
    "is_winning" BOOLEAN NOT NULL DEFAULT false,
    "starts_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "ledger" INTEGER NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "event_index" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spotlight_auctions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spotlight_auctions_tx_hash_event_index_key" ON "spotlight_auctions"("tx_hash", "event_index");

-- CreateIndex
CREATE INDEX "spotlight_auctions_slot_id_event_type_idx" ON "spotlight_auctions"("slot_id", "event_type");

-- CreateIndex
CREATE INDEX "spotlight_auctions_key_id_is_winning_idx" ON "spotlight_auctions"("key_id", "is_winning");

-- CreateIndex
CREATE INDEX "spotlight_auctions_expires_at_idx" ON "spotlight_auctions"("expires_at");

-- CreateIndex
CREATE INDEX "spotlight_auctions_ledger_idx" ON "spotlight_auctions"("ledger");
