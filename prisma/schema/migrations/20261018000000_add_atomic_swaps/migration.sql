-- Atomic swaps table (#1087)
CREATE TABLE "atomic_swaps" (
    "id" TEXT NOT NULL,
    "swap_id" TEXT NOT NULL,
    "proposer" TEXT NOT NULL,
    "counterparty" TEXT NOT NULL,
    "offered_key" TEXT NOT NULL,
    "offered_amount" TEXT NOT NULL,
    "requested_key" TEXT NOT NULL,
    "requested_amount" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "proposed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "ledger" INTEGER NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "atomic_swaps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "atomic_swaps_swap_id_key" ON "atomic_swaps"("swap_id");

-- CreateIndex
CREATE INDEX "atomic_swaps_proposer_idx" ON "atomic_swaps"("proposer");

-- CreateIndex
CREATE INDEX "atomic_swaps_counterparty_idx" ON "atomic_swaps"("counterparty");

-- CreateIndex
CREATE INDEX "atomic_swaps_status_idx" ON "atomic_swaps"("status");

-- CreateIndex
CREATE INDEX "atomic_swaps_expires_at_idx" ON "atomic_swaps"("expires_at");

-- CreateIndex
CREATE INDEX "atomic_swaps_proposer_status_idx" ON "atomic_swaps"("proposer", "status");

-- CreateIndex
CREATE INDEX "atomic_swaps_counterparty_status_idx" ON "atomic_swaps"("counterparty", "status");
